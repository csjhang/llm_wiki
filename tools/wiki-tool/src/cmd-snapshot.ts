/**
 * `wiki-tool hepta snapshot` - save a Heptabase card as a source of the wiki.
 *
 * The skill reads the card with `read_object`, saves the result to a file, and runs this command. The
 * command writes `raw/sources/heptabase/<card-id>.md`: frontmatter, then the card as plain Markdown. It
 * records the snapshot in the card map, so `plan-up` plans the card again only after the card changes.
 * Snapshotting a card again replaces the file; the app ingests the new text again. A file that is already
 * there is replaced only when it is known to be this card's snapshot: the map names it as the source of the
 * card, or its frontmatter names the card. Any other file stops the command.
 *
 * `--content` is the read_object result. A card that is longer than one page comes in several results:
 * give one `--content` for each, and the command joins them in line order. A file that is not a
 * read_object result is the card's text as it is. A result of a failed call, or of another card, is refused.
 *
 * `source_kind` is `article` for a web card, a PDF card, or a card on a `source` whiteboard; else `note`.
 * `domain` is the domain of domains.yaml whose hinted whiteboard is nearest to the card: a whiteboard of the
 * card (distance 0), else its parent (1), and so on up. Two domains at the nearest distance give no domain.
 * The file and then the map are written atomically.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { parseFrontmatter } from "@/lib/frontmatter"
import { KNOWN_LENSES, parseDomainsYaml } from "@/lib/wiki-config/domains"
import { UUID_PATTERN } from "@/lib/wiki-config/types"
import { isRecord } from "@/lib/wiki-config/yaml-util"
import { parseArgs, parseNowOption } from "./args"
import { type CardMap, loadCardMap, saveCardMap } from "./card-map"
import { parentIndex, whiteboardChain } from "./cmd-plan-up"
import { cardToSnapshotBody } from "./convert"
import { type CommandResult, isDirectory, resolveInProject, writeFileAtomic } from "./io"
import { readHeptabaseConfig } from "./mirror-pages"
import { readContentFiles } from "./read-content"

const OPTION_SPEC = {
  values: ["project", "card-id", "title", "card-type", "whiteboards", "url", "updated-at", "now"],
  // One file for each page of the read_object result.
  lists: ["content"],
} as const

const SNAPSHOT_DIRECTORY = "raw/sources/heptabase"
const DOMAINS_FILE = "domains.yaml"
const LENSES_DIRECTORY = "lenses"
/** The card types whose source is an article by an outside author. */
const ARTICLE_TYPES: readonly string[] = ["webCard", "pdfCard"]
const KEYWORD_PATTERN = /^[A-Za-z][A-Za-z0-9_]*$/

interface Board {
  id: string
  title: string
}

export function snapshot(args: string[]): CommandResult {
  const { parsed, problems: optionProblems } = parseArgs(args, OPTION_SPEC)
  const problems = [...optionProblems]
  for (const name of ["project", "card-id", "title", "card-type", "whiteboards"] as const) {
    if (parsed.values[name] === undefined) problems.push(`missing option: --${name}`)
  }
  if (parsed.lists.content.length === 0) problems.push("missing option: --content")
  const project = parsed.values.project
  if (problems.length > 0 || project === undefined) return { ok: false, problems }
  if (!isDirectory(project)) return { ok: false, problems: [`project folder not found: ${project}`] }

  const cardId = parsed.values["card-id"]
  if (!UUID_PATTERN.test(cardId)) problems.push(`--card-id must be a card id (a lowercase UUID): ${cardId}`)
  const title = parsed.values.title
  if (title.trim() === "") problems.push("--title must not be empty")
  const cardType = parsed.values["card-type"]
  if (!KEYWORD_PATTERN.test(cardType)) problems.push(`--card-type must be a card type such as card or webCard: ${cardType}`)
  const boards = readBoards(parsed.values.whiteboards, problems)
  const url = parsed.values.url?.trim() === "" ? undefined : parsed.values.url
  const updatedAt = readUpdatedAt(parsed.values["updated-at"], problems)
  const now = parseNowOption(parsed.values.now, problems)
  const text = readContentFiles(parsed.lists.content, UUID_PATTERN.test(cardId) ? cardId : null, problems)
  const config = readHeptabaseConfig(project, problems)
  let map: CardMap | null = null
  try {
    map = loadCardMap(project)
  } catch (error) {
    problems.push(error instanceof Error ? error.message : String(error))
  }
  if (map && UUID_PATTERN.test(cardId)) {
    const mirror = Object.entries(map.pages).find(([, entry]) => entry.card_id === cardId)
    if (mirror) problems.push(`card ${cardId} is the card of ${mirror[0]}; a mirror card is not a source`)
  }
  if (problems.length > 0 || !boards || !config || !map || !now || text === null) return { ok: false, problems }

  const warnings: string[] = []
  const parents = parentIndex(map.whiteboards_cache.items)
  const onSourceBoard = boards.some((board) => config.whiteboards[board.id]?.kind === "source")
  const sourceKind = ARTICLE_TYPES.includes(cardType) || onSourceBoard ? "article" : "note"
  const domain = domainOf(project, boards, parents, warnings)
  const cardUpdatedAt = updatedAt ?? now.toISOString()

  const rawPath = `${SNAPSHOT_DIRECTORY}/${cardId}.md`
  const frontmatter = [
    "---",
    `title: ${yamlString(title)}`,
    `heptabase_card_id: ${cardId}`,
    `heptabase_whiteboards: [${boards.map((board) => yamlString(board.title)).join(", ")}]`,
    `card_updated_at: ${yamlString(cardUpdatedAt)}`,
    ...(url === undefined ? [] : [`url: ${yamlString(url)}`]),
    `source_kind: ${sourceKind}`,
    ...(domain === null ? [] : [`domain: ${yamlString(domain)}`]),
    "---",
  ]
  const refusal = overwriteProblem(project, rawPath, cardId, map)
  if (refusal) return { ok: false, problems: [refusal] }
  const body = cardToSnapshotBody(text).replace(/\s+$/, "")
  // The file goes first: if the map fails to save, a rerun writes the same file again.
  writeFileAtomic(resolveInProject(project, rawPath), `${(body === "" ? frontmatter : [...frontmatter, "", body]).join("\n")}\n`)
  map.sources[cardId] = { raw_path: rawPath, card_updated_at: cardUpdatedAt, ingest_commit: null }
  saveCardMap(project, map)
  return { ok: true, card_id: cardId, written: rawPath, source_kind: sourceKind, domain, warnings }
}

