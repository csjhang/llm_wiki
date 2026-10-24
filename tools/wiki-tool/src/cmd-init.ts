/**
 * `wiki-tool hepta init` - write the first draft of heptabase.yaml.
 *
 * Reads the output of the Heptabase `read_database` tool (as a JSON file) and
 * `list_whiteboards` (as a text file; one file per page when the list is paged), maps the database properties to the keys of
 * heptabase.yaml by name, checks the ids the user gave, and writes heptabase.yaml
 * and the whiteboard tree of the card map. Nothing is written unless every check
 * passes. The generated text is parsed with parseHeptabaseYaml before it is written.
 */
import { existsSync, readFileSync } from "node:fs"
import {
  parseHeptabaseYaml,
  REQUIRED_PROPERTY_KEYS,
  type PropertyKey,
} from "@/lib/wiki-config/heptabase-config"
import { UUID_PATTERN } from "@/lib/wiki-config/types"
import { isRecord } from "@/lib/wiki-config/yaml-util"
import { parseArgs } from "./args"
import { type CardMap, loadCardMap, saveCardMap } from "./card-map"
import type { CommandResult } from "./io"
import { isDirectory, resolveInProject, writeFileAtomic } from "./io"
import { readWhiteboardList, storeWhiteboardList, type WhiteboardList } from "./whiteboard-tree"

const HEPTABASE_YAML = "heptabase.yaml"

/** The database properties heptabase.yaml records, in the order it lists them. */
const PROPERTY_SPECS: readonly { key: PropertyKey; name: string; type: string }[] = [
  { key: "domain", name: "domain", type: "select" },
  { key: "page_type", name: "page type", type: "select" },
  { key: "wiki", name: "wiki", type: "select" },
  { key: "status", name: "status", type: "select" },
  { key: "wiki_page", name: "wiki page", type: "text" },
  { key: "last_synced", name: "last synced", type: "date" },
  { key: "hypothesis_status", name: "hypothesis status", type: "select" },
  { key: "strength", name: "strength", type: "select" },
]

const OPTION_SPEC = {
  values: ["project", "database", "ingest-tag", "mirror-tag"],
  // --whiteboards is given once per page of the list_whiteboards result.
  lists: ["whiteboards", "root", "other-root", "source-board", "archive-board"],
  flags: ["force"],
} as const

const REQUIRED_OPTIONS = ["project", "database", "whiteboards", "ingest-tag", "mirror-tag", "root"] as const

export interface DatabaseSchema {
  /** Property id to its definition, as `read_database` returns it. */
  schema: Record<string, unknown>
  tagId: string | null
}

interface ConfigDraft {
  roots: string[]
  otherRoots: string[]
  sourceBoards: string[]
  archiveBoards: string[]
  tags: { ingest: string; mirror: string }
  properties: Partial<Record<PropertyKey, string>>
}

export function init(args: string[]): CommandResult {
  const { parsed, problems: optionProblems } = parseArgs(args, OPTION_SPEC)
  const problems = [...optionProblems]
  for (const name of REQUIRED_OPTIONS) {
    const given = name in parsed.lists ? parsed.lists[name].length > 0 : parsed.values[name] !== undefined
    if (!given) problems.push(`missing option: --${name}`)
  }
  if (problems.length > 0) return { ok: false, problems }

  const project = parsed.values.project
  const databasePath = parsed.values.database
  const whiteboardsPaths = parsed.lists.whiteboards
  const roots = unique(parsed.lists.root)
  const otherRoots = unique(parsed.lists["other-root"])
  const sourceBoards = unique(parsed.lists["source-board"])
  const archiveBoards = unique(parsed.lists["archive-board"])
  const tags = { ingest: parsed.values["ingest-tag"], mirror: parsed.values["mirror-tag"] }
  const warnings: string[] = []
  if (tags.ingest === tags.mirror) problems.push("--ingest-tag and --mirror-tag must be two different tags")

  if (!isDirectory(project)) return { ok: false, problems: [`project folder not found: ${project}`] }
  const configPath = resolveInProject(project, HEPTABASE_YAML)
  if (existsSync(configPath) && !parsed.flags.force) {
    problems.push(`${HEPTABASE_YAML} already exists; pass --force to replace it`)
  }
  let map: CardMap | null = null
  try {
    map = loadCardMap(project)
  } catch (error) {
    problems.push(error instanceof Error ? error.message : String(error))
  }

  // The properties come from the database.
  const database = readDatabase(databasePath, problems)
  const properties = database ? mapProperties(database.schema, problems, warnings) : {}
  if (database?.tagId && database.tagId !== tags.mirror) {
    warnings.push(`the database belongs to tag ${database.tagId}, but --mirror-tag is ${tags.mirror}`)
  }

  // The whiteboards the user named must be in the list. Only the last page can say the list goes on.
  const pages = whiteboardsPaths.map((path) => readText("--whiteboards", path, problems))
  let list: WhiteboardList | null = null
  if (pages.every((page): page is string => page !== null)) {
    list = readWhiteboardList(pages)
    if (list.nodes.length === 0) {
      problems.push("--whiteboards file lists no whiteboards")
    } else {
      const known = new Set(list.nodes.map((node) => node.id))
      const checkBoards = (option: string, ids: string[]): void => {
        for (const id of ids) {
          if (!known.has(id)) {
            const note = list?.partial ? ` (the list is partial: ${list.partial})` : ""
            problems.push(`--${option} ${id} is not in the whiteboard list${note}`)
          }
        }
      }
      checkBoards("root", roots)
      checkBoards("other-root", otherRoots)
      checkBoards("source-board", sourceBoards)
      checkBoards("archive-board", archiveBoards)
    }
  }
  for (const id of sourceBoards.filter((candidate) => archiveBoards.includes(candidate))) {
    problems.push(`${id} is given as both --source-board and --archive-board`)
  }
  for (const id of roots.filter((candidate) => otherRoots.includes(candidate))) {
    problems.push(`${id} is given as both --root and --other-root`)
  }
  if (problems.length > 0 || map === null || list === null) return { ok: false, problems }

  // The parser has the last word on the generated text.
  const text = renderHeptabaseYaml({ roots, otherRoots, sourceBoards, archiveBoards, tags, properties })
  const checked = parseHeptabaseYaml(text)
  if (!checked.ok) {
    const issues = checked.issues.map((issue) => {
      const where = issue.path === "" ? "" : `${issue.path}: `
      return `invalid ${HEPTABASE_YAML}: ${where}${issue.message}`
    })
    return { ok: false, problems: issues }
  }

  // The map goes first: if the second write fails, a rerun does not need --force.
  const mapChanged = storeWhiteboardList(map, list, new Date(), warnings)
  if (mapChanged) saveCardMap(project, map)
  writeFileAtomic(configPath, text)
  return {
    ok: true,
    written: [...(mapChanged ? ["heptabase-map.json"] : []), HEPTABASE_YAML],
    properties: checked.value.properties,
    whiteboards_cached: map.whiteboards_cache.items.length,
    warnings,
  }
}

