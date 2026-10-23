import type { ConfigIssue, ParseResult } from "./types"
import { checkVersion, loadYamlMapping, reportUnknownKeys } from "./yaml-util"

/**
 * `wiki.yaml` says what a wiki is. It is wiki-level config, not Heptabase config,
 * so a wiki without Heptabase can still say that it is a work wiki.
 * The Heptabase `wiki` property value comes from `id`.
 */
export const WIKI_ROLES = ["reading", "work"] as const
export type WikiRole = (typeof WIKI_ROLES)[number]

export interface WikiIdentity {
  version: 1
  id: string
  role: WikiRole
  /** Path to the reading wiki. Null in a reading wiki. Required in a work wiki. */
  mechanism_library: string | null
}

const WIKI_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

const TOP_LEVEL_KEYS = ["version", "id", "role", "mechanism_library"] as const

/**
 * Parse and validate the text of `wiki.yaml`. Collects every issue before
 * returning. Does not check that the library path exists.
 */
export function parseWikiYaml(text: string): ParseResult<WikiIdentity> {
  const loaded = loadYamlMapping(text)
  if (!loaded.ok) return { ok: false, issues: [loaded.issue] }

  const root = loaded.value
  const issues: ConfigIssue[] = []
  checkVersion(root, issues)
  reportUnknownKeys(root, TOP_LEVEL_KEYS, "", issues)
  const id = parseId(root.id, issues)
  const role = parseRole(root.role, issues)
  const mechanismLibrary = parseMechanismLibrary(root.mechanism_library, role, issues)

  if (issues.length > 0 || role === null) return { ok: false, issues }
  return {
    ok: true,
    value: { version: 1, id, role, mechanism_library: mechanismLibrary },
    issues: [],
  }
}

function parseId(raw: unknown, issues: ConfigIssue[]): string {
  if (typeof raw === "string" && WIKI_ID_PATTERN.test(raw)) return raw
  issues.push({
    path: "id",
    message: 'must be lowercase letters and digits, with "-" between words (for example "reading")',
  })
  return ""
}

function parseRole(raw: unknown, issues: ConfigIssue[]): WikiRole | null {
  const role = WIKI_ROLES.find((candidate) => candidate === raw)
  if (role) return role
  issues.push({ path: "role", message: `must be one of: ${WIKI_ROLES.join(", ")}` })
  return null
}

/**
 * A reading wiki holds the mechanism library, so it has no path to one.
 * A work wiki points to the library of a reading wiki, so it needs the path.
 * A missing key counts as null.
 */
function parseMechanismLibrary(
  raw: unknown,
  role: WikiRole | null,
  issues: ConfigIssue[],
): string | null {
  const absent = raw === undefined || raw === null
  const isPath = typeof raw === "string" && raw.trim() !== ""
  if (role === "reading" && !absent) {
    issues.push({ path: "mechanism_library", message: 'must be null when role is "reading"' })
    return null
  }
  if (role === "work" && !isPath) {
    issues.push({
      path: "mechanism_library",
      message: 'must be a non-empty path to the reading wiki when role is "work"',
    })
    return null
  }
  if (role === null && !absent && !isPath) {
    // The role is already reported. Still say that the value has the wrong type.
    issues.push({ path: "mechanism_library", message: "must be null or a non-empty path string" })
    return null
  }
  return isPath ? raw : null
}
