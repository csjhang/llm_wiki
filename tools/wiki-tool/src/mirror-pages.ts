/**
 * The wiki pages that are mirrored to Heptabase, and the card body of each.
 *
 * plan-down uses this to decide what to send. record uses it to hash a body when the
 * event does not bring the hash. Reading is limited to `<project>/wiki/` and to the
 * snapshot files the card map names, and every path goes through resolveInProject.
 */
import { type Dirent, readdirSync, readFileSync } from "node:fs"
import { posix } from "node:path"
import { type FrontmatterValue, parseFrontmatter } from "@/lib/frontmatter"
import type { CardMap } from "./card-map"
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

/**
 * Every page under `wiki/`, sorted by path. The pages of the app are left out. A file that is
 * listed but cannot be read throws: a page that is merely unreadable must not look deleted.
 */
export function readWikiPages(project: string): WikiPage[] {
  const paths: string[] = []
  collectMarkdown(project, "wiki", paths)
  return paths.sort(compareText).map((path) => loadWikiPage(project, path))
}

function collectMarkdown(project: string, directory: string, found: string[]): void {
  let entries: Dirent[]
  try {
    entries = readdirSync(resolveInProject(project, directory), { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue
    const path = `${directory}/${entry.name}`
    if (entry.isDirectory()) {
      if (path.toLowerCase() !== SKIPPED_DIRECTORY) collectMarkdown(project, path, found)
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md") && !SKIPPED_PAGES.has(path.toLowerCase())) {
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
