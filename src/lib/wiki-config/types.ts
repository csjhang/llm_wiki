/** One problem found in a config file. `path` is "" for whole-file problems. */
export interface ConfigIssue {
  path: string
  message: string
}

export type ParseResult<T> =
  | { ok: true; value: T; issues: [] }
  | { ok: false; issues: ConfigIssue[] }

/** Lowercase UUID, 8-4-4-4-12 hex digits. Heptabase ids use this form. */
export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
