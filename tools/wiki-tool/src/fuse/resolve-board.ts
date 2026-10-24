/**
 * `wiki-tool fuse resolve-board` - say what each card of a fusion whiteboard is in the wikis.
 *
 * The skill reads the whiteboard (`read_whiteboard`, structure view) and each mind map on it (`read_object`), saves
 * the results to files, and runs this command. The command never calls Heptabase. It lists the cards of the board,
 * each with its section and side, and resolves each card against the card map of this wiki and of the wikis named
 * with `--wiki` (for example the reading wiki, seen from a work wiki):
 *
 * - `mirror`: the card is the mirror card of a wiki page (the card id is in `pages` of a card map); `pages` is that
 *   page path.
 * - `ingested`: the card was snapshotted into a wiki (the card id is in `sources`); `pages` are the pages of that wiki
 *   whose frontmatter `sources` names the snapshot file (`<card-id>.md`). There can be none yet.
 * - `not-ingested`: no wiki knows the card.
 *
 * `wiki` is the `id` of `wiki.yaml` of the wiki that answered, and `pages` are paths inside that wiki. When more than
 * one wiki knows a card, a mirror card wins over a snapshot, and the first wiki wins (this project, then the `--wiki`
 * options in order).
 *
 * A section whose title starts with `來源`, `Source`, or `source` is the source side; `目標`, `Target`, or `target` is
 * the target side. A mind map joins the section that holds it, so its cards get that section and side. `pairing` lists
 * the card ids of each side, and exists only when both sides have a card; otherwise it is null and the skill asks.
 *
 * The other wikis are only read: nothing is written in any wiki.
 */
import { readFileSync } from "node:fs"
import { posix, resolve } from "node:path"
import { parseWikiYaml } from "@/lib/wiki-config/wiki-identity"
import { parseArgs } from "../args"
import { type CardMap, loadCardMap } from "../card-map"
import { type CommandResult, isDirectory, resolveInProject } from "../io"
import { compareText, readWikiPages } from "../mirror-pages"
import {
  failedStatus,
  parseMindMap,
  parseMindMapHeader,
  parseWhiteboardStructure,
  type WhiteboardStructure,
} from "../parse-mcp"

export interface BoardCard {
  cardId: string
  title: string
  /** The title of the section that holds the card (or its mind map); null for a card outside every section. */
  section: string | null
  side: "source" | "target" | null
  status: "mirror" | "ingested" | "not-ingested"
  /** The `id` of `wiki.yaml` of the wiki that knows the card; null when `status` is `not-ingested`. */
  wiki: string | null
  /** Page paths inside that wiki. */
  pages: string[]
}

export interface BoardContext {
  boardId: string
  boardTitle: string
  pairing: { source: string[]; target: string[] } | null
  cards: BoardCard[]
}

const OPTION_SPEC = {
  values: ["project", "structure"],
  lists: ["mindmap", "wiki"],
} as const

const SOURCE_PREFIXES = ["來源", "Source", "source"]
const TARGET_PREFIXES = ["目標", "Target", "target"]

/** A wiki project and what the command reads of it. */
interface Wiki {
  id: string
  path: string
  map: CardMap
}

type Side = BoardCard["side"]

interface Section {
  id: string
  title: string
}

export function resolveBoard(args: string[]): CommandResult {
  const { parsed, problems: optionProblems } = parseArgs(args, OPTION_SPEC)
  const problems = [...optionProblems]
  const project = parsed.values.project
  const structurePath = parsed.values.structure
  if (project === undefined) problems.push("missing option: --project")
  if (structurePath === undefined) problems.push("missing option: --structure")
  if (problems.length > 0 || project === undefined || structurePath === undefined) return { ok: false, problems }
  if (!isDirectory(project)) return { ok: false, problems: [`project folder not found: ${project}`] }

  const wikis = readWikis(project, parsed.lists.wiki, problems)
  const structureText = readResultFile(structurePath, "--structure", problems)
  const mindMapTexts = parsed.lists.mindmap.map((path) => ({ path, text: readResultFile(path, "--mindmap", problems) }))
  if (problems.length > 0 || !wikis || structureText === null) return { ok: false, problems }

  let structure: WhiteboardStructure
  try {
    structure = parseWhiteboardStructure(structureText)
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    return { ok: false, problems: [`--structure file ${structurePath} cannot be read: ${reason}`] }
  }
  const mindMapCards = groupMindMapCards(structure, mindMapTexts, problems)
  if (problems.length > 0) return { ok: false, problems }

  const warnings = structure.mindMaps
    .filter((mindMap) => !mindMapCards.has(mindMap.id.toLowerCase()))
    .map((mindMap) => `mind map "${mindMap.title}" [${mindMap.id}] has no --mindmap file; its cards are not listed`)
  const placed = placeCards(structure, mindMapCards)
  const cards = resolveCards(placed, wikis, problems)
  if (!cards) return { ok: false, problems }

  const sideIds = (side: Side): string[] => [...new Set(cards.filter((card) => card.side === side).map((card) => card.cardId))]
  const source = sideIds("source")
  const target = sideIds("target")
  const context: BoardContext = {
    boardId: structure.id,
    boardTitle: structure.title,
    pairing: source.length > 0 && target.length > 0 ? { source, target } : null,
    cards,
  }
  return { ok: true, ...context, warnings }
}