function unique(values: string[]): string[] {
  return [...new Set(values)]
}

function readText(option: string, path: string, problems: string[]): string | null {
  try {
    return readFileSync(path, "utf8").replace(/^\uFEFF/, "")
  } catch {
    problems.push(`cannot read ${option} file: ${path}`)
    return null
  }
}

/** The schema and tag id of a `read_database` result: the parsed object, or the JSON text in `content`. */
export function readDatabase(path: string, problems: string[]): DatabaseSchema | null {
  const text = readText("--database", path, problems)
  if (text === null) return null
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    problems.push(`cannot parse JSON file ${path}: ${reason}`)
    return null
  }

  // The parsed object and the JSON text in `content` hold the same data; use either.
  const inContent = isRecord(raw) && typeof raw.content === "string" ? schemaOf(parseJsonOrNull(raw.content)) : null
  const found = schemaOf(raw) ?? inContent
  if (found) return found
  const status = isRecord(raw) && typeof raw.status === "string" ? ` (status: ${raw.status})` : ""
  problems.push(`--database file has no configuration.schema${status}`)
  return null
}

function schemaOf(value: unknown): DatabaseSchema | null {
  if (!isRecord(value) || !isRecord(value.configuration) || !isRecord(value.configuration.schema)) return null
  return { schema: value.configuration.schema, tagId: typeof value.tagId === "string" ? value.tagId : null }
}

function parseJsonOrNull(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

/** Match the database properties to the keys of heptabase.yaml by name and check their types. */
function mapProperties(
  schema: Record<string, unknown>,
  problems: string[],
  warnings: string[],
): Partial<Record<PropertyKey, string>> {
  const byName = new Map<string, { id: string; type: unknown }[]>()
  for (const [id, definition] of Object.entries(schema)) {
    if (!isRecord(definition) || typeof definition.name !== "string") continue
    const name = definition.name.trim().toLowerCase()
    byName.set(name, [...(byName.get(name) ?? []), { id, type: definition.type }])
  }

  const properties: Partial<Record<PropertyKey, string>> = {}
  for (const spec of PROPERTY_SPECS) {
    const matches = byName.get(spec.name) ?? []
    if (matches.length === 0) {
      if ((REQUIRED_PROPERTY_KEYS as readonly string[]).includes(spec.key)) {
        problems.push(`required property "${spec.name}" is missing from the database`)
      } else {
        warnings.push(`optional property "${spec.name}" is missing from the database; left out of ${HEPTABASE_YAML}`)
      }
    } else if (matches.length > 1) {
      problems.push(`property "${spec.name}" appears ${matches.length} times in the database`)
    } else if (matches[0].type !== spec.type) {
      problems.push(`property "${spec.name}" has type "${String(matches[0].type)}"; expected "${spec.type}"`)
    } else {
      properties[spec.key] = matches[0].id
    }
  }
  return properties
}

/** A YAML scalar for an id: plain for a UUID, quoted for anything else so it cannot add keys. */
function scalar(value: string): string {
  return UUID_PATTERN.test(value) ? value : JSON.stringify(value)
}

function renderHeptabaseYaml(draft: ConfigDraft): string {
  const lines = [
    "# Heptabase settings of this wiki. Written by `wiki-tool hepta init`; edit it when your Heptabase setup changes.",
    "version: 1",
    "roots:",
    ...draft.roots.map((id) => `  - ${scalar(id)}`),
  ]
  if (draft.otherRoots.length > 0) lines.push("other_wiki_roots:", ...draft.otherRoots.map((id) => `  - ${scalar(id)}`))
  const boards = [
    ...draft.sourceBoards.map((id) => `  ${scalar(id)}: { kind: source, auto_ingest: false }`),
    ...draft.archiveBoards.map((id) => `  ${scalar(id)}: { kind: archive }`),
  ]
  lines.push(...(boards.length > 0 ? ["whiteboards:", ...boards] : ["whiteboards: {}"]))
  lines.push("tags:", `  ingest: ${scalar(draft.tags.ingest)}`, `  mirror: ${scalar(draft.tags.mirror)}`)
  lines.push("properties:")
  for (const spec of PROPERTY_SPECS) {
    const id = draft.properties[spec.key]
    if (id !== undefined) lines.push(`  ${spec.key}: ${scalar(id)}`)
  }
  return `${lines.join("\n")}\n`
}
