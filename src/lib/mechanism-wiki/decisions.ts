/**
 * Parser for the decisions of an analysis.
 *
 * The analysis prompt of a mechanism wiki asks the model to end with a
 * `## Decisions` section. On the chunked path of a long source, the decisions
 * come as a `### Decisions` subsection at the head of the final digest.
 * `parseAnalysisDecisions` reads that section into `AnalysisDecisions`. It
 * never throws: a line that cannot be used is dropped and described in
 * `problems`, and the lines that can be used still count.
 */
import { DOMAIN_NAME_PATTERN, domainParent, KNOWN_LENSES } from "@/lib/wiki-config/domains"
import { hasOwn } from "@/lib/wiki-config/yaml-util"
import type { MechanismContext } from "./context"
import { emptyDecisions } from "./types"
import type { AnalysisDecisions, MechanismDecision } from "./types"

type ProposedDomain = NonNullable<AnalysisDecisions["proposedDomain"]>

/** A domain line either names a listed domain or proposes one. */
type DomainChoice =
  | { kind: "listed"; path: string }
  | { kind: "proposed"; proposal: ProposedDomain }

type Outcome<T> = { value: T } | { problem: string }

/**
 * Read the decisions out of `analysis`.
 *
 * - `fallbackDomain` is the domain of the source's own hint. It is the domain
 *   when the analysis names none that can be used.
 * - `existingMechanisms` holds the slugs of the mechanism pages that the
 *   library already has. An `existing:` line whose slug is not in it becomes
 *   `new:`.
 *
 * `mechanisms` holds only valid lines. `problems` describes the lines that
 * were dropped, and the gaps (no section, no domain line).
 */
export function parseAnalysisDecisions(
  analysis: string,
  ctx: MechanismContext,
  fallbackDomain: string | null,
  existingMechanisms: ReadonlySet<string>,
): AnalysisDecisions {
  const lines = findDecisionsSection(analysis)
  if (lines === null) {
    return {
      ...emptyDecisions(fallbackDomain),
      problems: [
        "The analysis has no Decisions section, so it chose no domain and no mechanism" +
          (fallbackDomain === null ? "." : `; the domain of the source (${fallbackDomain}) is used.`),
      ],
    }
  }

  const problems: string[] = []
  const mechanisms: MechanismDecision[] = []
  const slugs = new Set<string>()
  let chosen: DomainChoice | null = null

  for (const raw of lines) {
    const line = raw.trim().replace(BULLET, "")
    const match = DECISION_LINE.exec(line)
    if (match === null) {
      // Prose and fence markers are no problem. A line that tried to be a decision line is.
      if (LOOKS_LIKE_DECISION_LINE.test(line)) {
        problems.push(`Decision line not understood: "${shorten(line)}". The keyword must be exactly as in the line forms.`)
      }
      continue
    }
    const [, keyword, rest] = match

    if (keyword === "MECHANISM") {
      const outcome = readMechanismLine(rest, line, existingMechanisms)
      if ("problem" in outcome) {
        problems.push(outcome.problem)
      } else if (!slugs.has(outcome.value.slug)) {
        slugs.add(outcome.value.slug)
        mechanisms.push(outcome.value)
      }
      continue
    }

    const outcome = keyword === "DOMAIN" ? readDomainLine(rest, ctx) : readNewDomainLine(rest, line, ctx)
    if ("problem" in outcome) {
      problems.push(outcome.problem)
    } else if (chosen === null) {
      chosen = outcome.value
    } else {
      problems.push(`More than one valid domain line. Only the first is used; ignored: "${shorten(line)}".`)
    }
  }

  if (chosen === null) {
    problems.push(
      "The Decisions section has no valid DOMAIN or NEW-DOMAIN line" +
        (fallbackDomain === null ? "." : `; the domain of the source (${fallbackDomain}) is used.`),
    )
  }

  return {
    domain: chosen === null ? fallbackDomain : chosen.kind === "listed" ? chosen.path : null,
    proposedDomain: chosen?.kind === "proposed" ? chosen.proposal : null,
    mechanisms,
    problems,
  }
}

// --- domain lines ------------------------------------------------------

