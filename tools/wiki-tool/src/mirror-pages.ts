/**
 * The wiki pages that are mirrored to Heptabase, the card body and property values of each,
 * and the hash that the card map keeps for them.
 *
 * plan-down uses this to decide what to send. record uses it to hash a page when the event
 * does not bring the hash. Reading is limited to the project config files, `<project>/wiki/`,
 * and the snapshot files the card map names, and every path goes through resolveInProject.
 */
import { type Dirent, readdirSync, readFileSync, realpathSync, statSync } from "node:fs"
import { posix } from "node:path"
import { type FrontmatterValue, parseFrontmatter } from "@/lib/frontmatter"
import { type HeptabaseConfig, parseHeptabaseYaml, type PropertyKey } from "@/lib/wiki-config/heptabase-config"
import type { ParseResult } from "@/lib/wiki-config/types"
import { parseWikiYaml, type WikiIdentity } from "@/lib/wiki-config/wiki-identity"
import { type CardMap, contentHash } from "./card-map"
import { type LinkTarget, wikiPageToCard } from "./convert"
import { resolveInProject } from "./io"

/** Title prefix of a card whose page is gone. */
export const RETIRED_TITLE_PREFIX = "🗄 已停用｜"
/** Body of a card whose page is gone. No replacement is known. */
export const RETIRED_BODY = "此頁已從 wiki 移除。"

/** Page types that are always synced. A `concept` is synced when it has two sources. */
const ALWAYS_SYNCED_TYPES: readonly string[] = ["mechanism", "hypothesis", "comparison"]
const MIN_CONCEPT_SOURCES = 2

/** Pages that the app maintains; they are never synced. Lower case. */
const SKIPPED_PAGES = new Set(["wiki/index.md", "wiki/log.md", "wiki/overview.md"])
const SKIPPED_DIRECTORY = "wiki/indexes"

export interface WikiPage {
  /** Path from the project root, with `/`: `wiki/mechanisms/event-driven.md`. */
  path: string
  /** File stem: `event-driven`. */
  slug: string
  /** The `title` of the frontmatter, else the first `# ` heading, else the slug. */
  title: string
  /** The `type` of the frontmatter; "" when there is none. */
  type: string
  /** The distinct names in the `sources` of the frontmatter. */
  sources: string[]
  /** False when the page has no frontmatter, or the frontmatter is not valid YAML. */
  hasFrontmatter: boolean
  frontmatter: Record<string, FrontmatterValue>
  /** The text of the file. */
  markdown: string
}

/** Orders text by code unit, the same on every machine. */
export function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim()
}

/** The file stem of a page path: `event-driven` for `wiki/mechanisms/event-driven.md`. */
export function slugOfPath(path: string): string {
  return fileStem(path)
}

function fileStem(path: string): string {
  const name = posix.basename(path)
  return name.toLowerCase().endsWith(".md") ? name.slice(0, -".md".length) : name
}

export function parseWikiPage(path: string, markdown: string): WikiPage {
  const text = markdown.replace(/^\uFEFF/, "")
  const { frontmatter, body } = parseFrontmatter(text)
  const field = (key: string): string => {
    const value = frontmatter?.[key]
    return typeof value === "string" ? value.trim() : ""
  }
  const slug = fileStem(path)
  const heading = /^#[ \t]+(.+)$/m.exec(body)?.[1] ?? ""
  return {
    path,
    slug,
    title: oneLine(field("title")) || oneLine(heading) || slug,
    type: field("type"),
    sources: sourceNames(frontmatter?.sources),
    hasFrontmatter: frontmatter !== null,
    frontmatter: frontmatter ?? {},
    markdown: text,
  }
}

function sourceNames(value: FrontmatterValue | undefined): string[] {
  const items = Array.isArray(value) ? value : typeof value === "string" ? [value] : []
  return [...new Set(items.map((item) => item.trim()).filter((item) => item !== ""))]
}

/** True for a page that is mirrored: mechanism, hypothesis, comparison, or a concept with two sources. */
export function isSyncable(page: WikiPage): boolean {
  if (ALWAYS_SYNCED_TYPES.includes(page.type)) return true
  return page.type === "concept" && page.sources.length >= MIN_CONCEPT_SOURCES
}

/** The page at a project-relative path, or null when the file cannot be read. */
export function readWikiPage(project: string, path: string): WikiPage | null {
  try {
    return loadWikiPage(project, path)
  } catch {
    return null
  }
}

