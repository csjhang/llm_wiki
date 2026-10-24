/**
 * Domain-first index of a mechanism wiki: the text of the index files.
 *
 * `wiki/index.md` lists the domain tree with page counts. `wiki/indexes/<domain>.md`
 * lists the pages of one domain, and `wiki/indexes/_mechanisms.md` lists the
 * mechanism pages. Everything here is pure: the same pages give the same bytes,
 * and nothing reads a file. It imports no Tauri code, so the `wiki-tool` CLI can
 * reuse it. The file reading and writing is in `domain-index.ts`.
 */
import { parseFrontmatter } from "@/lib/frontmatter"
import { inferWikiTypeFromPath } from "@/lib/wiki-page-types"
import type { DomainsConfig } from "@/lib/wiki-config/domains"

/** One page of the wiki, as the index sees it. */
export interface IndexedPage {
  /** Path from the project root, with `/`: `wiki/concepts/handshake.md`. */
  path: string
  /** File stem: `handshake`. */
  slug: string
  /** The `type` of the frontmatter, else the type of the folder, else "" (no type). */
  type: string
  /** The `title` of the frontmatter, else the first `# ` heading, else the slug. */
  title: string
  /** The `domain` of the page. For a hypothesis page: its `to_domain` (ruling R19). Null when it has none. */
  domain: string | null
}

/** The folder of the index files, with a trailing slash. */
export const DOMAIN_INDEX_DIR = "wiki/indexes/"
/** The root index. */
export const ROOT_INDEX_PATH = "wiki/index.md"
/** The mechanism index. */
export const MECHANISM_INDEX_FILE = "_mechanisms.md"
export const MECHANISM_INDEX_PATH = `${DOMAIN_INDEX_DIR}${MECHANISM_INDEX_FILE}`

export const MECHANISM_TYPE = "mechanism"

/** The types that a domain index groups, in the order of its groups, with the heading of each group. */
const DOMAIN_INDEX_GROUPS = [
  { type: "source", heading: "Source" },
  { type: "entity", heading: "Entity" },
  { type: "concept", heading: "Concept" },
  { type: "comparison", heading: "Comparison" },
  { type: "query", heading: "Query" },
  { type: "hypothesis", heading: "Hypothesis" },
] as const

/** Shown for a page that has no type at all. */
const NO_TYPE_LABEL = "no type"

// --- paths -------------------------------------------------------------

/** File name of a domain index: the domain with `/` replaced by `--`. */
function domainIndexFileName(domain: string): string {
  return `${domain.replace(/\//g, "--")}.md`
}

/** `wiki/indexes/hardware--async-circuits.md` for `hardware/async-circuits`. */
export function domainIndexPath(domain: string): string {
  return `${DOMAIN_INDEX_DIR}${domainIndexFileName(domain)}`
}

/** True for a file in `wiki/indexes/`. These files are made by the app, so they are never pages. */
export function isDomainIndexPath(relativePath: string): boolean {
  return relativePath.replace(/\\/g, "/").toLowerCase().startsWith(DOMAIN_INDEX_DIR)
}

// --- reading a page ----------------------------------------------------

/** The page that `markdown` is, at `path`. */
export function indexedPageFromMarkdown(path: string, markdown: string): IndexedPage {
  const normalized = path.replace(/\\/g, "/")
  const slug = fileStem(normalized)
  const { frontmatter, body } = parseFrontmatter(markdown)
  const field = (key: string): string | null => {
    const value = frontmatter?.[key]
    if (typeof value !== "string") return null
    const trimmed = value.trim()
    return trimmed === "" ? null : trimmed
  }

  const type = field("type") ?? inferWikiTypeFromPath(normalized) ?? ""
  const heading = /^#[ \t]+(.+)$/m.exec(body)?.[1]
  const title = oneLine(field("title") ?? "") || oneLine(heading ?? "") || slug
  return {
    path: normalized,
    slug,
    type,
    title,
    // A hypothesis page has no `domain`. It belongs to the domain it points at.
    domain: type === "hypothesis" ? field("to_domain") : field("domain"),
  }
}

function fileStem(path: string): string {
  const name = path.slice(path.lastIndexOf("/") + 1)
  return name.toLowerCase().endsWith(".md") ? name.slice(0, -".md".length) : name
}

/** Collapse every run of white space to one space, so a title stays on one line. */
function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim()
}

