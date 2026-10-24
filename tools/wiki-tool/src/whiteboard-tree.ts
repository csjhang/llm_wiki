/**
 * The whiteboard tree that plan-up and init keep in the card map (`whiteboards_cache`).
 *
 * Both commands read the pages of a `list_whiteboards` result the same way. A list that is partial (its last page says that
 * more whiteboards follow) would drop the whiteboards it lacks, so it never replaces the stored tree. A list that is the
 * same as the stored tree does not make the map be written again.
 */
import type { CardMap } from "./card-map"
import { findCutOffWhiteboards, joinListWhiteboards, parsePagingTrailer, type WhiteboardNode } from "./parse-mcp"

/** The depth to ask `list_whiteboards` for. The default depth of the tool cuts a deep tree off. */
export const LIST_DEPTH = 10

/** The most cut-off whiteboards a warning names. */
const MAX_NAMED = 3

export interface WhiteboardList {
  nodes: WhiteboardNode[]
  /** `showing 1-3 of 8` when the last page says that more follow; else null. */
  partial: string | null
  /** The warning for a tree that is cut off below some whiteboards; else null. */
  cutOff: string | null
}

/** The tree of the pages of one `list_whiteboards` result, in page order. */
export function readWhiteboardList(pages: string[]): WhiteboardList {
  const trailer = pages.length === 0 ? null : parsePagingTrailer(pages[pages.length - 1])
  return {
    nodes: joinListWhiteboards(pages),
    partial: trailer ? `showing ${trailer.shown[0]}-${trailer.shown[1]} of ${trailer.total}` : null,
    cutOff: cutOffWarning(pages),
  }
}

function cutOffWarning(pages: string[]): string | null {
  const found = findCutOffWhiteboards(pages)
  if (found.length === 0) return null
  const named = found
    .slice(0, MAX_NAMED)
    .map((board) => `"${board.title}" [${board.id}] (${board.reported} whiteboards reported, ${board.listed} listed)`)
  const more = found.length > MAX_NAMED ? ` and ${found.length - MAX_NAMED} more` : ""
  return `the whiteboard list is cut off below ${named.join(" and below ")}${more}; call list_whiteboards again with depth ${LIST_DEPTH}`
}

/**
 * Keeps the list as the stored tree of the map, unless the list is partial or the same as the stored tree. Adds the
 * warnings that go with the list. Returns true when the map changed and must be saved.
 */
export function storeWhiteboardList(map: CardMap, list: WhiteboardList, now: Date, warnings: string[]): boolean {
  if (list.partial) {
    const stored = map.whiteboards_cache.items.length
    warnings.push(`the whiteboard list is partial (${list.partial}), so the stored tree (${stored} whiteboards) was not changed`)
  }
  if (list.cutOff) warnings.push(list.cutOff)
  if (list.partial) return false
  if (JSON.stringify(map.whiteboards_cache.items) === JSON.stringify(list.nodes)) return false
  map.whiteboards_cache = { updated_at: now.toISOString(), items: list.nodes }
  return true
}
