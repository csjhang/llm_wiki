import type { ConfigIssue, ParseResult } from "./types"
import {
  checkVersion,
  childPath,
  hasOwn,
  isRecord,
  loadYamlMapping,
  readUuid,
  reportUnknownKeys,
} from "./yaml-util"

export const WHITEBOARD_KINDS = ["topic", "source", "project", "archive"] as const
export type WhiteboardKind = (typeof WHITEBOARD_KINDS)[number]

export interface WhiteboardSetting {
  kind: WhiteboardKind
  auto_ingest: boolean
}

export const REQUIRED_PROPERTY_KEYS = ["domain", "page_type", "wiki", "status"] as const
export const OPTIONAL_PROPERTY_KEYS = [
  "wiki_page",
  "last_synced",
  "hypothesis_status",
  "strength",
] as const
export type PropertyKey =
  | (typeof REQUIRED_PROPERTY_KEYS)[number]
  | (typeof OPTIONAL_PROPERTY_KEYS)[number]

export interface HeptabaseConfig {
  version: 1
  roots: string[]
  whiteboards: Record<string, WhiteboardSetting>
  tags: { ingest: string; mirror: string }
  properties: Partial<Record<PropertyKey, string>>
}

// Wiki identity (id, role, mechanism library) lives in `wiki.yaml`. See wiki-identity.ts.
const TOP_LEVEL_KEYS = ["version", "roots", "whiteboards", "tags", "properties"] as const
const WHITEBOARD_KEYS = ["kind", "auto_ingest"] as const
const TAG_KEYS = ["ingest", "mirror"] as const
const PROPERTY_KEYS: readonly PropertyKey[] = [...REQUIRED_PROPERTY_KEYS, ...OPTIONAL_PROPERTY_KEYS]

/**
 * Parse and validate the text of `heptabase.yaml`. Collects every issue before
 * returning. Does not check that the ids exist in Heptabase.
 */
export function parseHeptabaseYaml(text: string): ParseResult<HeptabaseConfig> {
  const loaded = loadYamlMapping(text)
  if (!loaded.ok) return { ok: false, issues: [loaded.issue] }

  const root = loaded.value
  const issues: ConfigIssue[] = []
  checkVersion(root, issues)
  reportUnknownKeys(root, TOP_LEVEL_KEYS, "", issues)
  const roots = parseRoots(root.roots, issues)
  const whiteboards = parseWhiteboards(root.whiteboards, issues)
  const tags = parseTags(root.tags, issues)
  const properties = parseProperties(root.properties, issues)

  if (issues.length > 0) return { ok: false, issues }
  return {
    ok: true,
    value: {
      version: 1,
      roots,
      whiteboards,
      tags,
      properties,
    },
    issues: [],
  }
}

function parseRoots(raw: unknown, issues: ConfigIssue[]): string[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    issues.push({ path: "roots", message: "must be a list with at least one whiteboard UUID" })
    return []
  }
  const roots: string[] = []
  raw.forEach((item, index) => {
    const id = readUuid(item, `roots[${index}]`, issues)
    if (id !== "") roots.push(id)
  })
  return roots
}

function parseWhiteboards(raw: unknown, issues: ConfigIssue[]): Record<string, WhiteboardSetting> {
  const whiteboards: Record<string, WhiteboardSetting> = {}
  // A whiteboard that is not listed counts as a topic, so an empty section is fine.
  if (raw === undefined || raw === null) return whiteboards
  if (!isRecord(raw)) {
    issues.push({ path: "whiteboards", message: "must be a mapping of whiteboard UUID to settings" })
    return whiteboards
  }
  for (const [key, entry] of Object.entries(raw)) {
    const path = childPath("whiteboards", key)
    const validKey = readUuid(key, path, issues) !== ""
    const setting = parseWhiteboardSetting(entry, path, issues)
    if (validKey) whiteboards[key] = setting
  }
  return whiteboards
}

function parseWhiteboardSetting(
  raw: unknown,
  path: string,
  issues: ConfigIssue[],
): WhiteboardSetting {
  const setting: WhiteboardSetting = { kind: "topic", auto_ingest: false }
  if (!isRecord(raw)) {
    issues.push({ path, message: "must be a mapping with kind and optional auto_ingest" })
    return setting
  }
  reportUnknownKeys(raw, WHITEBOARD_KEYS, path, issues)

  const kind = WHITEBOARD_KINDS.find((candidate) => candidate === raw.kind)
  if (kind) {
    setting.kind = kind
  } else {
    issues.push({
      path: childPath(path, "kind"),
      message: `must be one of: ${WHITEBOARD_KINDS.join(", ")}`,
    })
  }

  if (raw.auto_ingest === undefined) return setting
  if (typeof raw.auto_ingest !== "boolean") {
    issues.push({ path: childPath(path, "auto_ingest"), message: "must be true or false" })
  } else if (raw.auto_ingest && kind && kind !== "source") {
    issues.push({
      path: childPath(path, "auto_ingest"),
      message: 'can be true only when kind is "source"',
    })
  } else {
    setting.auto_ingest = raw.auto_ingest
  }
  return setting
}

function parseTags(raw: unknown, issues: ConfigIssue[]): HeptabaseConfig["tags"] {
  const tags = { ingest: "", mirror: "" }
  if (!isRecord(raw)) {
    issues.push({ path: "tags", message: "must be a mapping with ingest and mirror tag UUIDs" })
    return tags
  }
  reportUnknownKeys(raw, TAG_KEYS, "tags", issues)
  tags.ingest = readUuid(raw.ingest, "tags.ingest", issues)
  tags.mirror = readUuid(raw.mirror, "tags.mirror", issues)
  return tags
}

function parseProperties(raw: unknown, issues: ConfigIssue[]): HeptabaseConfig["properties"] {
  const properties: HeptabaseConfig["properties"] = {}
  if (!isRecord(raw)) {
    issues.push({ path: "properties", message: "must be a mapping of property name to UUID" })
    return properties
  }
  reportUnknownKeys(raw, PROPERTY_KEYS, "properties", issues)
  for (const key of PROPERTY_KEYS) {
    const path = childPath("properties", key)
    if (hasOwn(raw, key)) {
      properties[key] = readUuid(raw[key], path, issues)
    } else if ((REQUIRED_PROPERTY_KEYS as readonly string[]).includes(key)) {
      issues.push({ path, message: "is required" })
    }
  }
  return properties
}