function loadWikiPage(project: string, path: string): WikiPage {
  return parseWikiPage(path, readFileSync(resolveInProject(project, path), "utf8"))
}

export interface ReadPagesOptions {
  /** Accept a project that has no `wiki/` folder at all. Any other read error still throws. */
  allowMissingWiki?: boolean
}

/**
 * Every page under `wiki/`, sorted by path. The pages of the app are left out. A folder or file that
 * cannot be read throws: a page that is merely unreadable must not look deleted. Links to files and
 * folders are followed; a link that leads nowhere is skipped, and a folder is read once.
 */
export function readWikiPages(project: string, options: ReadPagesOptions = {}): WikiPage[] {
  const paths: string[] = []
  const root = resolveInProject(project, "wiki")
  const visited = new Set<string>()
  try {
    visited.add(realpathSync(root))
  } catch (error) {
    if (options.allowMissingWiki && errorCode(error) === "ENOENT") return []
    throw error
  }
  collectMarkdown(project, "wiki", visited, paths)
  return paths.sort(compareText).map((path) => loadWikiPage(project, path))
}

function errorCode(error: unknown): string | undefined {
  return error instanceof Error ? (error as NodeJS.ErrnoException).code : undefined
}

function collectMarkdown(project: string, directory: string, visited: Set<string>, found: string[]): void {
  const entries: Dirent[] = readdirSync(resolveInProject(project, directory), { withFileTypes: true })
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue
    const path = `${directory}/${entry.name}`
    const absolute = resolveInProject(project, path)
    let stats
    try {
      stats = statSync(absolute)
    } catch (error) {
      // A link that leads nowhere has no page to read.
      if (errorCode(error) === "ENOENT") continue
      throw error
    }
    if (stats.isDirectory()) {
      if (path.toLowerCase() === SKIPPED_DIRECTORY) continue
      const real = realpathSync(absolute)
      if (visited.has(real)) continue
      visited.add(real)
      collectMarkdown(project, path, visited, found)
    } else if (stats.isFile() && entry.name.toLowerCase().endsWith(".md") && !SKIPPED_PAGES.has(path.toLowerCase())) {
      found.push(path)
    }
  }
}

/** Renders the card body of pages, against the pages that already have a card. */
export interface MirrorRenderer {
  /**
   * The body of the card of `page`. A link to a page that has a card is a card link; the slugs
   * in `unresolved` are written as if they had none. `onResolved` is called with each slug that
   * became a card link.
   */
  render(page: WikiPage, unresolved?: ReadonlySet<string>, onResolved?: (slug: string) => void): string
}

/**
 * A renderer for the pages of a wiki. A link is a card link when the page it names is
 * synced and its map entry is active. `skipPaths` are pages to treat as not mapped.
 */
export function createRenderer(
  project: string,
  map: CardMap,
  pages: readonly WikiPage[],
  skipPaths: ReadonlySet<string> = new Set(),
): MirrorRenderer {
  const linkable = new Map<string, LinkTarget>()
  const titles = new Map<string, string>()
  for (const page of pages) {
    if (!titles.has(page.slug)) titles.set(page.slug, page.title)
    const entry = map.pages[page.path]
    if (!entry || entry.status !== "active" || skipPaths.has(page.path) || !isSyncable(page)) continue
    if (!linkable.has(page.slug)) linkable.set(page.slug, { cardId: entry.card_id, title: page.title })
  }

  const cardsByName = sourceCardsByName(project, map)
  return {
    render(page, unresolved = new Set(), onResolved) {
      return wikiPageToCard(page.markdown, {
        title: page.title,
        resolveLink: (slug) => {
          const target = unresolved.has(slug) ? undefined : linkable.get(slug)
          if (!target) return null
          onResolved?.(slug)
          return target
        },
        titleForSlug: (slug) => titles.get(slug) ?? slug,
        sourceCards: sourceCardsOf(page, cardsByName),
      })
    },
  }
}

/** The cards of the sources of a page, once each, in the order of the sources. */
function sourceCardsOf(page: WikiPage, cardsByName: ReadonlyMap<string, LinkTarget>): LinkTarget[] {
  const cards = new Map<string, LinkTarget>()
  for (const name of page.sources) {
    const card = cardsByName.get(posix.basename(name))
    if (card) cards.set(card.cardId, card)
  }
  return [...cards.values()]
}

