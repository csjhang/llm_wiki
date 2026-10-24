/**
 * Test helpers for the commands that read a wiki project: plan-down and record.
 *
 * makeProject writes a project folder with wiki.yaml, heptabase.yaml, and the given files.
 * Ids are placeholders (00000000-0000-4000-8000-0000000000NN) and titles are generic.
 * Not part of the bundle: only test files import it.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { loadCardMap } from "./card-map"

export function id(n: number): string {
  return `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`
}

/** The property ids of the fixture database (fixtures/read_database.json), by heptabase.yaml key. */
export const PROPERTY_IDS = {
  domain: id(42),
  page_type: id(45),
  wiki: id(50),
  status: id(54),
  wiki_page: id(57),
  last_synced: id(58),
  hypothesis_status: id(59),
  strength: id(64),
}

const tempDirs: string[] = []

export function removeProjects(): void {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop() as string, { recursive: true, force: true })
  }
}

export function writeProjectFile(project: string, relativePath: string, text: string): void {
  const path = join(project, relativePath)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text)
}

export interface ProjectOptions {
  /** The `id` of wiki.yaml. The fixture database has the options reading, work, and test. */
  wikiId?: string
  /** Leave heptabase.yaml out. */
  noHeptabaseYaml?: boolean
  /** The `roots` of heptabase.yaml. The default is the one root `id(12)`. */
  roots?: string[]
  /** The mirror tag of heptabase.yaml. The default is `id(4)`. */
  mirrorTag?: string
  /** The `other_wiki_roots` of heptabase.yaml. The default is none. */
  otherRoots?: string[]
  /** The `whiteboards` of heptabase.yaml: whiteboard id to its inline settings, such as `{ kind: archive }`. */
  boards?: Record<string, string>
}

/** A project folder with the config files and `files` (project-relative path to text). */
export function makeProject(files: Record<string, string> = {}, options: ProjectOptions = {}): string {
  const project = mkdtempSync(join(tmpdir(), "wiki-tool-mirror-"))
  tempDirs.push(project)
  writeProjectFile(project, "wiki.yaml", `version: 1\nid: ${options.wikiId ?? "test"}\nrole: reading\n`)
  if (!options.noHeptabaseYaml) {
    const properties = Object.entries(PROPERTY_IDS).map(([key, value]) => `  ${key}: ${value}`)
    const roots = (options.roots ?? [id(12)]).map((root) => `  - ${root}`)
    const boards = Object.entries(options.boards ?? {}).map(([board, settings]) => `  ${board}: ${settings}`)
    const otherRoots = options.otherRoots ?? []
    const lines = [
      "version: 1",
      "roots:",
      ...roots,
      ...(otherRoots.length > 0 ? ["other_wiki_roots:", ...otherRoots.map((root) => `  - ${root}`)] : []),
      ...(boards.length > 0 ? ["whiteboards:", ...boards] : []),
      "tags:",
      `  ingest: ${id(5)}`,
      `  mirror: ${options.mirrorTag ?? id(4)}`,
    ]
    writeProjectFile(project, "heptabase.yaml", [...lines, "properties:", ...properties, ""].join("\n"))
  }
  for (const [path, text] of Object.entries(files)) writeProjectFile(project, path, text)
  return project
}

/** A wiki page: the frontmatter fields (strings and lists of strings) and a body. */
export function pageText(fields: Record<string, string | string[]>, body = "Body text."): string {
  const lines = ["---"]
  for (const [key, value] of Object.entries(fields)) {
    lines.push(`${key}: ${Array.isArray(value) ? `[${value.map((item) => JSON.stringify(item)).join(", ")}]` : JSON.stringify(value)}`)
  }
  lines.push("---", "", body, "")
  return lines.join("\n")
}

/** A list_cards text of the mirror tag: one line per card. */
export function mirrorList(cards: { id: string; title: string; updated: string }[]): string {
  const lines = cards.map(
    (card) =>
      `card "${card.title}" [${card.id}] whiteboards: none, tags: wiki-test [${id(4)}], created: 2026-09-01T00:00:00.000Z; updated: ${card.updated}`,
  )
  return lines.length === 0 ? "No cards found." : ["Cards:", ...lines].join("\n")
}

/**
 * The `--mirror-cards` option for a project, as the skill would pass it when nobody touched the cards: the list holds
 * every card of the map (a card that waits for setup is not in the tag yet), last updated when the map saw it. Empty
 * when the map has no active card, because plan-down needs no list then.
 */
export function quietMirrorArgs(project: string): string[] {
  const entries = Object.values(loadCardMap(project).pages)
  if (!entries.some((entry) => entry.status === "active")) return []
  const cards = entries
    .filter((entry) => !entry.setup_pending)
    .map((entry) => ({ id: entry.card_id, title: "Card", updated: entry.card_updated_at }))
  writeProjectFile(project, ".llm-wiki/hepta/quiet-mirror.txt", mirrorList(cards))
  return ["--mirror-cards", join(project, ".llm-wiki/hepta/quiet-mirror.txt")]
}

/** A saved read_object result: the header line and the numbered lines of `text`, in a JSON envelope. Returns its path. */
export function cardFile(project: string, name: string, text: string, cardId = id(21), title = "Event Driven"): string {
  const lines = text.split("\n")
  const content = [`card "${title}" [${cardId}] ${lines.length} lines`, ...lines.map((line, index) => `${index + 1}\t${line}`)].join("\n")
  writeProjectFile(project, `.llm-wiki/hepta/${name}`, JSON.stringify({ content, totalLines: lines.length, status: "succeeded" }))
  return join(project, `.llm-wiki/hepta/${name}`)
}
