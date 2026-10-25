/**
 * `wiki-tool fuse check` - say whether a hypothesis page follows the rules of
 * `schema/page-types/hypothesis.md`.
 *
 * `--project P --file wiki/hypotheses/<slug>.md` gives `{ ok, problems }`; `problems` lists every rule the page
 * breaks. The page is only read. `fuse commit` runs the same check on each hypothesis it commits.
 *
 * Rules:
 * - Frontmatter: `type: hypothesis`; `mechanism`, `from_domain`, `to_domain`, `relation` (`analogy` or `stack`),
 *   `strength` (`surface`, `structural`, `mathematical`), and `status` (`draft`, `testing`, `supported`, `refuted`) are
 *   present and valid. Both domains are in `domains.yaml` of this wiki or, in a work wiki, in `domains.yaml` of the
 *   mechanism library (`mechanism_library` of `wiki.yaml`, a path from the project folder).
 * - Sections: the six sections of `HYPOTHESIS_SECTIONS` are present, in any language variant. English headings match in
 *   any letter case. The order is not checked.
 * - Role mapping: it has a table and at least one `[[link]]`. The one-line hypothesis needs no link.
 * - What to verify: it has a table, and the last column (How to refute) is not empty in any row. A cell with no
 *   letter or digit (`-`, `<br>`) is empty. The rows by `status` (rulings R16, R18):
 *   `draft` may have no row; `testing` needs a row that links a page in `wiki/queries/`; `supported` and `refuted` need
 *   at least one row, and each row links at least one page of this wiki as evidence.
 * - `relation: stack` (ruling R17): `from_domain` is the base layer and `to_domain` is the upper layer. Which of two
 *   domains is the lower one is not in the page, so the check only refuses a stack of a domain on itself.
 *
 * A `[[link]]` names a page by its slug, or by its path from `wiki/`. A link in a code span, an embed (`![[...]]`),
 * and a link to a heading of the same page are not links.
 */
import { existsSync, readFileSync } from "node:fs"
import { join, relative, resolve, sep } from "node:path"
import { parseFrontmatter } from "@/lib/frontmatter"
import { parseDomainsYaml } from "@/lib/wiki-config/domains"
import { findSection, HYPOTHESIS_SECTIONS } from "@/lib/wiki-config/section-headings"
import { parseArgs } from "../args"
import { knownLenses } from "../cmd-snapshot"
import { type CommandResult, isDirectory, resolveInProject } from "../io"
import { readWikiIdentity, readWikiPages, type WikiPage } from "../mirror-pages"

const HYPOTHESES_FOLDER = "wiki/hypotheses/"
const QUERIES_FOLDER = "wiki/queries/"

const RELATIONS = ["analogy", "stack"]
const STRENGTHS = ["surface", "structural", "mathematical"]
const STATUSES = ["draft", "testing", "supported", "refuted"]
/** The prefix of a mechanism in the reading wiki, as seen from a work wiki. */
const READING_PREFIX = "reading:"
/** The longest piece of a claim that a problem quotes. */
const LABEL_LENGTH = 40

// --- the command -----------------------------------------------------------

export function fuseCheck(args: string[]): CommandResult {
  const { parsed, problems } = parseArgs(args, { values: ["project", "file"] })
  const { project, file } = parsed.values
  if (project === undefined) problems.push("missing option: --project")
  if (file === undefined) problems.push("missing option: --file")
  if (problems.length > 0 || project === undefined || file === undefined) return { ok: false, problems }
  if (!isDirectory(project)) return { ok: false, problems: [`project folder not found: ${project}`] }

  let path: string
  try {
    path = projectRelativePath(project, file)
  } catch (error) {
    return { ok: false, problems: [error instanceof Error ? error.message : String(error)] }
  }
  const found = checkHypothesisFile(project, path)
  return { ok: found.length === 0, problems: found }
}

/**
 * The path of `file` from the project folder, with `/` separators and no `.` or `..` segments. Throws when the file
 * is outside the project.
 */
export function projectRelativePath(project: string, file: string): string {
  const absolute = resolveInProject(project, file)
  return relative(resolve(project), absolute).split(sep).join("/")
}

