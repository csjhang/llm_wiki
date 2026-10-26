/**
 * The marker file of the semantic lint: `.llm-wiki/semantic-lint.json`, `{ "commit": "<sha>", "at": "<ISO time>" }`.
 *
 * `lint mark` writes it with the sha of `HEAD`, or of the commit that `--commit` names. `lint changed-domains` reads it. The folder `.llm-wiki/` is never
 * committed.
 */
import { readFileSync } from "node:fs"
import { readGit } from "../git"
import { resolveInProject, writeFileAtomic } from "../io"

/** The marker file, relative to the project folder. */
export const MARKER_FILE = ".llm-wiki/semantic-lint.json"

/** A sha as the marker keeps it: 7 to 64 hex digits. Anything else could be read by git as an option or a name. */
const SHA_PATTERN = /^[0-9a-f]{7,64}$/i

/** True for text that can be the sha of a commit: 7 to 64 hex digits. */
export function isCommitSha(text: string): boolean {
  return SHA_PATTERN.test(text)
}

/** The full sha of `commit` when the repository has that commit, else null. `commit` must be `isCommitSha`. */
export function resolveCommit(project: string, commit: string): string | null {
  const found = readGit(project, ["rev-parse", "--verify", "--quiet", `${commit}^{commit}`])
  return found.status === 0 ? found.stdout.trim() : null
}

/**
 * The full sha of `commit` when it is a commit of the repository that is an ancestor of `HEAD` (or `HEAD` itself), else
 * null. `commit` must be `isCommitSha`. The commit may be unknown (the history was rewritten and the object is gone),
 * or known and on another line of history.
 */
export function ancestorOfHead(project: string, commit: string): string | null {
  const sha = resolveCommit(project, commit)
  if (sha === null) return null
  // Exit 0: an ancestor (or HEAD itself). Exit 1: not an ancestor.
  return readGit(project, ["merge-base", "--is-ancestor", sha, "HEAD"]).status === 0 ? sha : null
}

/** What the marker file says: nothing, a commit (in lower case), or why it cannot be used. */
export type MarkerState = { kind: "none" } | { kind: "commit"; commit: string } | { kind: "bad"; reason: string }

/**
 * The commit of the marker of a project. A missing file is "none". A file that cannot be read, is not JSON, or
 * has no usable `commit` is "bad", with the reason. The sha is not checked against the repository.
 */
export function readMarker(project: string): MarkerState {
  let text: string
  try {
    text = readFileSync(resolveInProject(project, MARKER_FILE), "utf8")
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? { kind: "none" } : { kind: "bad", reason: "it cannot be read" }
  }
  let marker: unknown
  try {
    marker = JSON.parse(text.replace(/^\uFEFF/, ""))
  } catch {
    return { kind: "bad", reason: "it is not valid JSON" }
  }
  const commit = typeof marker === "object" && marker !== null ? (marker as { commit?: unknown }).commit : undefined
  if (typeof commit !== "string" || !SHA_PATTERN.test(commit)) return { kind: "bad", reason: "it has no commit sha" }
  return { kind: "commit", commit: commit.toLowerCase() }
}

/** Write the marker, atomically. The folder `.llm-wiki/` is created when it is missing. */
export function writeMarker(project: string, commit: string, at: string): void {
  writeFileAtomic(resolveInProject(project, MARKER_FILE), `${JSON.stringify({ commit, at }, null, 2)}\n`)
}