function readDomainLine(path: string, ctx: MechanismContext): Outcome<DomainChoice> {
  if (hasOwn(ctx.domains.domains, path)) return { value: { kind: "listed", path } }
  if (!DOMAIN_NAME_PATTERN.test(path)) return { problem: invalidDomainPath("DOMAIN", path) }

  // A path below a listed domain is a proposal that uses the lens of that domain.
  for (let ancestor = domainParent(path); ancestor !== null; ancestor = domainParent(ancestor)) {
    if (!hasOwn(ctx.domains.domains, ancestor)) continue
    const entry = ctx.domains.domains[ancestor]
    return {
      value: {
        kind: "proposed",
        proposal: { path, lens: entry.lens, description: `Part of ${ancestor}: ${entry.description}` },
      },
    }
  }
  return {
    problem: `DOMAIN "${path}" is not listed in domains.yaml and has no listed parent domain. A new top-level domain needs a NEW-DOMAIN line.`,
  }
}

function readNewDomainLine(rest: string, line: string, ctx: MechanismContext): Outcome<DomainChoice> {
  const parts = rest.split("|")
  if (parts.length < 3) {
    return { problem: `NEW-DOMAIN needs "<path> | <lens> | <description>": "${shorten(line)}".` }
  }
  const path = parts[0].trim()
  const lens = parts[1].trim()
  const description = parts.slice(2).join("|").trim()

  // The model may name a domain that exists. That is a plain choice, not a proposal.
  if (hasOwn(ctx.domains.domains, path)) return { value: { kind: "listed", path } }
  if (!DOMAIN_NAME_PATTERN.test(path)) return { problem: invalidDomainPath("NEW-DOMAIN", path) }
  const lenses = knownLenses(ctx)
  if (!lenses.includes(lens)) {
    return { problem: `NEW-DOMAIN "${path}" uses the lens "${lens}", which is not a known lens (${lenses.join(", ")}).` }
  }
  if (description === "") return { problem: `NEW-DOMAIN "${path}" has no description.` }
  return { value: { kind: "proposed", proposal: { path, lens, description } } }
}

function invalidDomainPath(keyword: string, path: string): string {
  return `${keyword} "${shorten(path)}" is not a valid domain path. Use lowercase letters, digits, and "-", with "/" between levels.`
}

/** The lenses a new domain may use: the built-in ones and the stems of `lenses/*.md`, as `domains.yaml` allows. */
export function knownLenses(ctx: MechanismContext): string[] {
  return [...new Set([...KNOWN_LENSES, ...Object.keys(ctx.lenses)])]
}

// --- mechanism lines ---------------------------------------------------

/** One word of a slug: lower-case letters and digits, or Chinese, Japanese, or Korean text. */
export const SLUG_WORD = "[a-z0-9\\p{Script=Han}\\p{Script=Hiragana}\\p{Script=Katakana}\\p{Script=Hangul}\\u30fc]+"

/** Kebab-case, where a word may also be Chinese, Japanese, or Korean text. */
export const SLUG_PATTERN = new RegExp(`^${SLUG_WORD}(?:-${SLUG_WORD})*$`, "u")

/** A slug becomes a file name, so it stays well inside the limits of file systems. */
export const SLUG_MAX_LENGTH = 80

/** File names that Windows reserves, with or without an extension. A slug has no dot, so it is the whole name. */
const WINDOWS_RESERVED_NAMES: ReadonlySet<string> = new Set([
  "con",
  "prn",
  "aux",
  "nul",
  ...[1, 2, 3, 4, 5, 6, 7, 8, 9].flatMap((n) => [`com${n}`, `lpt${n}`]),
])

/** Why `slug` cannot be a file name stem, or null when it can. */
export function slugProblem(slug: string): "pattern" | "too-long" | "reserved" | null {
  if (!SLUG_PATTERN.test(slug)) return "pattern"
  if (slug.length > SLUG_MAX_LENGTH) return "too-long"
  if (WINDOWS_RESERVED_NAMES.has(slug)) return "reserved"
  return null
}

/** `existing:<slug> | <one-line>`. The summary group is missing when the line has no `|`. */
const MECHANISM_FORM = /^(existing|new)\s*:([^|]*)(?:\|(.*))?$/