/** True for a path in `wiki/hypotheses/`. Letter case is ignored, because a disk may ignore it. */
export function isHypothesisPath(path: string): boolean {
  return path.toLowerCase().startsWith(HYPOTHESES_FOLDER)
}

/**
 * The problems of the hypothesis page at `path` (from the project folder, with `/`). An empty list means the page
 * passes.
 */
export function checkHypothesisFile(project: string, path: string): string[] {
  if (!isHypothesisPath(path)) return [`a hypothesis page is written in ${HYPOTHESES_FOLDER}: ${path}`]
  let text: string
  try {
    text = readFileSync(resolveInProject(project, path), "utf8").replace(/^\uFEFF/, "")
  } catch {
    return [`cannot read ${path}`]
  }

  const problems: string[] = []
  const { frontmatter, body } = parseFrontmatter(text)
  if (frontmatter === null) problems.push("the page has no frontmatter")
  const field = (key: string): string => {
    const value = frontmatter?.[key]
    return typeof value === "string" ? value.trim() : ""
  }

  const status = checkFields(field, problems)
  checkDomains(project, field, problems)

  const sections = new Map<string, string>()
  for (const section of HYPOTHESIS_SECTIONS) {
    const content = findSection(body, section)
    if (content === null) problems.push(`missing section: ${section.en}`)
    else sections.set(section.key, content)
  }
  const mapping = sections.get("mapping")
  if (mapping !== undefined) {
    if (parseTable(mapping) === null) problems.push("Role mapping has no table")
    if (wikiLinkTargets(mapping).length === 0) problems.push("Role mapping has no [[link]] to a wiki page")
  }
  const verify = sections.get("verify")
  if (verify !== undefined) problems.push(...checkVerify(project, verify, status))

  return [...new Set(problems)]
}

// --- frontmatter -----------------------------------------------------------

/** Check the fields that do not need the wiki. Returns the `status` when it is valid, else null. */
function checkFields(field: (key: string) => string, problems: string[]): string | null {
  const choice = (key: string, allowed: readonly string[]): string | null => {
    const value = field(key)
    if (value === "") {
      problems.push(`missing field: ${key}`)
      return null
    }
    if (!allowed.includes(value)) {
      problems.push(`${key} must be one of ${allowed.join(", ")} (found ${JSON.stringify(value)})`)
      return null
    }
    return value
  }

  if (field("type") === "") problems.push("missing field: type")
  else if (field("type") !== "hypothesis") problems.push(`type must be hypothesis (found ${JSON.stringify(field("type"))})`)

  const mechanism = field("mechanism")
  if (mechanism === "") problems.push("missing field: mechanism")
  else if (mechanism.startsWith(READING_PREFIX) && mechanism.slice(READING_PREFIX.length).trim() === "") {
    problems.push(`mechanism ${JSON.stringify(mechanism)} needs a slug after "${READING_PREFIX}"`)
  }

  const relation = choice("relation", RELATIONS)
  choice("strength", STRENGTHS)
  const status = choice("status", STATUSES)

  const from = field("from_domain")
  const to = field("to_domain")
  if (from === "") problems.push("missing field: from_domain")
  if (to === "") problems.push("missing field: to_domain")
  // Ruling R17: in a stack, from_domain is the base layer and to_domain is the upper layer. A domain is not its own base.
  if (relation === "stack" && from !== "" && from === to) {
    problems.push(
      `relation stack needs from_domain (the base layer) and to_domain (the upper layer) to be two domains; both are ${JSON.stringify(from)}`,
    )
  }
  return status
}

// --- domains ---------------------------------------------------------------

interface DomainList {
  names: Set<string>
  /** Where the names come from, for a problem text. */
  where: string
  /** Why a `domains.yaml` could not be used. Said only when a domain is not found. */
  notes: string[]
}

/** The domain names of `domains.yaml` in the wiki at `root`. A file that is missing or not valid adds a note. */
function readDomainNames(root: string, label: string, list: DomainList): void {
  const path = join(root, "domains.yaml")
  if (!existsSync(path)) {
    list.notes.push(`${label} has no domains.yaml`)
    return
  }
  let text: string
  try {
    text = readFileSync(path, "utf8").replace(/^\uFEFF/, "")
  } catch {
    list.notes.push(`cannot read domains.yaml of ${label}`)
    return
  }
  const result = parseDomainsYaml(text, knownLenses(root))
  if (!result.ok) {
    const issue = result.issues[0]
    list.notes.push(`domains.yaml of ${label} is not valid: ${issue.path === "" ? "" : `${issue.path}: `}${issue.message}`)
    return
  }
  for (const name of Object.keys(result.value.domains)) list.names.add(name)
}

