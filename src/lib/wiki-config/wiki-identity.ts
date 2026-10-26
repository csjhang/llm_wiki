import type { ConfigIssue, ParseResult } from "./types"
import { checkVersion, childPath, hasOwn, isRecord, loadYamlMapping, reportUnknownKeys } from "./yaml-util"

/**
 * `wiki.yaml` says what a wiki is. It is wiki-level config, not Heptabase config,
 * so a wiki without Heptabase can still say that it is a work wiki.
 * The Heptabase `wiki` property value comes from `id`.
 */
export const WIKI_ROLES = ["reading", "work"] as const
export type WikiRole = (typeof WIKI_ROLES)[number]

/**
 * The thresholds of the lint checks. They live under `lint:` in `wiki.yaml`. Every key is
 * optional and takes its default. Each value is a positive integer.
 */
export interface LintThresholds {
  /** A draft hypothesis page that was not updated for more days than this is stale. */
  draft_days: number
  /** A domain with more pages than this is too large. */
  max_domain_pages: number
  /** A domain with fewer pages than this is too small. */
  min_domain_pages: number
  /** The semantic lint reminder starts after this many ingests since the last semantic lint. */
  semantic_reminder_ingests: number
}

export const DEFAULT_LINT_THRESHOLDS: Readonly<LintThresholds> = {
  draft_days: 30,
  max_domain_pages: 200,
  min_domain_pages: 3,
  semantic_reminder_ingests: 10,
}

const LINT_KEYS = Object.keys(DEFAULT_LINT_THRESHOLDS) as (keyof LintThresholds)[]

export interface WikiIdentity {
  version: 1
  id: string
  role: WikiRole
  /** Path to the reading wiki. Null in a reading wiki. Required in a work wiki. */
  mechanism_library: string | null
  /** The lint thresholds with the defaults filled in. */
  lint: LintThresholds
}

const WIKI_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

const TOP_LEVEL_KEYS = ["version", "id", "role", "mechanism_library", "lint"] as const

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
  const lint = parseLint(root.lint, issues)

  if (issues.length > 0 || role === null) return { ok: false, issues }
  return {
    ok: true,
    value: { version: 1, id, role, mechanism_library: mechanismLibrary, lint },
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

/**
 * The `lint:` block. A missing block, or `lint:` with no value, gives the defaults.
 * A missing key takes its default. A value that is not a positive integer is an issue
 * that names the key. `min_domain_pages` must not be greater than `max_domain_pages`.
 */
function parseLint(raw: unknown, issues: ConfigIssue[]): LintThresholds {
  const lint: LintThresholds = { ...DEFAULT_LINT_THRESHOLDS }
  if (raw === undefined || raw === null) return lint
  if (!isRecord(raw)) {
    issues.push({ path: "lint", message: `must be a mapping with the optional keys ${LINT_KEYS.join(", ")}` })
    return lint
  }
  reportUnknownKeys(raw, LINT_KEYS, "lint", issues)
  for (const key of LINT_KEYS) {
    if (!hasOwn(raw, key)) continue
    const value = raw[key]
    if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) {
      lint[key] = value
    } else {
      issues.push({ path: childPath("lint", key), message: "must be a positive integer" })
    }
  }
  // Compare the resolved values, so a key that takes its default is compared too. A bad value is already reported.
  const valid = (key: keyof LintThresholds): boolean => issues.every((issue) => issue.path !== childPath("lint", key))
  if (valid("min_domain_pages") && valid("max_domain_pages") && lint.min_domain_pages > lint.max_domain_pages) {
    // Point at a key that the file sets, so the user sees the line to change.
    const at = hasOwn(raw, "min_domain_pages") ? "min_domain_pages" : "max_domain_pages"
    issues.push({
      path: childPath("lint", at),
      message: `min_domain_pages (${lint.min_domain_pages}) must not be greater than max_domain_pages (${lint.max_domain_pages})`,
    })
  }
  return lint
}
