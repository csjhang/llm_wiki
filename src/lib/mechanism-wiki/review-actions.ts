/**
 * Review actions of a mechanism wiki.
 *
 * The review view calls `handleMechanismReviewAction` first for every option click. It handles the
 * four `mech:` actions and returns false for any other action, so the upstream handling goes on.
 * An action that fails throws an error with a message for the user; the view shows it on the card.
 *
 * - `mech:approve-domain`: add the proposed domain to `domains.yaml`.
 * - `mech:propose-mechanism`: write a proposed mechanism page into the mechanism library as a note.
 * - `mech:replace-source`: copy the newer text of a duplicate source over the older raw source.
 * - `mech:accept-research`: move a staged deep research result to `wiki/queries/`.
 *
 * `stageResearchResult` is the other end of the last action: deep research calls it to hold a result
 * back for approval.
 */
import yaml from "js-yaml"
import { copyFile, deleteFile, fileExists, readFile, writeFile } from "@/commands/fs"
import { parseFrontmatter } from "@/lib/frontmatter"
import { normalizePath } from "@/lib/path-utils"
import { withProjectLock } from "@/lib/project-mutex"
import { indexResearchPage } from "@/lib/research-index"
import { DOMAIN_NAME_PATTERN, KNOWN_LENSES, parseDomainsYaml } from "@/lib/wiki-config/domains"
import { MECHANISM_SECTIONS, removeSection } from "@/lib/wiki-config/section-headings"
import { hasOwn } from "@/lib/wiki-config/yaml-util"
import type { ReviewItem } from "@/stores/review-store"
import { listMarkdownFiles, loadMechanismContext } from "./context"
import { SLUG_MAX_LENGTH, SLUG_WORD, slugProblem } from "./decisions"

/** The option actions of the mechanism review items start with this. */
export const MECHANISM_ACTION_PREFIX = "mech:"

const APPROVE_DOMAIN = "mech:approve-domain"
const PROPOSE_MECHANISM = "mech:propose-mechanism"
const REPLACE_SOURCE = "mech:replace-source"
const ACCEPT_RESEARCH = "mech:accept-research"

export interface ReviewActionContext {
  /** The open project. */
  projectPath: string
  /** Mark the review item as resolved. `label` is what the card shows. */
  resolveItem(id: string, label: string): void
  /** Show the files that the action changed. A failure here never fails the action. */
  refresh(): Promise<void>
  /**
   * Queue a raw source of this project for ingest. `mech:replace-source` calls it with the project-relative
   * path of the source it replaced. The file watcher does not see the replacement, because the app wrote
   * the file itself, so something has to ask for the ingest. Left out, nothing is queued.
   */
  reingest?(sourcePath: string): Promise<void>
}

type ReviewDraft = Omit<ReviewItem, "id" | "resolved" | "createdAt">

/**
 * Run a `mech:` action. True when the action was handled; false for any other action, which the
 * caller handles. Throws an error with a message for the user when a `mech:` action fails.
 */
export async function handleMechanismReviewAction(
  item: ReviewItem | undefined,
  action: string,
  ctx: ReviewActionContext,
): Promise<boolean> {
  switch (action) {
    case APPROVE_DOMAIN:
      await approveDomain(requireItem(item, action), ctx)
      return true
    case PROPOSE_MECHANISM:
      await proposeMechanism(requireItem(item, action), ctx)
      return true
    case REPLACE_SOURCE:
      await replaceSource(requireItem(item, action), ctx)
      return true
    case ACCEPT_RESEARCH:
      await acceptResearch(requireItem(item, action), ctx)
      return true
    default:
      return false
  }
}

function requireItem(item: ReviewItem | undefined, action: string): ReviewItem {
  if (item === undefined) throw new Error(`The review item for ${action} is no longer in the review list.`)
  return item
}

function projectRoot(projectPath: string): string {
  return normalizePath(projectPath).replace(/\/+$/, "")
}

/** The file system changed; tell the view. The action has worked by now, so a failure here is only a warning. */
async function refresh(ctx: ReviewActionContext): Promise<void> {
  try {
    await ctx.refresh()
  } catch (err) {
    console.warn("[review-actions] could not refresh the file tree:", err instanceof Error ? err.message : err)
  }
}

// --- mech:approve-domain ------------------------------------------------

interface DomainProposal {
  path: string
  lens: string
  description: string
}

