import yaml from "js-yaml"
import type { ConfigIssue } from "./types"
import { UUID_PATTERN } from "./types"

/** Shared helpers for the config parsers. Pure functions; no file I/O. */

/** True for a plain YAML mapping. False for null, arrays, dates, and other values. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

export function childPath(parent: string, key: string): string {
  return parent === "" ? key : `${parent}.${key}`
}

export function hasOwn(record: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key)
}

export type LoadedMapping =
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; issue: ConfigIssue }

/**
 * Parse YAML text whose top level must be a mapping. js-yaml throws on syntax
 * errors and on duplicate keys; both become one issue with an empty path.
 */
export function loadYamlMapping(text: string): LoadedMapping {
  let parsed: unknown
  try {
    parsed = yaml.load(text)
  } catch (error) {
    return { ok: false, issue: { path: "", message: describeYamlError(error, text) } }
  }
  if (!isRecord(parsed)) {
    return { ok: false, issue: { path: "", message: "the top level must be a YAML mapping" } }
  }
  return { ok: true, value: parsed }
}

function describeYamlError(error: unknown, text: string): string {
  if (!(error instanceof yaml.YAMLException)) {
    return error instanceof Error ? error.message : String(error)
  }
  const mark = error.mark
  if (!mark) return error.reason
  const where = `line ${mark.line + 1}, column ${mark.column + 1}`
  if (error.reason === "duplicated mapping key") {
    const key = keyAt(text, mark.line, mark.column)
    return key === null ? `duplicate key (${where})` : `duplicate key "${key}" (${where})`
  }
  return `${error.reason} (${where})`
}

/** Read the mapping key that starts at the given 0-based position, if one is there. */
function keyAt(text: string, line: number, column: number): string | null {
  const rest = (text.split(/\r?\n/)[line] ?? "").slice(column)
  const match = /^(?:"([^"]*)"|'([^']*)'|([^:#]+?))\s*:/.exec(rest)
  return match ? (match[1] ?? match[2] ?? match[3]) : null
}

export function checkVersion(root: Record<string, unknown>, issues: ConfigIssue[]): void {
  if (root.version !== 1) issues.push({ path: "version", message: "must be the number 1" })
}

export function reportUnknownKeys(
  record: Record<string, unknown>,
  allowed: readonly string[],
  parentPath: string,
  issues: ConfigIssue[],
): void {
  for (const key of Object.keys(record)) {
    if (!allowed.includes(key)) {
      issues.push({
        path: childPath(parentPath, key),
        message: `unknown key "${key}"; allowed keys: ${allowed.join(", ")}`,
      })
    }
  }
}

/** Return the value when it is a UUID string. Otherwise record an issue and return "". */
export function readUuid(value: unknown, path: string, issues: ConfigIssue[]): string {
  if (typeof value === "string" && UUID_PATTERN.test(value)) return value
  issues.push({ path, message: "must be a lowercase UUID (8-4-4-4-12 hex digits)" })
  return ""
}
