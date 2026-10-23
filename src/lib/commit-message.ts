// Pure helpers for git commit messages. Keep this file free of imports from
// `@/commands`, `@tauri-apps/*` and stores: the bundled wiki-tool reuses it
// outside the desktop app.

export type CommitPrefix = "ingest" | "fuse" | "recut" | "lint"

const MAX_SUBJECT_LENGTH = 72
const ELLIPSIS = "…"
const UNTITLED = "untitled"

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff
}

/**
 * Build `<prefix>: <title> (<N> pages)` plus a body that lists each path on
 * its own `- ` line. The subject never passes 72 characters; a title that does
 * not fit is cut and ends with `…`.
 */
export function buildActionCommitMessage(
  prefix: CommitPrefix,
  title: string,
  files: readonly string[],
): string {
  const head = `${prefix}: `
  const tail = ` (${files.length} pages)`
  const collapsed = title.replace(/\s+/g, " ").trim() || UNTITLED

  const room = MAX_SUBJECT_LENGTH - head.length - tail.length
  let shownTitle = collapsed
  if (collapsed.length > room) {
    let keep = Math.max(room - ELLIPSIS.length, 0)
    // Never leave half of a surrogate pair in front of the ellipsis.
    if (keep > 0 && isHighSurrogate(collapsed.charCodeAt(keep - 1))) keep -= 1
    shownTitle = collapsed.slice(0, keep) + ELLIPSIS
  }

  const subject = `${head}${shownTitle}${tail}`
  if (files.length === 0) return subject
  const body = files.map((file) => `- ${file.replace(/\\/g, "/")}`).join("\n")
  return `${subject}\n\n${body}`
}

/** File name without its last extension (`raw/sources/a.md` becomes `a`); `untitled` when there is no file name. */
export function titleFromSourcePath(sourcePath: string): string {
  const name = sourcePath.replace(/\\/g, "/").split("/").pop() ?? sourcePath
  const lastDot = name.lastIndexOf(".")
  const stem = lastDot > 0 ? name.slice(0, lastDot) : name
  return stem || UNTITLED
}