/** The domains of this wiki and, in a work wiki, of its mechanism library. */
function loadDomains(project: string): DomainList {
  const list: DomainList = { names: new Set(), where: "domains.yaml of this wiki", notes: [] }
  readDomainNames(project, "this wiki", list)
  const identityProblems: string[] = []
  const identity = readWikiIdentity(project, identityProblems)
  if (!identity) {
    list.notes.push(...identityProblems)
    return list
  }
  if (identity.mechanism_library !== null) {
    const library = resolve(project, identity.mechanism_library.replace(/\\/g, "/"))
    list.where = `domains.yaml of this wiki or of the mechanism library (${identity.mechanism_library})`
    readDomainNames(library, "the mechanism library", list)
  }
  return list
}

function checkDomains(project: string, field: (key: string) => string, problems: string[]): void {
  const wanted = (["from_domain", "to_domain"] as const).filter((key) => field(key) !== "")
  if (wanted.length === 0) return
  const domains = loadDomains(project)
  for (const key of wanted) {
    if (domains.names.has(field(key))) continue
    const why = domains.notes.length > 0 ? ` (${domains.notes.join("; ")})` : ""
    problems.push(`${key} ${JSON.stringify(field(key))} is not in ${domains.where}${why}`)
  }
}

// --- what to verify --------------------------------------------------------

function checkVerify(project: string, section: string, status: string | null): string[] {
  const problems: string[] = []
  const table = parseTable(section)
  if (table === null) return ["What to verify has no table"]

  const last = table.header.length - 1
  table.rows.forEach((row, index) => {
    if (isBlank(row[last] ?? "")) {
      problems.push(`What to verify ${rowName(row, index)}: the last column (${JSON.stringify(table.header[last])}) is empty`)
    }
  })

  if (status !== "testing" && status !== "supported" && status !== "refuted") return problems
  if (status !== "testing" && table.rows.length === 0) {
    problems.push(`status ${status} needs at least one row under What to verify`)
    return problems
  }

  const pages = new PageLookup(project)
  if (status === "testing") {
    const linksQuery = table.rows.some((row) => pages.find(wikiLinkTargets(row.join(" | "))).some(isQueryPage))
    if (!linksQuery) problems.push(`status testing needs a row under What to verify that links a page in ${QUERIES_FOLDER}`)
  } else {
    table.rows.forEach((row, index) => {
      const targets = wikiLinkTargets(row.join(" | "))
      if (pages.find(targets).length > 0) return
      const missing = targets.length > 0 ? `; no page found for ${targets.map((target) => `[[${target}]]`).join(", ")}` : ""
      problems.push(`What to verify ${rowName(row, index)}: status ${status} needs a link to a wiki page as evidence${missing}`)
    })
  }
  problems.push(...pages.problems)
  return problems
}

function rowName(row: readonly string[], index: number): string {
  const claim = (row[0] ?? "").replace(/\s+/g, " ").trim()
  const shown = claim.length > LABEL_LENGTH ? `${claim.slice(0, LABEL_LENGTH - 1)}…` : claim
  return shown === "" ? `row ${index + 1}` : `row ${index + 1} (${JSON.stringify(shown)})`
}

function isQueryPage(page: WikiPage): boolean {
  return page.path.toLowerCase().startsWith(QUERIES_FOLDER)
}

/** The pages of the wiki, read on the first lookup, and the pages a link names. */
class PageLookup {
  readonly problems: string[] = []
  private index: { bySlug: Map<string, WikiPage[]>; byPath: Map<string, WikiPage[]> } | null = null

  constructor(private readonly project: string) {}