// --- inputs --------------------------------------------------------------

/** The text of a saved MCP result. A file that cannot be read, or whose JSON `status` is not `succeeded`, is a problem. */
function readResultFile(path: string, option: string, problems: string[]): string | null {
  let text: string
  try {
    text = readFileSync(path, "utf8")
  } catch {
    problems.push(`cannot read ${option} file: ${path}`)
    return null
  }
  const status = failedStatus(text)
  if (status !== null) {
    problems.push(`${option} file ${path} is the result of a call that did not succeed (status: ${status})`)
    return null
  }
  return text
}

/**
 * This project, then the `--wiki` projects, without repeats. Null when a wiki cannot be read; the problems say which.
 * A wiki needs a valid `wiki.yaml`; a wiki without a card map has an empty one.
 */
function readWikis(project: string, others: readonly string[], problems: string[]): Wiki[] | null {
  const before = problems.length
  const wikis: Wiki[] = []
  const seen = new Set<string>()
  for (const path of [project, ...others]) {
    const key = resolve(path)
    if (seen.has(key)) continue
    seen.add(key)
    const wiki = readWiki(path, problems)
    if (wiki) wikis.push(wiki)
  }
  return problems.length > before ? null : wikis
}

function readWiki(path: string, problems: string[]): Wiki | null {
  if (!isDirectory(path)) {
    problems.push(`wiki folder not found: ${path}`)
    return null
  }
  const yamlPath = resolveInProject(path, "wiki.yaml")
  let text: string
  try {
    text = readFileSync(yamlPath, "utf8").replace(/^﻿/, "")
  } catch {
    problems.push(`cannot read wiki.yaml: ${yamlPath}`)
    return null
  }
  const identity = parseWikiYaml(text)
  if (!identity.ok) {
    for (const issue of identity.issues) {
      problems.push(`invalid wiki.yaml (${yamlPath}): ${issue.path === "" ? "" : `${issue.path}: `}${issue.message}`)
    }
    return null
  }
  try {
    return { id: identity.value.id, path, map: loadCardMap(path) }
  } catch (error) {
    problems.push(`wiki ${path}: ${error instanceof Error ? error.message : String(error)}`)
    return null
  }
}

/**
 * The cards of each mind map file, by mind map id (lower case). The header of a file says which mind map it is;
 * a file that is not a mind map, or is one that is not on the board, is a problem. Files of the same mind map
 * (a mind map that came in pages) are joined.
 */
function groupMindMapCards(
  structure: WhiteboardStructure,
  files: readonly { path: string; text: string | null }[],
  problems: string[],
): Map<string, { id: string; title: string }[]> {
  const onBoard = new Set(structure.mindMaps.map((mindMap) => mindMap.id.toLowerCase()))
  const byMindMap = new Map<string, { id: string; title: string }[]>()
  for (const { path, text } of files) {
    if (text === null) continue
    const header = parseMindMapHeader(text)
    if (!header) {
      problems.push(`--mindmap file ${path} is not the result of read_object for a mind map`)
      continue
    }
    const key = header.id.toLowerCase()
    if (!onBoard.has(key)) {
      problems.push(`--mindmap file ${path} is mind map ${header.id}, which is not on board ${structure.id}`)
      continue
    }
    byMindMap.set(key, [...(byMindMap.get(key) ?? []), ...parseMindMap(text)])
  }
  return byMindMap
}

// --- cards of the board --------------------------------------------------

interface PlacedCard {
  cardId: string
  title: string
  section: string | null
  side: Side
}

