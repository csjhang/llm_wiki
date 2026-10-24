/**
 * `wiki-tool hepta plan-up` - plan the changes from Heptabase to the wiki.
 *
 * Reads the cards the skill listed (`list_cards`, one file per page), the whiteboard tree, the card
 * map, and heptabase.yaml, and prints the actions the skill must run: `snapshot` a card into
 * `raw/sources/heptabase/` (the skill reads the card, then runs `hepta snapshot`), `download-pdf` for
 * a PDF card, or `ask` the user when the card cannot be placed. It never calls Heptabase.
 *
 * A card is planned when it has no snapshot yet, or when its `updatedAt` is newer than the time the
 * map recorded. Not planned: a mirror card (the AI wrote it), a card on an archive whiteboard, and a
 * card whose snapshot is up to date.
 *
 * A card belongs to the wiki through a root whiteboard. For each whiteboard of the card, the walk goes
 * up the stored tree (the whiteboard itself first) and stops at the first root. A card that reaches two
 * different roots, or none, needs a decision (`ask`). A card that has a snapshot already was accepted
 * then, so its update is planned without asking again. Giving `--whiteboards` replaces the stored tree.
 */
import { readFileSync } from "node:fs"
import { parseArgs, parseNowOption } from "./args"
import { type CardMap, loadCardMap, saveCardMap } from "./card-map"
import { type CommandResult, isDirectory } from "./io"
import { readHeptabaseConfig } from "./mirror-pages"
import {
  type CardRef,
  joinListWhiteboards,
  parseListCards,
  parsePagingTrailer,
  type WhiteboardNode,
} from "./parse-mcp"

/** What the skill does for a card. */
export type UpAction =
  | { op: "snapshot"; cardId: string; title: string; cardType: string; whiteboards: { id: string; title: string }[] }
  | { op: "ask"; cardId: string; title: string; reason: "two-roots" | "no-root" }
  | { op: "download-pdf"; cardId: string; title: string }

const OPTION_SPEC = {
  values: ["project", "now"],
  // One file for each page of the list_cards result, and of the list_whiteboards result.
  lists: ["cards", "whiteboards"],
} as const

const PDF_CARD = "pdfCard"

export function planUp(args: string[]): CommandResult {
  const { parsed, problems: optionProblems } = parseArgs(args, OPTION_SPEC)
  const problems = [...optionProblems]
  const project = parsed.values.project
  if (project === undefined) problems.push("missing option: --project")
  if (parsed.lists.cards.length === 0) problems.push("missing option: --cards")
  if (problems.length > 0 || project === undefined) return { ok: false, problems }
  if (!isDirectory(project)) return { ok: false, problems: [`project folder not found: ${project}`] }

  const config = readHeptabaseConfig(project, problems)
  let map: CardMap | null = null
  try {
    map = loadCardMap(project)
  } catch (error) {
    problems.push(error instanceof Error ? error.message : String(error))
  }
  const now = parseNowOption(parsed.values.now, problems)
  const cards = readCards(parsed.lists.cards, problems)
  const tree = parsed.lists.whiteboards.length > 0 ? readTree(parsed.lists.whiteboards, problems) : null
  if (problems.length > 0 || !config || !map || !now) return { ok: false, problems }

  const warnings: string[] = []
  if (tree) {
    if (tree.partial) warnings.push(`the whiteboard list is partial (${tree.partial}), so the stored tree holds only these whiteboards`)
    map.whiteboards_cache = { updated_at: now.toISOString(), items: tree.nodes }
    saveCardMap(project, map)
  }

  const parents = parentIndex(map.whiteboards_cache.items)
  const roots = new Set(config.roots)
  const mirrorIds = new Set(Object.values(map.pages).map((entry) => entry.card_id))
  const skipped = { archived: 0, mirror: 0, unchanged: 0 }
  const actions: UpAction[] = []

  for (const card of cards) {
    if (mirrorIds.has(card.id)) {
      skipped.mirror += 1
      continue
    }
    const recorded = Object.prototype.hasOwnProperty.call(map.sources, card.id) ? map.sources[card.id] : undefined
    if (recorded && !isNewer(card.updatedAt, recorded.card_updated_at)) {
      skipped.unchanged += 1
      continue
    }
    const chains = card.whiteboards.map((board) => whiteboardChain(parents, board.id))
    if (chains.some((chain) => chain.some((boardId) => config.whiteboards[boardId]?.kind === "archive"))) {
      skipped.archived += 1
      continue
    }
    if (!recorded) {
      // The first root each whiteboard reaches; two whiteboards under one root are one root.
      const reached = new Set(chains.flatMap((chain) => chain.find((boardId) => roots.has(boardId)) ?? []))
      if (reached.size !== 1) {
        actions.push({ op: "ask", cardId: card.id, title: card.title, reason: reached.size === 0 ? "no-root" : "two-roots" })
        continue
      }
    }
    actions.push(
      card.type === PDF_CARD
        ? { op: "download-pdf", cardId: card.id, title: card.title }
        : { op: "snapshot", cardId: card.id, title: card.title, cardType: card.type, whiteboards: card.whiteboards },
    )
  }
  return { ok: true, actions, skipped, warnings }
}

/** The cards of the `list_cards` files, in order of first appearance. A later file wins for a card that two files list. */
function readCards(paths: readonly string[], problems: string[]): CardRef[] {
  const cards = new Map<string, CardRef>()
  for (const path of paths) {
    let text: string
    try {
      text = readFileSync(path, "utf8")
    } catch {
      problems.push(`cannot read --cards file: ${path}`)
      continue
    }
    for (const card of parseListCards(text)) cards.set(card.id, card)
  }
  return [...cards.values()]
}

/** The whiteboards of the `list_whiteboards` files, joined. `partial` says so when the last page is not the end. */
function readTree(paths: readonly string[], problems: string[]): { nodes: WhiteboardNode[]; partial: string | null } | null {
  const pages: string[] = []
  for (const path of paths) {
    try {
      pages.push(readFileSync(path, "utf8"))
    } catch {
      problems.push(`cannot read --whiteboards file: ${path}`)
    }
  }
  if (pages.length < paths.length) return null
  const nodes = joinListWhiteboards(pages)
  if (nodes.length === 0) {
    problems.push("--whiteboards file lists no whiteboards")
    return null
  }
  const trailer = parsePagingTrailer(pages[pages.length - 1])
  return { nodes, partial: trailer ? `showing ${trailer.shown[0]}-${trailer.shown[1]} of ${trailer.total}` : null }
}

/** A whiteboard id to the id of its parent. A top-level whiteboard has `null`. */
export function parentIndex(items: readonly WhiteboardNode[]): Map<string, string | null> {
  return new Map(items.map((node) => [node.id, node.parentId]))
}

/**
 * The whiteboard and its ancestors, nearest first. A whiteboard that the tree does not know has no
 * ancestors; the chain is only the whiteboard itself. A loop in the tree ends the chain.
 */
export function whiteboardChain(parents: ReadonlyMap<string, string | null>, boardId: string): string[] {
  const chain: string[] = []
  let current: string | null | undefined = boardId
  while (current !== null && current !== undefined && !chain.includes(current)) {
    chain.push(current)
    current = parents.get(current)
  }
  return chain
}

/** True when the card changed after the recorded time. A card list without `updatedAt` cannot say, so it is not newer. */
function isNewer(updatedAt: string | undefined, recorded: string): boolean {
  if (updatedAt === undefined) return false
  const current = Date.parse(updatedAt)
  if (Number.isNaN(current)) return false
  const before = Date.parse(recorded)
  return Number.isNaN(before) || current > before
}