const DOMAINS_FILE = "domains.yaml"
/** The `domains` key with a block (or nothing) after it. */
const DOMAINS_BLOCK = /^domains[ \t]*:[ \t]*(?:#.*)?$/
/** The `domains` key with an empty value: `domains: {}`, `domains: ~`, or `domains: null`. */
const DOMAINS_EMPTY = /^(domains[ \t]*:)[ \t]*(?:\{[ \t]*\}|~|null)([ \t]*#.*)?$/

async function approveDomain(item: ReviewItem, ctx: ReviewActionContext): Promise<void> {
  const proposal = readProposal(item.description)
  const pp = projectRoot(ctx.projectPath)
  const file = `${pp}/${DOMAINS_FILE}`

  // Two approvals at once would each read the old file and the second write would drop the first domain.
  await withProjectLock(`${pp}\0${DOMAINS_FILE}`, async () => {
    if (!(await fileExists(file))) {
      throw new Error(`${DOMAINS_FILE} does not exist, so this project is not a mechanism wiki and has no domain list to change.`)
    }
    const text = await readFile(file)
    const lensStems = (await listMarkdownFiles(`${pp}/lenses`)).map((lens) => lens.stem)
    const knownLenses = [...new Set([...KNOWN_LENSES, ...lensStems])]

    const current = parseDomainsYaml(text, knownLenses)
    if (current.ok && hasOwn(current.value.domains, proposal.path)) return // approved before

    const next = insertDomain(text, proposal)
    const checked = parseDomainsYaml(next, knownLenses)
    if (!checked.ok) {
      const problems = checked.issues.map((issue) => (issue.path === "" ? issue.message : `${issue.path}: ${issue.message}`))
      throw new Error(`The domain "${proposal.path}" was not added, because ${DOMAINS_FILE} would not be valid: ${problems.join("; ")}`)
    }
    const added = checked.value.domains[proposal.path]
    if (added === undefined || added.lens !== proposal.lens || added.description !== proposal.description) {
      throw new Error(`The domain "${proposal.path}" was not added, because ${DOMAINS_FILE} would not read back as proposed.`)
    }
    await writeFile(file, next)
  })

  ctx.resolveItem(item.id, "Approved")
  await refresh(ctx)
}

/** The `PROPOSAL: <path> | <lens> | <description>` line of a `new-domain` review item. */
function readProposal(description: string): DomainProposal {
  const match = /^PROPOSAL:[ \t]*(.*)$/m.exec(description)
  const parts = match === null ? [] : match[1].split("|")
  const path = (parts[0] ?? "").trim()
  const lens = (parts[1] ?? "").trim()
  const text = parts.slice(2).join("|").trim()
  if (parts.length < 3 || path === "" || lens === "" || text === "") {
    throw new Error('The review item has no usable PROPOSAL line. It must read "PROPOSAL: <path> | <lens> | <description>".')
  }
  if (!DOMAIN_NAME_PATTERN.test(path)) {
    throw new Error(`The proposed domain name "${path}" is not valid. Use lowercase letters, digits, and "-", with "/" between levels.`)
  }
  return { path, lens, description: text }
}

/**
 * `text` with the new domain added as text, so every comment and blank line stays. The entry goes after
 * the last line of the `domains` block. `domains: {}` becomes `domains:` first. A file without a
 * `domains` key gets one at the end. Throws for a `domains` value that cannot be extended as text.
 */
function insertDomain(text: string, proposal: DomainProposal): string {
  // Each line keeps its own line break, so a line that is not changed stays byte for byte.
  const lines = text.match(/[^\n]*\n|[^\n]+/g) ?? []
  const withoutEol = (line: string): string => line.replace(/\r?\n$/, "")
  const eol = text.includes("\r\n") ? "\r\n" : "\n"

  const keyAt = lines.findIndex((line) => /^domains[ \t]*:/.test(line))
  if (keyAt === -1) {
    const kept = [...lines]
    if (kept.length > 0 && !kept[kept.length - 1].endsWith("\n")) kept[kept.length - 1] += eol
    return [...kept, `domains:${eol}`, ...entryLines(proposal, "  ", eol)].join("")
  }

  const keyLine = withoutEol(lines[keyAt])
  if (DOMAINS_EMPTY.test(keyLine)) {
    lines[keyAt] = `${keyLine.replace(DOMAINS_EMPTY, "$1$2")}${lines[keyAt].slice(keyLine.length)}`
  } else if (!DOMAINS_BLOCK.test(keyLine)) {
    throw new Error(
      `The domains list in ${DOMAINS_FILE} is written in a form that this app cannot extend. Add the domain "${proposal.path}" by hand.`,
    )
  }

  // The block ends at the next line that starts in the first column and is not a comment. An indented
  // line is part of the block even when it starts with "#": inside a block scalar it is text.
  let last = keyAt
  let keyIndent = ""
  for (let i = keyAt + 1; i < lines.length; i++) {
    const line = withoutEol(lines[i])
    if (line.trim() === "") continue
    if (!/^[ \t]/.test(line)) {
      if (line.startsWith("#")) continue
      break
    }
    last = i
    if (keyIndent === "" && !/^[ \t]*#/.test(line)) keyIndent = /^[ \t]*/.exec(line)![0]
  }
  if (keyIndent === "") keyIndent = "  "

  // A last line without a line break needs one before the new lines.
  const before = lines.slice(0, last + 1)
  if (!before[last].endsWith("\n")) before[last] = `${before[last]}${eol}`
  return [...before, ...entryLines(proposal, keyIndent, eol), ...lines.slice(last + 1)].join("")
}

function entryLines(proposal: DomainProposal, indent: string, eol: string): string[] {
  const inner = `${indent}  `
  return [
    `${indent}${proposal.path}:${eol}`,
    `${inner}lens: ${yamlScalar(proposal.lens)}${eol}`,
    `${inner}description: ${yamlScalar(proposal.description)}${eol}`,
    `${inner}whiteboards: []${eol}`,
  ]
}

/** `value` as a YAML scalar: plain when it reads back as the same string, else double-quoted. */
function yamlScalar(value: string): string {
  if (/^[A-Za-z0-9][A-Za-z0-9 ,.()'/_+-]*$/.test(value) && !value.endsWith(" ")) {
    try {
      if (yaml.load(value) === value) return value
    } catch {
      // Not plain-safe; quote it.
    }
  }
  return JSON.stringify(value)
}

// --- mech:propose-mechanism ---------------------------------------------

const PROPOSALS_DIR = "raw/sources/proposals"
const INCOMPLETE_PREFIX = /^\s*\(incomplete\)\s*/i
const SLUG_WORDS = new RegExp(SLUG_WORD, "gu")
/** How many numbered copies of one proposal name are tried before giving up. */
const MAX_COPIES = 1000

async function proposeMechanism(item: ReviewItem, ctx: ReviewActionContext): Promise<void> {
  const mechanism = await loadMechanismContext(ctx.projectPath)
  if (mechanism === null) {
    throw new Error("This project is not a mechanism wiki (domains.yaml is missing), so it has no mechanism library to send the proposal to.")
  }
  // A broken wiki.yaml reads as a reading wiki whose library is this very project.
  if (mechanism.identityStatus === "invalid") {
    throw new Error("wiki.yaml is not valid, so the mechanism library cannot be found. Fix wiki.yaml first.")
  }
  const library = mechanism.mechanismLibraryPath === null ? "" : projectRoot(mechanism.mechanismLibraryPath)
  if (library === "") {
    throw new Error("This wiki has no mechanism library path. Set mechanism_library in wiki.yaml to the folder of the reading wiki.")
  }

  const incomplete = INCOMPLETE_PREFIX.test(item.title)
  const title = item.title.replace(INCOMPLETE_PREFIX, "").replace(/\s+/g, " ").trim()
  const text = proposalBody(item.description, item.sourcePath)
  if (text === "") throw new Error("The review item has no proposal text to send.")
  // The pages of the work wiki that apply the mechanism stay there. The reading wiki learns only that one exists.
  const body = `${text}\n\nInstances: 1 in work wiki ${mechanism.identity.id.replace(/\s+/g, " ").trim()}.`

  const frontmatter = [
    "---",
    "source_kind: note",
    `title: ${JSON.stringify(title === "" ? "Untitled proposal" : title)}`,
    `proposed_from: ${yamlScalar(mechanism.identity.id)}`,
    ...(incomplete ? ["incomplete: true"] : []),
    "---",
  ]
  const content = `${frontmatter.join("\n")}\n\n${body}\n`

  const directory = `${library}/${PROPOSALS_DIR}`
  const slug = proposalSlug(title)
  await withProjectLock(`${library}\0${PROPOSALS_DIR}`, async () => {
    for (let copy = 1; copy <= MAX_COPIES; copy++) {
      const name = copy === 1 ? `${slug}.md` : `${slug}-${copy}.md`
      const path = `${directory}/${name}`
      // The name comes from the slug rules, which allow no separator. This is the last check before the write.
      if (/[\\/]/.test(name) || !path.startsWith(`${directory}/`)) throw new Error(`Refusing to write outside ${PROPOSALS_DIR}.`)
      if (await fileExists(path)) continue
      await writeFile(path, content)
      return
    }
    throw new Error(`There are too many proposals named "${slug}" in ${PROPOSALS_DIR}.`)
  })

  ctx.resolveItem(item.id, "Sent to reading wiki")
  await refresh(ctx)
}

/**
 * A line of an unclosed frontmatter: `key: value`, `- item`, or a line indented under a key.
 * A fragment cut in the middle of a key does not match; it is harmless text.
 */
const FRONTMATTER_LINE = /^(?:[A-Za-z_][\w-]*[ \t]*:.*|[ \t]*-(?:[ \t].*)?|[ \t]+\S.*)$/
const HEADING_LINE = /^#{1,6}(?:[ \t]|$)/

/** The Known instances section: every heading variant of `MECHANISM_SECTIONS` with the key `instances`. */
const INSTANCES_SECTIONS = MECHANISM_SECTIONS.filter((section) => section.key === "instances")

/** A wikilink or an embed: `[[target]]`, `[[target|label]]`, `![[target#heading]]`. */
const WIKILINK = /!?\[\[([^\]\r\n]*)\]\]/g

/**
 * The text that a wikilink shows: its label, else its target without folder, heading, and block id.
 * Links of the work wiki name its pages, so no link is kept; a plain word stays where the link was.
 */
function linkLabel(inner: string): string {
  const bar = inner.indexOf("|")
  if (bar !== -1) return inner.slice(bar + 1).trim()
  const target = inner.split(/[#^]/)[0].trim()
  return (target.slice(target.lastIndexOf("/") + 1) || target).replace(/\.md$/i, "")
}

/**
 * The proposed page without its frontmatter and without anything that names the work wiki.
 * The frontmatter of the work wiki lists its raw sources, and the reading wiki must not learn them.
 * - A closed frontmatter is cut off as a block.
 * - A page that stopped inside its frontmatter has an opening fence and no closing one: the fence and
 *   the run of frontmatter lines after it go, up to the first blank line or heading.
 * - In every case a line that holds `raw/sources/` or the path of the item's own source goes too.
 * - The Known instances section goes in every language variant: it lists pages of the work wiki.
 * - Every `[[wikilink]]` becomes its label as plain text, so no page name of the work wiki is linked.
 */
function proposalBody(content: string, sourcePath: string | undefined): string {
  const parsed = parseFrontmatter(content)
  let lines: string[]
  if (parsed.rawBlock !== "") {
    lines = parsed.body.split(/\r?\n/)
  } else {
    lines = content.split(/\r?\n/)
    const first = lines.findIndex((line) => line.trim() !== "")
    if (first !== -1 && /^---[ \t]*$/.test(lines[first])) {
      let end = first + 1
      while (
        end < lines.length &&
        lines[end].trim() !== "" &&
        !HEADING_LINE.test(lines[end]) &&
        FRONTMATTER_LINE.test(lines[end])
      ) {
        end++
      }
      lines = lines.slice(end)
    }
  }
  const own = normalizePath(sourcePath ?? "").trim().toLowerCase()
  let text = lines.join("\n")
  for (const section of INSTANCES_SECTIONS) text = removeSection(text, section)
  return text
    .split("\n")
    .filter((line) => {
      const path = normalizePath(line).toLowerCase()
      return !path.includes("raw/sources/") && (own === "" || !path.includes(own))
    })
    .join("\n")
    .replace(WIKILINK, (_link, inner: string) => linkLabel(inner))
    .trim()
}

/**
 * A file name stem for a proposal: kebab-case words of the title (Chinese, Japanese, and Korean text
 * too), at most 80 characters. A title with no usable word gets `proposal-<8 hex of a hash of the title>`.
 */
function proposalSlug(title: string): string {
  const words =
    title
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .normalize("NFKC")
      .toLowerCase()
      .match(SLUG_WORDS) ?? []
  let slug = ""
  for (const character of words.join("-")) {
    if (slug.length + character.length > SLUG_MAX_LENGTH) break
    slug += character
  }
  slug = slug.replace(/-+$/, "")
  return slugProblem(slug) === null ? slug : `proposal-${shortHash(title)}`
}

/** FNV-1a, 32 bits, as 8 hex digits. */
function shortHash(text: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, "0")
}

// --- mech:replace-source ------------------------------------------------

async function replaceSource(item: ReviewItem, ctx: ReviewActionContext): Promise<void> {
  const older = readSourceLine(item.description, "EXISTING")
  const newer = readSourceLine(item.description, "NEWER")
  if (older === newer) throw new Error("EXISTING and NEWER name the same file, so there is nothing to replace.")
  if (extensionOf(older) !== extensionOf(newer)) {
    throw new Error(
      `The two sources have a different file type (${extensionOf(older) || "none"} and ${extensionOf(newer) || "none"}), so the newer one cannot replace the older one.`,
    )
  }

  const pp = projectRoot(ctx.projectPath)
  // A copy over a missing file would bring back a source that the user deleted.
  if (!(await fileExists(`${pp}/${older}`))) {
    throw new Error(`The older source ${older} no longer exists, so there is nothing to replace. The newer source ${newer} stays as it is.`)
  }
  if (!(await fileExists(`${pp}/${newer}`))) throw new Error(`The newer source ${newer} no longer exists, so it cannot replace ${older}.`)

  // A byte copy, not a text copy: reading a PDF or an Office file as text would change it.
  await copyFile(`${pp}/${newer}`, `${pp}/${older}`)
  // Before the item resolves, so a failure leaves the item open and the action can run again.
  await ctx.reingest?.(older)

  ctx.resolveItem(item.id, "Replaced the older source")
  await refresh(ctx)
}

/** The path on the `EXISTING:` or `NEWER:` line. It must be a file inside `raw/sources/` of the project. */
function readSourceLine(description: string, label: "EXISTING" | "NEWER"): string {
  // The last such line: the lines come at the end of the description, after a sentence that starts with a file name.
  const matches = [...description.matchAll(new RegExp(`^${label}:[ \\t]*(.+)$`, "gm"))]
  if (matches.length === 0) throw new Error(`The review item has no ${label} line, so it does not say which source to use.`)
  const path = matches[matches.length - 1][1].trim()
  const segments = path.split("/")
  const valid =
    segments.length >= 3 &&
    segments[0] === "raw" &&
    segments[1] === "sources" &&
    segments.every((segment) => segment !== "" && segment !== "." && segment !== "..") &&
    !/[\\\u0000-\u001f]/.test(path)
  if (!valid) throw new Error(`The ${label} path "${path}" is not a file inside raw/sources/ of this project.`)
  return path
}

function extensionOf(path: string): string {
  const name = path.slice(path.lastIndexOf("/") + 1)
  const dot = name.lastIndexOf(".")
  return dot > 0 ? name.slice(dot).toLowerCase() : ""
}

// --- research staging ---------------------------------------------------

const STAGING_DIR = ".llm-wiki/research-staging"
const QUERIES_DIR = "wiki/queries"
const PREVIEW_LENGTH = 600
const TITLE_TOPIC_LENGTH = 80

/**
 * Hold a deep research result back for approval. Writes it to `.llm-wiki/research-staging/<fileName>`
 * (numbered when that file is still there) and returns the `research-result` review item for it.
 * The caller adds the item to the review store. `mech:accept-research` moves the file to `wiki/queries/`.
 */
export async function stageResearchResult(
  projectPath: string,
  fileName: string,
  content: string,
): Promise<ReviewDraft & { sourcePath: string }> {
  const pp = projectRoot(projectPath)
  const wanted = plainFileName(fileName)

  const name = await withProjectLock(`${pp}\0${STAGING_DIR}`, async () => {
    const available = await availableName(`${pp}/${STAGING_DIR}`, wanted)
    await writeFile(`${pp}/${STAGING_DIR}/${available}`, content)
    return available
  })

  const stem = name.replace(/\.md$/i, "")
  const { frontmatter, body } = parseFrontmatter(content)
  const heading = frontmatter?.title
  const topic = typeof heading === "string" && heading.trim() !== "" ? heading.trim() : stem
  const preview = body.trim()
  return {
    type: "research-result",
    title: researchCardTitle(topic, name),
    description: [
      `Deep research finished: ${topic}`,
      `The result is not in the wiki yet. Save it to add it as ${QUERIES_DIR}/${name}.`,
      ...(preview === "" ? [] : ["", preview.length > PREVIEW_LENGTH ? `${preview.slice(0, PREVIEW_LENGTH).trimEnd()}...` : preview]),
    ].join("\n"),
    sourcePath: `${STAGING_DIR}/${name}`,
    affectedPages: [`${QUERIES_DIR}/${name}`],
    options: [
      { label: "Save to wiki", action: ACCEPT_RESEARCH },
      { label: "Skip", action: "Skip" },
    ],
  }
}

/**
 * `Research result: <topic> (<8 hex>)`. The topic is the research topic, cut to 80 characters. The hex
 * is a hash of the staged file name, which is unique: the review id comes from the title, so two
 * results on one topic would otherwise be one item and the second would be lost.
 */
function researchCardTitle(pageTitle: string, stagedName: string): string {
  const topic = pageTitle.replace(/^Research:\s*/i, "").replace(/\s+/g, " ").trim()
  const characters = Array.from(topic === "" ? pageTitle : topic)
  const shown =
    characters.length > TITLE_TOPIC_LENGTH ? `${characters.slice(0, TITLE_TOPIC_LENGTH - 3).join("")}...` : characters.join("")
  return `Research result: ${shown} (${shortHash(stagedName)})`
}

async function acceptResearch(item: ReviewItem, ctx: ReviewActionContext): Promise<void> {
  const pp = projectRoot(ctx.projectPath)
  const staged = (item.sourcePath ?? "").trim()
  const prefix = `${STAGING_DIR}/`
  if (!staged.startsWith(prefix)) {
    throw new Error(`The staged research file "${staged}" is not inside ${STAGING_DIR}/.`)
  }
  const name = plainFileName(staged.slice(prefix.length))
  const from = `${pp}/${STAGING_DIR}/${name}`
  if (!(await fileExists(from))) throw new Error(`The staged research file ${staged} is no longer there.`)

  const target = await withProjectLock(`${pp}\0${QUERIES_DIR}`, async () => {
    const available = await availableName(`${pp}/${QUERIES_DIR}`, name)
    await copyFile(from, `${pp}/${QUERIES_DIR}/${available}`)
    return available
  })
  try {
    await deleteFile(from)
  } catch (err) {
    // The page is saved; a staging copy that stays behind does no harm.
    console.warn("[review-actions] could not remove the staged research file:", err instanceof Error ? err.message : err)
  }

  ctx.resolveItem(item.id, "Saved")
  await refresh(ctx)
  await indexAcceptedPage(`${pp}/${QUERIES_DIR}/${target}`, pp)
}

/** Index the page that was just saved, as deep research does for a page it writes at once. Never throws. */
async function indexAcceptedPage(pagePath: string, pp: string): Promise<void> {
  try {
    const content = await readFile(pagePath)
    const heading = parseFrontmatter(content).frontmatter?.title
    const title = typeof heading === "string" && heading.trim() !== "" ? heading.trim() : pagePath.slice(pagePath.lastIndexOf("/") + 1).replace(/\.md$/i, "")
    await indexResearchPage(pp, pagePath, title, content)
  } catch (err) {
    console.warn("[review-actions] could not index the saved research page:", err instanceof Error ? err.message : err)
  }
}

/** A file name with no folder part. Throws for anything else. */
function plainFileName(name: string): string {
  const trimmed = name.trim()
  if (trimmed === "" || trimmed === "." || trimmed === ".." || /[\\/\u0000-\u001f]/.test(trimmed)) {
    throw new Error(`Invalid research file name "${name}": use a plain file name without folders.`)
  }
  return trimmed
}

/** `name`, or `name-2`, `name-3`, ... before the extension, whichever is free in `directory`. */
async function availableName(directory: string, name: string): Promise<string> {
  if (!(await fileExists(`${directory}/${name}`))) return name
  const extensionAt = name.toLowerCase().endsWith(".md") ? name.length - ".md".length : name.length
  const stem = name.slice(0, extensionAt)
  const extension = name.slice(extensionAt)
  for (let copy = 2; copy <= MAX_COPIES; copy++) {
    const candidate = `${stem}-${copy}${extension}`
    if (!(await fileExists(`${directory}/${candidate}`))) return candidate
  }
  throw new Error(`There are too many files named "${name}" in ${directory}.`)
}