function sideOf(title: string): Side {
  const text = title.trimStart()
  if (SOURCE_PREFIXES.some((prefix) => text.startsWith(prefix))) return "source"
  if (TARGET_PREFIXES.some((prefix) => text.startsWith(prefix))) return "target"
  return null
}

/**
 * The cards of the board in reading order: for each section its cards, then the cards of its mind maps; then the
 * cards outside every section, then those of the mind maps outside every section. A card is listed once for each
 * section that holds it.
 */
function placeCards(structure: WhiteboardStructure, mindMapCards: ReadonlyMap<string, { id: string; title: string }[]>): PlacedCard[] {
  const placed: PlacedCard[] = []
  const seen = new Set<string>()
  const add = (cards: readonly { id: string; title: string }[], section: Section | null): void => {
    for (const card of cards) {
      const key = `${section?.id ?? ""}|${card.id.toLowerCase()}`
      if (seen.has(key)) continue
      seen.add(key)
      placed.push({ cardId: card.id, title: card.title, section: section?.title ?? null, side: section ? sideOf(section.title) : null })
    }
  }
  const addMindMaps = (section: Section | null): void => {
    for (const mindMap of structure.mindMaps) {
      if (mindMap.sectionId === (section?.id ?? null)) add(mindMapCards.get(mindMap.id.toLowerCase()) ?? [], section)
    }
  }
  for (const section of structure.sections) {
    add(section.cards, section)
    addMindMaps(section)
  }
  add(structure.unsectioned, null)
  addMindMaps(null)
  return placed
}

// --- the wikis -----------------------------------------------------------

/** A card is the mirror card of pages of one wiki, or the snapshot `fileName` of one wiki. */
interface MirrorHit {
  wiki: Wiki
  pages: string[]
}

interface SourceHit {
  wiki: Wiki
  fileName: string
}

/** Resolve each card against the wikis. Null, with the problems, when the pages of a wiki cannot be read. */
function resolveCards(placed: readonly PlacedCard[], wikis: readonly Wiki[], problems: string[]): BoardCard[] | null {
  const mirrors = new Map<string, MirrorHit>()
  const sources = new Map<string, SourceHit>()
  for (const wiki of wikis) {
    for (const [pagePath, entry] of Object.entries(wiki.map.pages)) {
      const key = entry.card_id.toLowerCase()
      const hit = mirrors.get(key) ?? { wiki, pages: [] }
      mirrors.set(key, hit)
      if (hit.wiki === wiki) hit.pages.push(pagePath)
    }
    for (const [cardId, entry] of Object.entries(wiki.map.sources)) {
      if (!sources.has(cardId.toLowerCase())) sources.set(cardId.toLowerCase(), { wiki, fileName: posix.basename(entry.raw_path) })
    }
  }

  const pageIndex = new Map<Wiki, ReadonlyMap<string, string[]>>()
  const citingPages = (hit: SourceHit): string[] => {
    let index = pageIndex.get(hit.wiki)
    if (!index) {
      index = indexPagesBySource(hit.wiki, problems)
      pageIndex.set(hit.wiki, index)
    }
    return index.get(hit.fileName) ?? []
  }

  const cards = placed.map((card): BoardCard => {
    const key = card.cardId.toLowerCase()
    const mirror = mirrors.get(key)
    if (mirror) return { ...card, status: "mirror", wiki: mirror.wiki.id, pages: mirror.pages.sort(compareText) }
    const source = sources.get(key)
    if (source) return { ...card, status: "ingested", wiki: source.wiki.id, pages: citingPages(source) }
    return { ...card, status: "not-ingested", wiki: null, pages: [] }
  })
  return problems.length > 0 ? null : cards
}

/** The pages of a wiki by the file name of each snapshot their frontmatter `sources` names. Paths are sorted. */
function indexPagesBySource(wiki: Wiki, problems: string[]): Map<string, string[]> {
  const index = new Map<string, string[]>()
  try {
    for (const page of readWikiPages(wiki.path, { allowMissingWiki: true })) {
      for (const name of new Set(page.sources.map((source) => posix.basename(source)))) {
        index.set(name, [...(index.get(name) ?? []), page.path])
      }
    }
  } catch (error) {
    problems.push(`cannot read the pages of wiki ${wiki.id} (${wiki.path}): ${error instanceof Error ? error.message : String(error)}`)
  }
  return index
}
