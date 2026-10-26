/**
 * Enforcement of the mechanism wiki rules on a generation.
 *
 * The generation prompt of a mechanism wiki asks the model for a `domain` on
 * every page and for mechanism pages only in a reading wiki. A model does not
 * always follow it. `enforceMechanismRules` reads the FILE blocks of the
 * generation before they are written and fixes what it can:
 *
 * 1. A mechanism page has no `domain` and no `also`, and has `lenses` and `instances`.
 * 2. Every other page under `wiki/` has a `domain`, except `index.md`, `log.md`, `overview.md`, and
 *    hypothesis pages, which carry `from_domain` and `to_domain` instead.
 * 3. A wiki that cannot write mechanism pages gets no mechanism page. Each page becomes a
 *    `new-mechanism` review item, and so does each `new-mechanism` REVIEW block of the model.
 *    A `new-domain` REVIEW block of the model becomes a `new-domain` review item when its body
 *    holds a usable `PROPOSAL:` line, and is dropped with a note otherwise.
 * 4. A domain that the analysis proposes becomes a `new-domain` review item. That review comes
 *    from `proposedDomainReview`, which the caller calls once per ingest, not once per pass.
 * 5. A page whose path exists already with another domain gets a suffixed path (spec 5.5), so the same
 *    slug in two domains stays two pages. This needs the map of existing pages; without it nothing is renamed.
 *
 * A mechanism page is a page under `wiki/mechanisms/` or a page with `type: mechanism`: the
 * writer moves a typed page to the folder of its type after these rules ran. A hypothesis page is
 * a page under `wiki/hypotheses/` or a page with `type: hypothesis`.
 *
 * Only the frontmatter keys that a rule names change. Every other byte of the
 * text stays: a block that needs no change is returned as it came, and so is
 * the text between the blocks, except for the `new-mechanism` REVIEW blocks.
 * The caller calls this only for a mechanism wiki.
 */
import { parseFrontmatter } from "@/lib/frontmatter"
import { CLOSER_LINE, OPENER_LINE, parseFileBlocks, REVIEW_BLOCK_REGEX } from "@/lib/ingest"
import type { ParsedFileBlock } from "@/lib/ingest"
import { sanitizeIngestedFileContent } from "@/lib/ingest-sanitize"
import { normalizePath } from "@/lib/path-utils"
import type { ReviewItem } from "@/stores/review-store"
import { DOMAIN_NAME_PATTERN } from "@/lib/wiki-config/domains"
import { hasOwn } from "@/lib/wiki-config/yaml-util"
import { canWriteMechanismPages, lensForDomain } from "./context"
import type { MechanismContext } from "./context"
import { knownLenses } from "./decisions"
import { APP_OWN_PAGES } from "./domain-index-render"
import type { AnalysisDecisions } from "./types"

type NewReview = Omit<ReviewItem, "id" | "resolved" | "createdAt">

export interface EnforceResult {
  /** The generation with the rules applied. Blocks and text keep their order. */
  text: string
  /** Review items to add after a successful ingest. */
  reviews: NewReview[]
  /** One short English line for each change, for the activity log. */
  notes: string[]
  /** FILE blocks that got another path because the same slug exists in another domain. */
  renames: Array<{ from: string; to: string }>
}

const MECHANISM_DIR = "wiki/mechanisms/"
const HYPOTHESIS_DIR = "wiki/hypotheses/"
const SOURCES_DIR = "wiki/sources/"
/** How many lines from the top `declaredType` reads when the frontmatter does not parse. */
const TYPE_LINE_WINDOW = 30

/**
 * What to write for a FILE block: the block as it is, other content and/or another path, or nothing.
 * An edit without `content` keeps the lines of the block as they are.
 */
type BlockOutcome = { kind: "keep" } | { kind: "edit"; content?: string; path?: string } | { kind: "drop" }

const KEEP: BlockOutcome = { kind: "keep" }

const PROPOSE_MECHANISM_OPTIONS = [
  { label: "Write to reading wiki", action: "mech:propose-mechanism" },
  { label: "Skip", action: "Skip" },
]

