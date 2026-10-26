/**
 * `wiki-tool lint mark` - record that the semantic lint has seen the wiki as it is at `HEAD`.
 *
 * `--project P` writes `.llm-wiki/semantic-lint.json` as `{ "commit": "<sha of HEAD>", "at": "<ISO time>" }` and gives
 * `{ ok: true, commit, at }`. `lint changed-domains` reads the marker. The write is atomic, and the folder
 * `.llm-wiki/` is created when it is missing. The marker is never committed. A project that is not a git
 * repository, and a repository with no commit, give exit 2 and no marker.
 */
import { readGit } from "../git"
import { type CommandResult, readJsonFile, resolveInProject, writeFileAtomic } from "../io"
import { parseLintArgs } from "./project"

/** The marker file, relative to the project folder. */
export const MARKER_FILE = ".llm-wiki/semantic-lint.json"

/** A sha as the marker keeps it: 7 to 64 hex digits. Anything else could be read by git as an option or a name. */
const SHA_PATTERN = /^[0-9a-f]{7,64}$/i

/** What the marker file says: nothing, a commit, or why it cannot be used. */
export type MarkerState = { kind: "none" } | { kind: "commit"; commit: string } | { kind: "bad"; reason: string }

/** The commit of the marker of a project. A missing file is "none". A file that cannot be used is "bad". */
export function readMarker(project: string): MarkerState {
  let path: string
  try {
    path = resolveInProject(project, MARKER_FILE)
  } catch (error) {
    return { kind: "bad", reason: error instanceof Error ? error.message : String(error) }
  }
  let marker: unknown
  try {
    marker = readJsonFile<unknown>(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { kind: "none" }
    const notJson = error instanceof Error && error.message.startsWith("cannot parse JSON file")
    return { kind: "bad", reason: notJson ? "it is not valid JSON" : "it cannot be read" }
  }
  const commit = typeof marker === "object" && marker !== null ? (marker as { commit?: unknown }).commit : undefined
  if (typeof commit !== "string" || !SHA_PATTERN.test(commit)) return { kind: "bad", reason: "it has no commit sha" }
  return { kind: "commit", commit: commit.toLowerCase() }
}

/** True when the folder is inside a git work tree. */
export function isGitWorkTree(project: string): boolean {
  const result = readGit(project, ["rev-parse", "--is-inside-work-tree"])
  return result.status === 0 && result.stdout.trim() === "true"
}

/** The sha of `HEAD`, or null when the repository has no commit. */
export function headCommit(project: string): string | null {
  const result = readGit(project, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"])
  return result.status === 0 ? result.stdout.trim() : null
}

export function lintMark(args: string[]): CommandResult {
  const parsed = parseLintArgs(args)
  if (!parsed.ok) return parsed.result
  const { project } = parsed

  if (!isGitWorkTree(project)) return { ok: false, problems: [`not inside a git work tree: ${project}`] }
  const commit = headCommit(project)
  if (commit === null) return { ok: false, problems: ["the repository has no commit yet; commit the wiki first"] }

  const at = new Date().toISOString()
  writeFileAtomic(resolveInProject(project, MARKER_FILE), `${JSON.stringify({ commit, at }, null, 2)}\n`)
  return { ok: true, commit, at }
}
