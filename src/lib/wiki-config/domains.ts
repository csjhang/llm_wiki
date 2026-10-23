import type { ConfigIssue, ParseResult } from "./types"
import {
  checkVersion,
  childPath,
  isRecord,
  loadYamlMapping,
  readUuid,
  reportUnknownKeys,
} from "./yaml-util"

export const DOMAIN_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*(?:\/[a-z0-9]+(?:-[a-z0-9]+)*)*$/

export const KNOWN_LENSES = ["business", "physics", "hardware", "ai"] as const

export interface DomainEntry {
  lens: string
  description: string
  whiteboards: string[]
}

export interface DomainsConfig {
  version: 1
  domains: Record<string, DomainEntry>
}

const TOP_LEVEL_KEYS = ["version", "domains"] as const
const ENTRY_KEYS = ["lens", "description", "whiteboards"] as const

/** Parent of a domain path: "a/b/c" gives "a/b"; a top-level domain gives null. */
export function domainParent(name: string): string | null {
  const slash = name.lastIndexOf("/")
  return slash === -1 ? null : name.slice(0, slash)
}

/**
 * Parse and validate the text of `domains.yaml`. Collects every issue before
 * returning. `knownLenses` defaults to the four built-in lenses.
 */
export function parseDomainsYaml(
  text: string,
  knownLenses: readonly string[] = KNOWN_LENSES,
): ParseResult<DomainsConfig> {
  const loaded = loadYamlMapping(text)
  if (!loaded.ok) return { ok: false, issues: [loaded.issue] }

  const root = loaded.value
  const issues: ConfigIssue[] = []
  checkVersion(root, issues)
  reportUnknownKeys(root, TOP_LEVEL_KEYS, "", issues)
  const domains = parseDomains(root.domains, knownLenses, issues)

  if (issues.length > 0) return { ok: false, issues }
  return { ok: true, value: { version: 1, domains }, issues: [] }
}

function parseDomains(
  raw: unknown,
  knownLenses: readonly string[],
  issues: ConfigIssue[],
): Record<string, DomainEntry> {
  const domains: Record<string, DomainEntry> = {}
  // `domains:` with no value is an empty list, as is a missing key.
  if (raw === undefined || raw === null) return domains
  if (!isRecord(raw)) {
    issues.push({ path: "domains", message: "must be a mapping of domain name to entry" })
    return domains
  }
  for (const [name, entry] of Object.entries(raw)) {
    const path = childPath("domains", name)
    const validName = DOMAIN_NAME_PATTERN.test(name)
    if (!validName) {
      issues.push({
        path,
        message: `invalid domain name "${name}"; use lowercase letters, digits, and "-", with "/" between levels`,
      })
    }
    const parsed = parseEntry(entry, path, knownLenses, issues)
    if (validName) domains[name] = parsed
  }
  return domains
}

function parseEntry(
  raw: unknown,
  path: string,
  knownLenses: readonly string[],
  issues: ConfigIssue[],
): DomainEntry {
  const entry: DomainEntry = { lens: "", description: "", whiteboards: [] }
  if (!isRecord(raw)) {
    issues.push({ path, message: "must be a mapping with lens, description, and optional whiteboards" })
    return entry
  }
  reportUnknownKeys(raw, ENTRY_KEYS, path, issues)

  if (typeof raw.lens === "string" && knownLenses.includes(raw.lens)) {
    entry.lens = raw.lens
  } else {
    issues.push({
      path: childPath(path, "lens"),
      message: `must be one of: ${knownLenses.join(", ")}`,
    })
  }

  if (typeof raw.description === "string" && raw.description.trim() !== "") {
    entry.description = raw.description
  } else {
    issues.push({ path: childPath(path, "description"), message: "must be a non-empty string" })
  }

  entry.whiteboards = parseWhiteboardIds(raw.whiteboards, childPath(path, "whiteboards"), issues)
  return entry
}

function parseWhiteboardIds(raw: unknown, path: string, issues: ConfigIssue[]): string[] {
  if (raw === undefined || raw === null) return []
  if (!Array.isArray(raw)) {
    issues.push({ path, message: "must be a list of whiteboard UUIDs" })
    return []
  }
  const ids: string[] = []
  raw.forEach((item, index) => {
    const id = readUuid(item, `${path}[${index}]`, issues)
    if (id !== "") ids.push(id)
  })
  return ids
}