/** The source cards of the footer, by the file name of their snapshot. */
function sourceCardsByName(project: string, map: CardMap): Map<string, LinkTarget> {
  const byName = new Map<string, LinkTarget>()
  for (const cardId of Object.keys(map.sources).sort(compareText)) {
    const rawPath = map.sources[cardId].raw_path
    const name = posix.basename(rawPath)
    if (!byName.has(name)) byName.set(name, { cardId, title: snapshotTitle(project, rawPath) })
  }
  return byName
}

/** The `title` of a snapshot file; the file stem when the file has none or cannot be read. */
function snapshotTitle(project: string, rawPath: string): string {
  try {
    const { frontmatter } = parseFrontmatter(readFileSync(resolveInProject(project, rawPath), "utf8"))
    const title = frontmatter?.title
    if (typeof title === "string" && oneLine(title) !== "") return oneLine(title)
  } catch {
    // The file is missing or outside the project: use the name.
  }
  return fileStem(rawPath)
}

// --- config ------------------------------------------------------------

export interface ProjectConfig {
  heptabase: HeptabaseConfig
  wiki: WikiIdentity
}

/**
 * heptabase.yaml and wiki.yaml of a project. Every issue of a parser becomes a problem, and a
 * file that cannot be read does too. Returns null when there is any problem.
 */
export function readProjectConfig(project: string, problems: string[]): ProjectConfig | null {
  const heptabase = readConfigFile(project, "heptabase.yaml", parseHeptabaseYaml, problems)
  const wiki = readConfigFile(project, "wiki.yaml", parseWikiYaml, problems)
  return heptabase && wiki ? { heptabase, wiki } : null
}

function readConfigFile<T>(
  project: string,
  name: string,
  parse: (text: string) => ParseResult<T>,
  problems: string[],
): T | null {
  const path = resolveInProject(project, name)
  let text: string
  try {
    text = readFileSync(path, "utf8").replace(/^\uFEFF/, "")
  } catch {
    problems.push(`cannot read ${name}: ${path}`)
    return null
  }
  const result = parse(text)
  if (result.ok) return result.value
  for (const issue of result.issues) {
    problems.push(`invalid ${name}: ${issue.path === "" ? "" : `${issue.path}: `}${issue.message}`)
  }
  return null
}

// --- properties and hash -----------------------------------------------

export interface PropertyEdit {
  propertyId: string
  type: "select" | "text" | "date"
  /** A select value is the option name, a text value a string, a date value `{ start: <ISO time> }`. */
  value: unknown
}

export type EditEntry = readonly [PropertyKey, PropertyEdit["type"], unknown]

/** The edits of the properties that heptabase.yaml names, for the values that are not null. */
export function editsOf(ids: HeptabaseConfig["properties"], entries: readonly EditEntry[]): PropertyEdit[] {
  const edits: PropertyEdit[] = []
  for (const [key, type, value] of entries) {
    const propertyId = ids[key]
    if (propertyId !== undefined && value !== null) edits.push({ propertyId, type, value })
  }
  return edits
}

export function frontmatterText(page: WikiPage, key: string): string | null {
  const value = page.frontmatter[key]
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null
}

/**
 * The properties of an active card: domain (not for a mechanism; `to_domain` for a hypothesis),
 * page type, wiki, status, page path, and for a hypothesis its status and strength. `last synced`
 * is added only when `syncedOn` is given: it changes on every sync, so it is not part of the hash.
 */
export function pageProperties(
  page: WikiPage,
  config: { properties: HeptabaseConfig["properties"]; wikiId: string },
  syncedOn?: { start: string },
): PropertyEdit[] {
  const domain =
    page.type === "mechanism" ? null : frontmatterText(page, page.type === "hypothesis" ? "to_domain" : "domain")
  const entries: EditEntry[] = [
    ["domain", "select", domain],
    ["page_type", "select", page.type],
    ["wiki", "select", config.wikiId],
    ["status", "select", "active"],
    ["wiki_page", "text", page.path],
  ]
  if (syncedOn) entries.push(["last_synced", "date", syncedOn])
  if (page.type === "hypothesis") {
    entries.push(["hypothesis_status", "select", frontmatterText(page, "status")])
    entries.push(["strength", "select", frontmatterText(page, "strength")])
  }
  return editsOf(config.properties, entries)
}

/**
 * The hash that the card map keeps for a card: the card body and the property values, without the
 * sync date. A change of either one makes the hash another one.
 */
export function cardHash(body: string, properties: readonly PropertyEdit[]): string {
  const values = properties.map(({ propertyId, type, value }) => ({ propertyId, type, value }))
  return contentHash(JSON.stringify({ body, properties: values }))
}