/** The `--whiteboards` JSON: a list of `{ id, title }`. */
function readBoards(value: string | undefined, problems: string[]): Board[] | null {
  if (value === undefined) return null
  let raw: unknown
  try {
    raw = JSON.parse(value)
  } catch (error) {
    problems.push(`--whiteboards is not valid JSON: ${error instanceof Error ? error.message : String(error)}`)
    return null
  }
  const boards: Board[] = []
  if (Array.isArray(raw)) {
    for (const item of raw) {
      if (isRecord(item) && typeof item.id === "string" && UUID_PATTERN.test(item.id) && typeof item.title === "string") {
        boards.push({ id: item.id, title: item.title })
      }
    }
  }
  if (!Array.isArray(raw) || boards.length !== raw.length) {
    problems.push('--whiteboards must be a JSON list of { "id": <whiteboard id>, "title": <text> }')
    return null
  }
  return boards
}

/** An ISO date and time; the text is kept as it is. */
function readUpdatedAt(value: string | undefined, problems: string[]): string | undefined {
  if (value === undefined) return undefined
  if (/^\d{4}-\d{2}-\d{2}/.test(value) && !Number.isNaN(Date.parse(value))) return value
  problems.push(`--updated-at must be an ISO date and time, such as 2026-10-24T08:00:00Z: ${value}`)
  return undefined
}

/**
 * A problem when the snapshot file is there and is not known to be this card's: a file of the user, or of another card,
 * must not be replaced. It is this card's when the map records this very path as the source of the card, or when its
 * frontmatter names the card. A source recorded at another path says nothing about this file.
 */
function overwriteProblem(project: string, rawPath: string, cardId: string, map: CardMap): string | null {
  const path = resolveInProject(project, rawPath)
  if (!existsSync(path)) return null
  const recorded = Object.prototype.hasOwnProperty.call(map.sources, cardId) ? map.sources[cardId] : undefined
  if (recorded?.raw_path === rawPath) return null
  try {
    if (parseFrontmatter(readFileSync(path, "utf8")).frontmatter?.heptabase_card_id === cardId) return null
  } catch {
    // Unreadable: it is not known to be a snapshot of this card.
  }
  return `${rawPath} exists and is not a snapshot of card ${cardId}; move or remove it, then run the command again`
}

/**
 * The domain whose hinted whiteboard is nearest to the card: a whiteboard of the card is at distance 0, its
 * parent at 1, and so on. Null when no domain hints at one of them, or when two domains tie at the nearest
 * distance. A domains.yaml that cannot be read adds a warning and no domain: the snapshot is still worth saving.
 */
function domainOf(
  project: string,
  boards: readonly Board[],
  parents: ReadonlyMap<string, string | null>,
  warnings: string[],
): string | null {
  const path = resolveInProject(project, DOMAINS_FILE)
  if (!existsSync(path)) return null
  let text: string
  try {
    text = readFileSync(path, "utf8").replace(/^\uFEFF/, "")
  } catch {
    warnings.push(`cannot read ${DOMAINS_FILE}, so no domain was added`)
    return null
  }
  const result = parseDomainsYaml(text, knownLenses(project))
  if (!result.ok) {
    const issue = result.issues[0]
    warnings.push(`${DOMAINS_FILE} is not valid, so no domain was added: ${issue.path === "" ? "" : `${issue.path}: `}${issue.message}`)
    return null
  }

  // The distance of each whiteboard on the way up from the boards of the card; the nearest one counts.
  const distances = new Map<string, number>()
  for (const board of boards) {
    whiteboardChain(parents, board.id).forEach((boardId, distance) => {
      distances.set(boardId, Math.min(distance, distances.get(boardId) ?? distance))
    })
  }
  const hinted: { name: string; distance: number }[] = []
  for (const [name, entry] of Object.entries(result.value.domains)) {
    const reached = entry.whiteboards.flatMap((hint) => distances.get(hint) ?? [])
    if (reached.length > 0) hinted.push({ name, distance: Math.min(...reached) })
  }
  const nearest = Math.min(...hinted.map((domain) => domain.distance))
  const winners = hinted.filter((domain) => domain.distance === nearest)
  return winners.length === 1 ? winners[0].name : null
}

/** The lenses a domain may use: the built-in ones and the stems of `lenses/*.md`, as the app allows. */
function knownLenses(project: string): string[] {
  let names: string[] = []
  try {
    names = readdirSync(resolveInProject(project, LENSES_DIRECTORY))
  } catch {
    // No lenses folder: only the built-in lenses.
  }
  const stems = names.filter((name) => name.toLowerCase().endsWith(".md")).map((name) => name.slice(0, -".md".length))
  return [...new Set([...KNOWN_LENSES, ...stems])]
}

/** A double-quoted YAML string. JSON text is one, except that YAML also breaks a line at these characters. */
function yamlString(value: string): string {
  return JSON.stringify(value).replace(/[\u0085\u2028\u2029]/g, (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`)
}