/**
 * `existingPages` maps the path of each page of the wiki to its domain (null when it has none). With
 * it, a page that would overwrite a page of another domain is renamed. The caller builds it once from
 * the pages on disk; chat ingest passes none.
 */
export function enforceMechanismRules(
  generation: string,
  ctx: MechanismContext,
  decisions: AnalysisDecisions,
  sourcePath: string,
  existingPages?: ReadonlyMap<string, string | null>,
): EnforceResult {
  const rules = new Rules(ctx, decisions, sourcePath, existingPages)
  const { blocks, truncatedPaths } = parseFileBlocks(generation)
  const lines = generation.split("\n")
  const out: string[] = []
  let cursor = 0

  for (const block of blocks) {
    const span = locateBlock(lines, cursor, block)
    // The block came from this very text, so it is there. Stop rather than write unchecked pages.
    if (span === null) throw new Error(`Mechanism rules: cannot find the FILE block "${block.path}" in the generation`)
    out.push(...rules.takeReviewBlocks(lines.slice(cursor, span.open)))

    const outcome = rules.enforceBlock(block)
    if (outcome.kind === "keep") {
      out.push(...lines.slice(span.open, span.close + 1))
    } else if (outcome.kind === "edit") {
      out.push(
        outcome.path === undefined ? lines[span.open] : openerFor(outcome.path, lines[span.open]),
        ...(outcome.content === undefined ? lines.slice(span.open + 1, span.close) : outcome.content.split("\n")),
        lines[span.close],
      )
    }
    cursor = span.close + 1
  }

  // A wiki that cannot write mechanism pages must not repair an unfinished mechanism block either.
  // The partial page cannot be proposed whole, so it goes to review as it is.
  let tailEnd = lines.length
  for (let i = cursor; i < lines.length && !rules.canWrite && truncatedPaths.length > 0; i++) {
    const opener = OPENER_LINE.exec(withoutCarriageReturn(lines[i]))
    if (opener === null || !truncatedPaths.includes(opener[1].trim())) continue
    const path = opener[1].trim()
    const partial = lines.slice(i + 1).map(withoutCarriageReturn).join("\n")
    if (isMechanismPage(path, partial)) {
      rules.proposeMechanism({ path, content: partial }, "(incomplete) ")
      rules.notes.push(`Dropped the unfinished block ${normalizePath(path)}`)
      tailEnd = i
    }
    break
  }
  out.push(...rules.takeReviewBlocks(lines.slice(cursor, tailEnd)))

  return { text: out.join("\n"), reviews: rules.reviews, notes: rules.notes, renames: rules.renames }
}

/** The opener line of a block at `path`. A carriage return at the end of `previous` stays. */
function openerFor(path: string, previous: string): string {
  return `---FILE: ${path}---${previous.endsWith("\r") ? "\r" : ""}`
}

// --- the rules ---------------------------------------------------------

class Rules {
  readonly canWrite: boolean
  readonly reviews: NewReview[] = []
  readonly notes: string[] = []
  readonly renames: Array<{ from: string; to: string }> = []
  /** The domain that pages without one get. */
  private readonly domain: string | null
  private readonly lenses: string[]
  /** Domains that a `new-domain` review already asks for: the proposal of the analysis, then each block taken. */
  private readonly proposedDomains: Set<string>
  /** Existing pages by lower-case path: file systems differ in case, a wiki must not depend on it. */
  private readonly existing: ReadonlyMap<string, string | null>

  constructor(
    private readonly ctx: MechanismContext,
    decisions: AnalysisDecisions,
    private readonly sourcePath: string,
    existingPages: ReadonlyMap<string, string | null> = new Map(),
  ) {
    this.canWrite = canWriteMechanismPages(ctx)
    this.domain = decisions.domain ?? decisions.proposedDomain?.path ?? null
    this.lenses = defaultLenses(ctx, decisions)
    this.proposedDomains = new Set(decisions.proposedDomain === null ? [] : [decisions.proposedDomain.path])
    this.existing = new Map([...existingPages].map(([path, domain]) => [normalizePath(path).toLowerCase(), domain]))
  }