// --- rendering ---------------------------------------------------------

export interface RootIndexOptions {
  /**
   * Show at most this many unassigned pages. The line `- Unassigned — N pages` still counts all
   * of them, and one more line says how many are left out. Without it, every page is listed.
   */
  maxUnassigned?: number
}

/**
 * `wiki/index.md`: a line for each domain of `domains.yaml` (sorted by path) with its
 * page count, then the mechanisms, then the pages that no listed domain holds.
 */
export function renderRootIndex(pages: IndexedPage[], domains: DomainsConfig, options: RootIndexOptions = {}): string {
  const listed = Object.keys(domains.domains).sort(compareText)
  const counts = new Map<string, number>(listed.map((domain) => [domain, 0]))
  const unassigned: IndexedPage[] = []
  let mechanisms = 0

  for (const page of pages) {
    if (page.type === MECHANISM_TYPE) {
      mechanisms += 1
    } else if (page.domain !== null && counts.has(page.domain) && groupsPage(page)) {
      counts.set(page.domain, (counts.get(page.domain) ?? 0) + 1)
    } else {
      unassigned.push(page)
    }
  }

  const sortedUnassigned = [...unassigned].sort(compareBySlug)
  const shown = options.maxUnassigned === undefined ? sortedUnassigned : sortedUnassigned.slice(0, options.maxUnassigned)
  const hidden = sortedUnassigned.length - shown.length

  return [
    "# Wiki Index",
    "",
    ...listed.map((domain) => `- [${domain}](indexes/${domainIndexFileName(domain)}) — ${counts.get(domain)} pages`),
    `- [Mechanisms](indexes/${MECHANISM_INDEX_FILE}) — ${mechanisms} pages`,
    `- Unassigned — ${unassigned.length} pages`,
    ...shown.map((page) => `  - [[${page.slug}]]${typeNote(page)}`),
    ...(hidden > 0 ? [`  - … ${hidden} more unassigned pages`] : []),
    "",
  ].join("\n")
}

/**
 * The index of one domain: its pages in a group for each type, with the groups in a
 * fixed order and the pages sorted by title. A domain without pages is a heading only.
 */
export function renderDomainIndex(domain: string, pages: IndexedPage[]): string {
  const own = pages.filter((page) => page.domain === domain && groupsPage(page))
  const lines = [`# ${domain}`]
  for (const group of DOMAIN_INDEX_GROUPS) {
    const members = own.filter((page) => page.type === group.type).sort(comparePages)
    if (members.length === 0) continue
    lines.push("", `## ${group.heading}`, "", ...members.map(pageLine))
  }
  return `${lines.join("\n")}\n`
}

/** The mechanism index: a line for each page of type `mechanism`, sorted by title. */
export function renderMechanismIndex(pages: IndexedPage[]): string {
  const mechanisms = pages.filter((page) => page.type === MECHANISM_TYPE).sort(comparePages)
  const lines = ["# Mechanisms"]
  if (mechanisms.length > 0) lines.push("", ...mechanisms.map(pageLine))
  return `${lines.join("\n")}\n`
}

/** True when a domain index has a group for the type of the page. */
function groupsPage(page: IndexedPage): boolean {
  return DOMAIN_INDEX_GROUPS.some((group) => group.type === page.type)
}

function pageLine(page: IndexedPage): string {
  return `- [[${page.slug}]] — ${page.title}`
}

/** The type of an unassigned page in parentheses, when the page's type is not one that the domain index groups. */
function typeNote(page: IndexedPage): string {
  return groupsPage(page) ? "" : ` (${page.type === "" ? NO_TYPE_LABEL : page.type})`
}

// --- order -------------------------------------------------------------

/** UTF-16 code unit order. Unlike `localeCompare`, it gives the same result on every machine. */
export function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

/** By slug, then path: the order of the unassigned list, which shows slugs only. */
function compareBySlug(a: IndexedPage, b: IndexedPage): number {
  return compareText(a.slug, b.slug) || compareText(a.path, b.path)
}

/** By title without case, then by title, slug, and path, so that no two pages tie. */
function comparePages(a: IndexedPage, b: IndexedPage): number {
  return (
    compareText(a.title.toLowerCase(), b.title.toLowerCase()) ||
    compareText(a.title, b.title) ||
    compareText(a.slug, b.slug) ||
    compareText(a.path, b.path)
  )
}
