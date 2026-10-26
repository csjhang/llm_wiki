/**
 * The commit helper of wiki-tool.
 *
 * commitPaths makes a commit with the same rules as the app
 * (src-tauri/src/commands/git_history.rs): it commits only the paths it is given,
 * reads them literally, skips hooks and signing, fills the part of the identity
 * that git does not have, and never commits `.llm-wiki/`. It does not write
 * `.gitignore`: that file is committed only when the caller lists it.
 *
 * commitPaths does not take the git lock (it is synchronous). Callers use
 * commitPathsLocked, which holds `.llm-wiki/git.lock` around it.
 *
 * Runs `git` with execFileSync, so no shell reads the paths or the message.
 */
import { execFileSync } from "node:child_process"
import { existsSync } from "node:fs"
import { join, resolve } from "node:path"
import { type GitLockOptions, withGitLock } from "./git-lock"

export type CommitResult = { ok: true; sha: string | null } | { ok: false; problem: string }

const FALLBACK_NAME = "LLM Wiki"
const FALLBACK_EMAIL = "llm-wiki@localhost"
/** Top-level folders that are never committed: secrets and caches, and git itself. */
const NEVER_COMMITTED = [".llm-wiki", ".git"]

/** What git leaves in its folder while an operation is unfinished. */
const OPERATION_MARKERS: [marker: string, operation: string][] = [
  ["MERGE_HEAD", "merge"],
  ["REBASE_HEAD", "rebase"],
  ["CHERRY_PICK_HEAD", "cherry-pick"],
  ["REVERT_HEAD", "revert"],
  ["rebase-merge", "rebase"],
  ["rebase-apply", "rebase"],
]

export interface GitRun {
  status: number
  stdout: string
  stderr: string
}

/** Run `git -C <project> <args>`. A non-zero exit is a result, not an error. */
function runGit(project: string, args: string[]): GitRun {
  try {
    const stdout = execFileSync("git", ["-C", project, ...args], {
      encoding: "utf8",
      env: { ...process.env, LC_ALL: "C" },
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 256 * 1024 * 1024,
    })
    return { status: 0, stdout, stderr: "" }
  } catch (error) {
    const failure = error as { status?: number | null; stdout?: string; stderr?: string }
    // No status means git did not run at all (for example, it is not installed).
    if (typeof failure.status !== "number") throw error
    return { status: failure.status, stdout: failure.stdout ?? "", stderr: failure.stderr ?? "" }
  }
}

/**
 * Run a read-only git command in the project: `git -C <project> --literal-pathspecs <args>`. For `git log`,
 * `git diff`, `git show`, `git rev-parse` and the like. A non-zero exit is a result, not an error. It takes
 * no lock, so it must not write: use commitPathsLocked for a change.
 */
export function readGit(projectPath: string, args: string[]): GitRun {
  return runGit(resolve(projectPath), ["--literal-pathspecs", ...args])
}

/** True when the folder is inside a git work tree. */
export function isGitWorkTree(projectPath: string): boolean {
  const result = readGit(projectPath, ["rev-parse", "--is-inside-work-tree"])
  return result.status === 0 && result.stdout.trim() === "true"
}

/** The sha of `HEAD`, or null when the repository has no commit. */
export function headCommit(projectPath: string): string | null {
  const result = readGit(projectPath, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"])
  return result.status === 0 ? result.stdout.trim() : null
}

/** Run git and return stdout. A non-zero exit throws git's own message. */
function git(project: string, args: string[]): string {
  const result = runGit(project, args)
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || result.stdout.trim() || `git ${args.join(" ")} failed`)
  }
  return result.stdout
}

function nulEntries(output: string): string[] {
  return output.split("\0").filter((entry) => entry !== "")
}

/**
 * Check the paths and rewrite each one with `/` separators. Returns the paths,
 * or the problem text. A path must be inside the project and must not be
 * `.llm-wiki` or `.git`. `\` counts as a separator so the check holds on every platform.
 */
function checkPaths(paths: string[]): string[] | string {
  const checked: string[] = []
  for (const raw of paths) {
    const invalid = `Invalid path: ${JSON.stringify(raw)}`
    if (typeof raw !== "string" || raw.trim() === "" || raw.includes("\0")) return invalid
    // An absolute path, a drive letter, or git pathspec magic such as `:(top)`.
    if (/^[/\\:]/.test(raw) || raw[1] === ":") return invalid
    const segments = raw.split(/[/\\]/).filter((segment) => segment !== "" && segment !== ".")
    if (segments.length === 0 || segments.includes("..")) return invalid
    if (NEVER_COMMITTED.some((never) => segments[0].toLowerCase() === never)) {
      return `Refusing to commit ${JSON.stringify(raw)}: ${segments[0]} is never committed`
    }
    checked.push(segments.join("/"))
  }
  return [...new Set(checked)]
}