  enforceBlock(block: ParsedFileBlock): BlockOutcome {
    const path = normalizePath(block.path)
    const lower = path.toLowerCase()
    if (isMechanismPage(path, block.content)) {
      if (this.canWrite) return this.fixMechanismPage(path, block.content)
      this.proposeMechanism(block)
      return { kind: "drop" }
    }
    if (!lower.startsWith("wiki/") || !lower.endsWith(".md") || APP_OWN_PAGES.has(lower)) return KEEP
    if (lower.startsWith(HYPOTHESIS_DIR) || declaredType(block.content) === "hypothesis") return KEEP
    return this.keepDomainsApart(path, block.content, this.fixDomain(path, block.content))
  }

  /** Rule 1. */
  private fixMechanismPage(path: string, content: string): BlockOutcome {
    const edited = editFrontmatter(content, (fm) => {
      const removed: string[] = []
      for (const key of ["domain", "also"]) {
        if (removeKey(fm, key)) removed.push(key)
      }
      const added: string[] = []
      if (findKey(fm, "lenses") === -1) {
        fm.push(`lenses: ${inlineList(this.lenses)}`)
        added.push("lenses")
      }
      if (findKey(fm, "instances") === -1) {
        fm.push("instances: []")
        added.push("instances")
      }
      if (removed.length > 0) this.notes.push(`Removed ${removed.join(" and ")} from ${path}`)
      if (added.length > 0) this.notes.push(`Added ${added.join(" and ")} to ${path}`)
      return removed.length + added.length > 0
    })
    if (edited === null) {
      this.notes.push(`Could not fix lenses and instances of ${path}: the page has no frontmatter`)
      return KEEP
    }
    return edited.changed ? { kind: "edit", content: edited.content } : KEEP
  }

  /** Rule 2. */
  private fixDomain(path: string, content: string): BlockOutcome {
    const target = this.domain
    if (target === null) return KEEP
    const edited = editFrontmatter(content, (fm) => {
      const at = findKey(fm, "domain")
      if (at === -1) {
        fm.push(`domain: ${target}`)
        this.notes.push(`Added domain "${target}" to ${path}`)
        return true
      }
      const current = scalarValue(fm, at)
      const missing = current === "" || current === "null" || current === "~"
      if (!missing && (current === target || hasOwn(this.ctx.domains.domains, current))) return false
      fm.splice(at, keyBlockEnd(fm, at) - at, `domain: ${target}`)
      this.notes.push(
        missing
          ? `Added domain "${target}" to ${path}`
          : `Replaced domain "${current}" with "${target}" on ${path}`,
      )
      return true
    })
    if (edited === null) {
      this.notes.push(`Could not add domain to ${path}: the page has no frontmatter`)
      return KEEP
    }
    return edited.changed ? { kind: "edit", content: edited.content } : KEEP
  }

  /**
   * Rule 5. A page whose path exists with another domain than the page will have is a different page
   * of the same slug: it goes to `<dir>/<slug>--<last segment of the domain>.md`. When that path holds
   * a third domain, the whole domain path is used, with `--` for each `/`. A page of the same domain
   * keeps its path, and so does a page that has no domain. The source summary page keeps its path too:
   * ingest writes it at one fixed path. Links in other pages are not rewritten.
   */
  private keepDomainsApart(path: string, original: string, outcome: BlockOutcome): BlockOutcome {
    if (this.existing.size === 0 || path.toLowerCase().startsWith(SOURCES_DIR)) return outcome
    const domain = frontmatterDomain(outcome.kind === "edit" && outcome.content !== undefined ? outcome.content : original)
    const held = this.existing.get(path.toLowerCase()) ?? null
    if (domain === null || held === null || held === domain) return outcome

    const stem = path.slice(0, -".md".length)
    const short = `${stem}--${domain.split("/").pop()}.md`
    const target = this.holdsOtherDomain(short, domain) ? `${stem}--${domain.replace(/\//g, "--")}.md` : short
    this.renames.push({ from: path, to: target })
    this.notes.push(
      `Renamed ${path} to ${target}: the page exists in domain "${held}". Links in other pages are not rewritten.`,
    )
    return { kind: "edit", content: outcome.kind === "edit" ? outcome.content : undefined, path: target }
  }