function readMechanismLine(
  rest: string,
  line: string,
  existingMechanisms: ReadonlySet<string>,
): Outcome<MechanismDecision> {
  const match = MECHANISM_FORM.exec(rest)
  if (match === null) {
    return { problem: `MECHANISM line must start with "existing:" or "new:": "${shorten(line)}".` }
  }
  const [, kind, slugText, summaryText] = match
  const slug = slugText.trim()
  const summary = (summaryText ?? "").trim()
  const slugIssue = slugProblem(slug)
  if (slugIssue === "pattern") {
    return { problem: `MECHANISM slug "${shorten(slug)}" is not kebab-case (or Chinese, Japanese, or Korean text): "${shorten(line)}".` }
  }
  if (slugIssue === "too-long") {
    return { problem: `MECHANISM slug "${shorten(slug)}" is longer than ${SLUG_MAX_LENGTH} characters: "${shorten(line)}".` }
  }
  if (slugIssue === "reserved") {
    return { problem: `MECHANISM slug "${slug}" is a reserved file name on Windows: "${shorten(line)}".` }
  }
  if (summary === "") {
    return { problem: `MECHANISM line has no one-line summary after "|": "${shorten(line)}".` }
  }
  // A page that the library does not have cannot be updated, so it is new.
  const resolvedKind = kind === "existing" && existingMechanisms.has(slug) ? "existing" : "new"
  return { value: { kind: resolvedKind, slug, summary } }
}

// --- lines -------------------------------------------------------------

/** A bullet that the model put before a decision line, which the prompt does not ask for. */
const BULLET = /^[-*+]\s+/

/** A decision line in its exact form. `NEW-DOMAIN` comes before `DOMAIN` so the longer keyword wins. */
const DECISION_LINE = /^(NEW-DOMAIN|DOMAIN|MECHANISM)\s*:\s*(.*)$/

/** A line that has the shape of a decision line, in any letter case. */
const LOOKS_LIKE_DECISION_LINE = /^(?:new-domain|domain|mechanism)\s*:/i

const SHORTEN_AT = 120

function shorten(text: string): string {
  return text.length > SHORTEN_AT ? `${text.slice(0, SHORTEN_AT)}...` : text
}

// --- the section -------------------------------------------------------

interface Heading {
  level: number
  name: string
  /** Index in the list of lines. */
  line: number
}

const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/
const HEADING = /^ {0,3}(#{1,6})[ \t]+(.*)$/
const DECISIONS_NAME = /^decisions\s*[:：]?$/i

/**
 * The lines of the last `## Decisions` or `### Decisions` section, or null
 * when there is none. A section ends at the next heading of its own level or a
 * higher one. A heading inside a fenced code block is no heading.
 */
function findDecisionsSection(analysis: string): string[] | null {
  const lines = analysis.split(/\r?\n/)
  const headings = scanHeadings(lines)
  const index = headings.map((h) => (h.level === 2 || h.level === 3) && DECISIONS_NAME.test(h.name)).lastIndexOf(true)
  if (index === -1) return null

  const heading = headings[index]
  const next = headings.slice(index + 1).find((h) => h.level <= heading.level)
  return lines.slice(heading.line + 1, next === undefined ? lines.length : next.line)
}

function scanHeadings(lines: string[]): Heading[] {
  const headings: Heading[] = []
  let fence: { char: string; length: number } | null = null

  lines.forEach((text, line) => {
    const mark = FENCE.exec(text)
    if (fence !== null) {
      // Only a bare fence of the same kind, at least as long, closes the block.
      if (mark !== null && mark[1][0] === fence.char && mark[1].length >= fence.length && mark[2].trim() === "") {
        fence = null
      }
      return
    }
    // An opening backtick fence cannot hold a backtick in its info text.
    if (mark !== null && !(mark[1][0] === "`" && mark[2].includes("`"))) {
      fence = { char: mark[1][0], length: mark[1].length }
      return
    }
    const heading = HEADING.exec(text)
    if (heading !== null) {
      // The name has no closing hashes: "## Decisions ##" is "Decisions".
      headings.push({ level: heading[1].length, name: heading[2].trim().replace(/\s+#+$/, ""), line })
    }
  })
  return headings
}
