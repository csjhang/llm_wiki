/**
 * The card map: `<project>/heptabase-map.json`.
 *
 * It records which wiki page is which Heptabase card, which cards were snapshotted
 * into `raw/sources/heptabase/`, and the whiteboard tree last seen. Only wiki-tool
 * writes it. Reads and writes stay inside the project folder, and a save replaces
 * the file atomically.
 */
import { createHash } from "node:crypto"
import { existsSync } from "node:fs"
import { isRecord } from "@/lib/wiki-config/yaml-util"
import { readJsonFile, resolveInProject, writeFileAtomic } from "./io"
import type { WhiteboardNode } from "./parse-mcp"

/** Where the map lives, relative to the project folder. */
export const CARD_MAP_FILE = "heptabase-map.json"

export interface PageEntry {
  card_id: string
  content_hash: string
  last_synced_at: string
  card_updated_at: string
  placements: string[]
  status: "active" | "retired"
}

export interface SourceEntry {
  raw_path: string
  card_updated_at: string
  ingest_commit: string | null
}

export interface CardMap {
  version: 1
  /** Wiki page path (relative to the project) to its card. */
  pages: Record<string, PageEntry>
  /** Heptabase card id to its snapshot. */
  sources: Record<string, SourceEntry>
  /** `updated_at` is "" until a whiteboard list has been stored. */
  whiteboards_cache: { updated_at: string; items: WhiteboardNode[] }
}

function emptyCardMap(): CardMap {
  return { version: 1, pages: {}, sources: {}, whiteboards_cache: { updated_at: "", items: [] } }
}

/**
 * Read the map of a project. A project without a map gets an empty one. A map that
 * cannot be read as a card map throws an error that names the file and says to
 * repair or remove it.
 */
export function loadCardMap(projectPath: string): CardMap {
  const path = resolveInProject(projectPath, CARD_MAP_FILE)
  if (!existsSync(path)) return emptyCardMap()
  try {
    return readCardMap(path)
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    throw new Error(`${reason}; repair or remove ${CARD_MAP_FILE}`)
  }
}

function readCardMap(path: string): CardMap {
  const raw = readJsonFile<unknown>(path)
  if (!isRecord(raw)) throw new Error(`${CARD_MAP_FILE} must be a JSON object`)
  if (raw.version !== 1) throw new Error(`${CARD_MAP_FILE}: version must be the number 1`)
  if (!isRecord(raw.pages)) throw new Error(`${CARD_MAP_FILE}: pages must be an object`)
  if (!isRecord(raw.sources)) throw new Error(`${CARD_MAP_FILE}: sources must be an object`)
  const cache = raw.whiteboards_cache
  if (!isRecord(cache) || typeof cache.updated_at !== "string" || !Array.isArray(cache.items)) {
    throw new Error(`${CARD_MAP_FILE}: whiteboards_cache must be an object with updated_at and items`)
  }
  return raw as unknown as CardMap
}

/** Write the map to `<project>/heptabase-map.json`; a reader sees the old or the new file. */
export function saveCardMap(projectPath: string, map: CardMap): void {
  writeFileAtomic(resolveInProject(projectPath, CARD_MAP_FILE), `${JSON.stringify(map, null, 2)}\n`)
}

/** The sha256 of the UTF-8 text, as lowercase hex. */
export function contentHash(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex")
}