  /** True when a page of another domain than `domain` is at `path`. */
  private holdsOtherDomain(path: string, domain: string): boolean {
    const held = this.existing.get(path.toLowerCase()) ?? null
    return held !== null && held !== domain
  }

  /** Rule 3, for a FILE block. `titlePrefix` marks a page that the model did not finish. */
  proposeMechanism(block: ParsedFileBlock, titlePrefix = ""): void {
    const title = parseFrontmatter(block.content).frontmatter?.title
    this.reviews.push({
      type: "new-mechanism",
      title: titlePrefix + (typeof title === "string" && title.trim() !== "" ? title.trim() : fileStem(block.path)),
      description: block.content,
      sourcePath: this.sourcePath,
      affectedPages: [block.path],
      options: PROPOSE_MECHANISM_OPTIONS,
    })
    this.notes.push(`Moved ${normalizePath(block.path)} to a new-mechanism review item`)
  }

  /**
   * Rule 3, for REVIEW blocks. Takes the `new-mechanism` and `new-domain` REVIEW blocks out of
   * text between FILE blocks and returns the other lines. The upstream parser
   * would read an unknown type as `confirm` and lose the action.
   */
  takeReviewBlocks(segment: string[]): string[] {
    if (segment.length === 0) return segment
    const text = segment.join("\n")
    let kept = ""
    let from = 0
    let changed = false
    for (const match of text.matchAll(new RegExp(REVIEW_BLOCK_REGEX.source, REVIEW_BLOCK_REGEX.flags))) {
      const type = match[1].trim().toLowerCase()
      if (type !== "new-mechanism" && type !== "new-domain") continue
      if (type === "new-mechanism") this.proposeMechanismFromReview(match[2].trim(), match[3].trim())
      else this.proposeDomainFromReview(match[2].trim(), match[3].trim())
      // Take the line break after the block, or the one before it when the block ends the text.
      let start = match.index
      let end = start + match[0].length
      if (text[end] === "\n") end += 1
      else if (start > 0 && text[start - 1] === "\n") start -= 1
      kept += text.slice(from, Math.max(from, start))
      from = Math.max(from, end)
      changed = true
    }
    if (!changed) return segment
    kept += text.slice(from)
    if (kept.endsWith("\n") && !text.endsWith("\n")) kept = kept.slice(0, -1)
    return kept === "" ? [] : kept.split("\n")
  }

  /**
   * A `new-domain` REVIEW block of the model. The app asks for the approval of a domain with a
   * `PROPOSAL: <path> | <lens> | <description>` line, so the block is kept only when it has a
   * usable one. A block for a domain that is listed or already asked for is dropped as well.
   */
  private proposeDomainFromReview(title: string, body: string): void {
    const drop = (reason: string): void => {
      this.notes.push(`Dropped the new-domain review "${title}": ${reason}`)
    }
    const line = /^PROPOSAL:[ \t]*(.*)$/m.exec(body)
    const parts = line === null ? [] : line[1].split("|")
    const path = (parts[0] ?? "").trim()
    const lens = (parts[1] ?? "").trim()
    const description = oneLine(parts.slice(2).join("|"))
    if (parts.length < 3 || description === "") return drop('it has no "PROPOSAL: <path> | <lens> | <description>" line')
    if (!DOMAIN_NAME_PATTERN.test(path)) return drop(`"${path}" is not a valid domain path`)
    if (!knownLenses(this.ctx).includes(lens)) return drop(`"${lens}" is not a known lens`)
    if (hasOwn(this.ctx.domains.domains, path)) return drop(`"${path}" is already listed in domains.yaml`)
    if (this.proposedDomains.has(path)) return drop(`"${path}" is already proposed`)

    this.proposedDomains.add(path)
    const review = proposedDomainReview(
      { domain: null, proposedDomain: { path, lens, description }, mechanisms: [], problems: [] },
      this.sourcePath,
    )
    if (review !== null) this.reviews.push(review)
    this.notes.push(`Moved the new-domain review "${title}" to the review queue`)
  }

