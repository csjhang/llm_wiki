/**
 * whiteboards.ts - the whiteboards that the panel offers for a button with a whiteboard input.
 *
 * The list is the `whiteboards_cache` of `<project>/heptabase-map.json`. The sync keeps it.
 * The panel only reads it. Without a sync the cache is empty and the panel has nothing to offer.
 */
import { fileExists, readFile } from "@/commands/fs"
import { UUID_PATTERN } from "@/lib/wiki-config/types"

export interface WhiteboardOption {
  /** A lowercase UUID, the value of the whiteboard input. */
  id: string
  /** Titles from the root whiteboard down to this one, joined with " / ". */
  label: string
}

const CARD_MAP_FILE = "heptabase-map.json"
const LABEL_SEPARATOR = " / "

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/**
 * The whiteboards of the cache in the order of the file. Never throws: text that is not
 * a card map gives an empty list. An item without a lowercase UUID `id` is left out,
 * because `commandFor` would refuse it.
 */
export function parseWhiteboardOptions(text: string): WhiteboardOption[] {
  let root: unknown
  try {
    root = JSON.parse(text)
  } catch {
    return []
  }
  const cache = isRecord(root) ? root.whiteboards_cache : null
  const items = isRecord(cache) ? cache.items : null
  if (!Array.isArray(items)) return []

  interface Node {
    id: string
    title: string
    parentId: string | null
  }
  const nodes = new Map<string, Node>()
  for (const item of items) {
    if (!isRecord(item) || typeof item.id !== "string" || !UUID_PATTERN.test(item.id)) continue
    if (nodes.has(item.id)) continue
    const title = typeof item.title === "string" ? item.title.trim() : ""
    nodes.set(item.id, {
      id: item.id,
      title: title === "" ? item.id : title,
      parentId: typeof item.parentId === "string" ? item.parentId : null,
    })
  }

  return [...nodes.values()].map((node) => {
    // Walk up to the root. `seen` stops a loop in a damaged cache.
    const titles = [node.title]
    const seen = new Set([node.id])
    let parent = node.parentId === null ? undefined : nodes.get(node.parentId)
    while (parent && !seen.has(parent.id)) {
      titles.unshift(parent.title)
      seen.add(parent.id)
      parent = parent.parentId === null ? undefined : nodes.get(parent.parentId)
    }
    return { id: node.id, label: titles.join(LABEL_SEPARATOR) }
  })
}

/** The whiteboards of a project. An absent or unreadable map gives an empty list. */
export async function loadWhiteboardOptions(projectPath: string): Promise<WhiteboardOption[]> {
  const path = `${projectPath.replace(/[\\/]+$/, "")}/${CARD_MAP_FILE}`
  try {
    if (!(await fileExists(path))) return []
    return parseWhiteboardOptions(await readFile(path))
  } catch {
    return []
  }
}