  /** The pages that the targets name, without repeats. */
  find(targets: readonly string[]): WikiPage[] {
    if (targets.length === 0) return []
    const index = this.load()
    const found = new Set<WikiPage>()
    for (const target of targets) {
      const key = target.replace(/\\/g, "/").replace(/\.md$/i, "").replace(/^\/+/, "").replace(/^wiki\//i, "").toLowerCase()
      const pages = (key.includes("/") ? index.byPath : index.bySlug).get(key) ?? []
      for (const page of pages) found.add(page)
    }
    return [...found]
  }

  private load() {
    if (this.index) return this.index
    const bySlug = new Map<string, WikiPage[]>()
    const byPath = new Map<string, WikiPage[]>()
    const add = (map: Map<string, WikiPage[]>, key: string, page: WikiPage): void => {
      map.set(key, [...(map.get(key) ?? []), page])
    }
    let pages: WikiPage[] = []
    try {
      pages = readWikiPages(this.project, { allowMissingWiki: true })
    } catch (error) {
      this.problems.push(`cannot read the pages of this wiki: ${error instanceof Error ? error.message : String(error)}`)
    }
    for (const page of pages) {
      add(bySlug, page.slug.toLowerCase(), page)
      add(byPath, page.path.replace(/^wiki\//i, "").replace(/\.md$/i, "").toLowerCase(), page)
    }
    this.index = { bySlug, byPath }
    return this.index
  }
}

// --- markdown --------------------------------------------------------------

/** `[[slug]]`, `[[slug|label]]`, and `[[slug\|label]]` (in a table cell). Not an embed. */
const WIKILINK = /(?<!!)\[\[([^[\]|\\\n]+)(?:\\?\|[^[\]\n]*)?\]\]/g

/** The page names of the `[[links]]` in `text`, without the `#anchor`. A link to a heading of the same page has none. */
function wikiLinkTargets(text: string): string[] {
  const outsideCode = text.replace(/```[\s\S]*?```/g, " ").replace(/`[^`\n]*`/g, " ")
  const targets: string[] = []
  for (const match of outsideCode.matchAll(WIKILINK)) {
    const target = match[1].split("#")[0].trim()
    if (target !== "") targets.push(target)
  }
  return targets
}

interface Table {
  header: string[]
  rows: string[][]
}

/**
 * The first table of `markdown`: a header line, a delimiter line (`|---|---|`) with as many cells, and the lines
 * after it up to the first line with no pipe. Null when there is none.
 */
function parseTable(markdown: string): Table | null {
  const lines = markdown.split(/\r?\n/)
  for (let start = 0; start + 1 < lines.length; start += 1) {
    if (!lines[start].includes("|") || !lines[start + 1].includes("|")) continue
    const header = splitRow(lines[start])
    const delimiter = splitRow(lines[start + 1])
    if (header.length === 0 || delimiter.length !== header.length) continue
    if (!delimiter.every((cell) => /^:?-+:?$/.test(cell))) continue
    const rows: string[][] = []
    for (let index = start + 2; index < lines.length && lines[index].includes("|"); index += 1) {
      rows.push(splitRow(lines[index]))
    }
    return { header, rows }
  }
  return null
}

/**
 * The cells of one table line, trimmed. The outer pipes are optional. `\|` does not split a cell, and neither does the
 * pipe of a `[[link|label]]`.
 */
function splitRow(line: string): string[] {
  let text = line.trim()
  if (text.startsWith("|")) text = text.slice(1)
  const cells: string[] = []
  let cell = ""
  let closed = false
  for (let index = 0; index < text.length; ) {
    closed = false
    if (text.startsWith("[[", index)) {
      const end = text.indexOf("]]", index + 2)
      if (end !== -1) {
        cell += text.slice(index, end + 2)
        index = end + 2
        continue
      }
    }
    if (text[index] === "\\" && index + 1 < text.length) {
      cell += text.slice(index, index + 2)
      index += 2
    } else if (text[index] === "|") {
      cells.push(cell.trim())
      cell = ""
      closed = true
      index += 1
    } else {
      cell += text[index]
      index += 1
    }
  }
  // A closing pipe ends the last cell. Without one, the text after the last pipe is a cell.
  if (!closed) cells.push(cell.trim())
  return cells
}

/** True for a cell with no word in it: nothing, a dash, or a line break. */
function isBlank(cell: string): boolean {
  return !/[\p{L}\p{N}]/u.test(cell.replace(/<br\s*\/?>/gi, " "))
}