  private proposeMechanismFromReview(title: string, body: string): void {
    const pages = body.match(/^PAGES:\s*(.+)$/m)
    this.reviews.push({
      type: "new-mechanism",
      title,
      description: body.replace(/^OPTIONS:.*$/m, "").replace(/^PAGES:.*$/m, "").trim(),
      sourcePath: this.sourcePath,
      affectedPages: pages ? pages[1].split(",").map((page) => page.trim()) : undefined,
      options: PROPOSE_MECHANISM_OPTIONS,
    })
    this.notes.push(`Moved the new-mechanism review "${title}" to the review queue`)
  }
}

/**
 * The `new-domain` review for the domain that the analysis proposes, or null when it proposes none.
 * The caller adds it once per ingest, whatever the number of passes over the generated text.
 */
export function proposedDomainReview(decisions: AnalysisDecisions, sourcePath: string): NewReview | null {
  const proposal = decisions.proposedDomain
  if (proposal === null) return null
  return {
    type: "new-domain",
    title: `New domain: ${proposal.path}`,
    description: [
      "The analysis proposes a domain that domains.yaml does not list. Approve it to add the domain, or use a domain that is listed.",
      `PROPOSAL: ${proposal.path} | ${proposal.lens} | ${oneLine(proposal.description)}`,
    ].join("\n"),
    sourcePath,
    options: [
      { label: "Approve", action: "mech:approve-domain" },
      { label: "Use an existing domain", action: "mech:use-existing-domain" },
      { label: "Skip", action: "Skip" },
    ],
  }
}

/** Lens ids for a mechanism page that has no `lenses`: the lens of the decided domain, else of the proposed one. */
function defaultLenses(ctx: MechanismContext, decisions: AnalysisDecisions): string[] {
  if (decisions.domain !== null) {
    const lens = lensForDomain(ctx, decisions.domain)
    return lens === null ? [] : [lens.id]
  }
  const proposal = decisions.proposedDomain
  return proposal !== null && hasOwn(ctx.lenses, proposal.lens) ? [proposal.lens] : []
}

/** A page under `wiki/mechanisms/`, or one that says `type: mechanism`. */
function isMechanismPage(path: string, content: string): boolean {
  return normalizePath(path).toLowerCase().startsWith(MECHANISM_DIR) || declaredType(content) === "mechanism"
}

/**
 * The `type` of the frontmatter, lower case, or null. When the frontmatter does not parse
 * (broken YAML, or a page the model did not finish), the first `type:` line near the top counts.
 */