/** The operation git is in the middle of, or null. */
function operationInProgress(project: string): string | null {
  const gitDir = git(project, ["rev-parse", "--absolute-git-dir"]).trim()
  const found = OPERATION_MARKERS.find(([marker]) => existsSync(join(gitDir, marker)))
  return found ? found[1] : null
}

/** True when `git config <key>` prints a value. It exits 1 for a key that is not set. */
function hasConfig(project: string, key: string): boolean {
  return runGit(project, ["config", key]).stdout.trim() !== ""
}

/** `-c` options that fill the part of the identity that git does not have. Nothing is written to the git config. */
function identityArgs(project: string): string[] {
  const args: string[] = []
  if (!hasConfig(project, "user.name")) args.push("-c", `user.name=${FALLBACK_NAME}`)
  if (!hasConfig(project, "user.email")) args.push("-c", `user.email=${FALLBACK_EMAIL}`)
  return args
}

/**
 * The files at or under `paths` that differ from HEAD or from the work tree:
 * new, changed, or deleted, staged or not. Ignored files and folders with no
 * file are not in it. Names are relative to the project folder.
 */
function changedFiles(project: string, paths: string[]): { toAdd: string[]; changed: string[] } {
  const literal = ["--literal-pathspecs"]
  const untracked = git(project, [...literal, "ls-files", "-z", "--others", "--exclude-standard", "--", ...paths])
  const edited = git(project, [...literal, "ls-files", "-z", "--modified", "--deleted", "--", ...paths])
  // `--no-renames`: a staged rename must list both names. With rename detection
  // only the new name appears, and the commit would leave the deletion staged.
  const staged = git(project, [
    ...literal,
    ...["diff", "--cached", "--no-renames", "--name-only", "--relative", "-z"],
    ...["--", ...paths],
  ])
  const toAdd = [...new Set([...nulEntries(untracked), ...nulEntries(edited)])]
  return { toAdd, changed: [...new Set([...toAdd, ...nulEntries(staged)])] }
}

function commitChecked(project: string, paths: string[], message: string): CommitResult {
  const operation = operationInProgress(project)
  if (operation !== null) {
    return {
      ok: false,
      problem: `Cannot commit while a ${operation} is in progress. Finish or abort it, then try again.`,
    }
  }

  const { toAdd, changed } = changedFiles(project, paths)
  if (changed.length === 0) return { ok: true, sha: null }
  if (toAdd.length > 0) git(project, ["--literal-pathspecs", "add", "-A", "--", ...toAdd])
  // Staging can leave nothing to commit: a file touched but not changed.
  if (runGit(project, ["--literal-pathspecs", "diff", "--cached", "--quiet", "--", ...changed]).status === 0) {
    return { ok: true, sha: null }
  }

  // Signing and hooks are the user's own commit habits; an automated history
  // commit must not depend on a gpg agent or on a hook that may refuse it.
  git(project, [
    ...["-c", "commit.gpgsign=false"],
    ...identityArgs(project),
    ...["--literal-pathspecs", "commit", "--no-verify", "--quiet", "-m", message],
    // Path-limited: staged changes to any other path stay staged, uncommitted.
    ...["--", ...changed],
  ])
  return { ok: true, sha: git(project, ["rev-parse", "HEAD"]).trim() }
}

/**
 * Commit the changes at or under `paths` (project-relative files or folders)
 * and nothing else. Returns the new commit's sha, or `sha: null` when the paths
 * had nothing to commit. Returns `ok: false` with a problem text for a path that
 * is unsafe, for a project that is not a git repository, and while a merge,
 * rebase, cherry-pick, or revert is in progress. Does not take the git lock:
 * use commitPathsLocked.
 */
export function commitPaths(projectPath: string, paths: string[], message: string): CommitResult {
  const checked = checkPaths(paths)
  if (typeof checked === "string") return { ok: false, problem: checked }
  // No path means nothing to commit. Git would read an empty pathspec as "everything".
  if (checked.length === 0) return { ok: true, sha: null }
  const project = resolve(projectPath)
  try {
    if (git(project, ["rev-parse", "--is-inside-work-tree"]).trim() !== "true") {
      return { ok: false, problem: `Not inside a git work tree: ${project}` }
    }
    return commitChecked(project, checked, message)
  } catch (error) {
    return { ok: false, problem: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * commitPaths under the git lock of the project (`.llm-wiki/git.lock`): the
 * call to use. Waits for another tool to let go (30 s by default), then rejects
 * with "another wiki tool is using git". A refusal of commitPaths comes back as
 * its `{ ok: false, problem }` result, and the lock is released either way.
 */
export function commitPathsLocked(
  projectPath: string,
  paths: string[],
  message: string,
  lockOptions?: GitLockOptions,
): Promise<CommitResult> {
  return withGitLock(projectPath, () => commitPaths(projectPath, paths, message), lockOptions)
}