function declaredType(content: string): string | null {
  const { frontmatter } = parseFrontmatter(content)
  if (frontmatter !== null) {
    const type = frontmatter.type
    return typeof type === "string" ? type.trim().toLowerCase() : null
  }
  for (const line of content.split("\n", TYPE_LINE_WINDOW)) {
    const match = /^type:[ \t]*["']?([\w-]+)/i.exec(line)
    if (match !== null) return match[1].toLowerCase()
  }
  return null
}

/** The `domain` of the frontmatter of a page, or null when it has none or the page has no frontmatter. */
function frontmatterDomain(content: string): string | null {
  let domain: string | null = null
  editFrontmatter(content, (fm) => {
    const at = findKey(fm, "domain")
    if (at === -1) return false
    const value = scalarValue(fm, at)
    domain = value === "" || value === "null" || value === "~" ? null : value
    return false
  })
  return domain
}

function fileStem(path: string): string {
  const name = normalizePath(path).split("/").pop() ?? path
  return name.replace(/\.md$/i, "")
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim()
}

// --- finding a block in the text ---------------------------------------

function withoutCarriageReturn(line: string): string {
  return line.endsWith("\r") ? line.slice(0, -1) : line
}

/**
 * Line numbers of the opener and closer of `block`, searching from line `from`.
 * `parseFileBlocks` returns the blocks in text order but not where they are.
 * The lines are compared the way it reads them: one trailing CR per line is not content.
 */
function locateBlock(
  lines: string[],
  from: number,
  block: ParsedFileBlock,
): { open: number; close: number } | null {
  // An empty content is no line or one empty line.
  const contentLines = block.content === "" ? [[], [""]] : [block.content.split("\n")]
  for (let open = from; open < lines.length; open++) {
    const opener = OPENER_LINE.exec(withoutCarriageReturn(lines[open]))
    if (opener === null || opener[1].trim() !== block.path) continue
    for (const expected of contentLines) {
      const close = open + expected.length + 1
      if (close >= lines.length) continue
      if (!CLOSER_LINE.test(withoutCarriageReturn(lines[close]))) continue
      if (expected.every((line, i) => withoutCarriageReturn(lines[open + 1 + i]) === line)) return { open, close }
    }
  }
  return null
}

// --- frontmatter -------------------------------------------------------

/**
 * The frontmatter at the start of a page, after any blank lines: its opening fence line,
 * its body (empty, or lines that end with a line break), and its closing fence.
 */
const FRONTMATTER = /^((?:[ \t]*\n)*)(---[ \t]*\n)(|[\s\S]*?\n)(---[ \t]*)(?=\n|$)/

/**
 * Edit the frontmatter lines of a page. `edit` changes the lines in place and
 * returns whether it changed anything. A page that `edit` leaves alone is
 * returned as it came. A page whose frontmatter is wrapped or broken in the
 * ways that `sanitizeIngestedFileContent` repairs is repaired first, as the
 * writer will do anyway. Returns null when the page has no frontmatter.
 */
function editFrontmatter(
  content: string,
  edit: (lines: string[]) => boolean,
): { content: string; changed: boolean } | null {
  let base = content
  let match = FRONTMATTER.exec(base)
  if (match === null) {
    base = sanitizeIngestedFileContent(content)
    match = FRONTMATTER.exec(base)
    if (match === null) return null
  }
  const [whole, blank, open, body, close] = match
  const lines = body === "" ? [] : body.slice(0, -1).split("\n")
  if (!edit(lines)) return { content, changed: false }
  const edited = lines.length === 0 ? "" : `${lines.join("\n")}\n`
  return { content: `${blank}${open}${edited}${close}${base.slice(whole.length)}`, changed: true }
}

/** A line that continues the value of the key above it: indented, or a list item. */
const CONTINUATION = /^(?:[ \t]+\S|-(?:[ \t]|$))/

function findKey(lines: string[], key: string): number {
  return lines.findIndex((line) => line.startsWith(key) && /^[ \t]*:/.test(line.slice(key.length)))
}

/** The line after the last line of the value of the key at `index`. */
function keyBlockEnd(lines: string[], index: number): number {
  let end = index + 1
  while (end < lines.length && CONTINUATION.test(lines[end])) end += 1
  return end
}

/** Remove every line of the key. True when there was one. */
function removeKey(lines: string[], key: string): boolean {
  let removed = false
  for (let at = findKey(lines, key); at !== -1; at = findKey(lines, key)) {
    lines.splice(at, keyBlockEnd(lines, at) - at)
    removed = true
  }
  return removed
}

/**
 * The scalar value after the key on line `index`, without quotes and comment.
 * A value that is a block list or a flow list comes back as its first line, which no domain equals.
 */
function scalarValue(lines: string[], index: number): string {
  const raw = lines[index].slice(lines[index].indexOf(":") + 1).trim()
  const quote = raw[0]
  if (quote === '"' || quote === "'") {
    const end = raw.indexOf(quote, 1)
    if (end > 0) return raw.slice(1, end)
  }
  const value = raw.replace(/\s+#.*$/, "").trim()
  // `domain:` with a list below it is a value, not an empty field.
  return value === "" && keyBlockEnd(lines, index) > index + 1 ? lines[index + 1].trim() : value
}

function inlineList(items: string[]): string {
  return `[${items.map((item) => (/^[A-Za-z0-9][\w-]*$/.test(item) ? item : JSON.stringify(item))).join(", ")}]`
}
