#!/usr/bin/env node
// undo.mjs - list and revert the action commits of an LLM Wiki project.
//
// An action commit is a commit made by the app or by a skill, for example
// `ingest: <title> (<N> pages)`. This script needs Node 20 or later and git.
// It has no other dependency.
//
// Usage:
//   node undo.mjs list [--limit N] [--project PATH]
//   node undo.mjs revert <sha> [--project PATH]
//
// The script prints JSON to stdout. Exit codes: 0 for success, 2 for a handled
// failure (for example a conflict), 1 for an unexpected error.
//
// --project is the project folder: the folder that contains wiki/ and raw/.
// Both commands refuse a folder that has no wiki/ folder.
//
// A revert holds the project's git lock, `.llm-wiki/git.lock`, from the dirty
// check to the undo commit. The app and wiki-tool use the same lock. If another
// tool keeps it for 30 s, the revert stops with `"reason": "busy"`.

import { spawnSync } from "node:child_process"
import { closeSync, mkdirSync, openSync, readFileSync, realpathSync, statSync, unlinkSync, writeFileSync, writeSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

export const ACTION_PREFIXES = ["ingest:", "fuse:", "recut:", "lint:", "undo:"]

/** Files the app regenerates. A revert keeps the current version of these. */
export const GENERATED_PATHS = ["wiki/index.md", "wiki/log.md", "wiki/overview.md"]
const GENERATED_DIR = "wiki/indexes/"
const LOG_PATH = "wiki/log.md"
const LLM_WIKI_DIR = ".llm-wiki/"
/** An undo never changes these. A revert keeps their HEAD version. */
const KEPT_DIR = "raw/"
const KEPT_FILE = ".gitignore"
/** A commit that changed these cannot be undone: a revert could track secrets again. */
const PROTECTED_PATHS = [".llm-wiki", ".gitignore"]

const FALLBACK_NAME = "LLM Wiki"
const FALLBACK_EMAIL = "llm-wiki@localhost"

const FIELD_SEPARATOR = "\x1f"
const RECORD_SEPARATOR = "\x1e"

// ---------------------------------------------------------------------------
// Git lock
//
// The same lock as tools/wiki-tool/src/git-lock.ts and src-tauri/src/commands/git_history.rs:
// the file `<project>/.llm-wiki/git.lock`, created exclusively, holding
// `{ "pid", "started_at", "tool" }`. Wait up to 30 s, polling every 200 ms. A
// lock is left over, and is replaced, when it is older than 10 minutes or when
// its pid is not a running process on this machine. This script has no
// dependency and runs without a build step, so it carries its own small copy
// instead of importing the wiki-tool one. The copy is synchronous because
// revertAction is. Change the three copies together.

export const GIT_LOCK_BUSY_MESSAGE = "another wiki tool is using git"
const LOCK_FOLDER = ".llm-wiki"
const LOCK_FILE = "git.lock"
const LOCK_TOOL = "wiki-undo"
const LOCK_WAIT_MS = 30_000
const LOCK_STALE_MS = 10 * 60_000
const LOCK_POLL_MS = 200

function readLockText(path) {
  try {
    return readFileSync(path, "utf8")
  } catch {
    return null
  }
}

/** Block this thread for `ms` without spinning. */
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

/**
 * How long ago the holder took the lock: by its `started_at`, or by the time of
 * the file when the text has no start time that parses (a lock that is being
 * written has no text yet). Null when the file is gone.
 */
function lockAgeMs(path, text) {
  try {
    const startedAt = JSON.parse(text)?.started_at
    const time = typeof startedAt === "string" ? Date.parse(startedAt) : Number.NaN
    // A start time in the future (clock skew) counts as just started.
    if (Number.isFinite(time)) return Math.max(0, Date.now() - time)
  } catch {
    // Not JSON: fall back to the file time.
  }
  try {
    return Math.max(0, Date.now() - statSync(path).mtimeMs)
  } catch {
    return null
  }
}

/**
 * True when the lock names a process that does not run on this machine. A lock
 * without a usable pid says nothing, and EPERM means the process exists.
 */
function holderIsGone(text) {
  let pid
  try {
    pid = JSON.parse(text)?.pid
  } catch {
    return false
  }
  // Signal 0 only checks that the process exists. Pid 0 would mean the whole process group.
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid < 1) return false
  try {
    process.kill(pid, 0)
    return false
  } catch (error) {
    return error?.code === "ESRCH"
  }
}

/**
 * Remove the lock only if it still holds `judged`, the text that was judged
 * stale. Another tool may have replaced the stale lock with its own since the
 * judgment, and that new lock must stay. Returns true when the caller should try
 * to take the lock again right away: the lock was removed, is gone, or was replaced.
 */
function removeLockIfUnchanged(path, judged) {
  const current = readLockText(path)
  if (current === null) return true
  if (current !== judged) return true
  try {
    unlinkSync(path)
    return true
  } catch (error) {
    return error?.code === "ENOENT"
  }
}

/** Remove the lock when it is stale. Returns true when the caller should try to take it again right away. */
function clearStaleLock(path, staleMs) {
  const text = readLockText(path)
  if (text === null) return true
  const age = lockAgeMs(path, text)
  if (age === null) return true
  if (age <= staleMs && !holderIsGone(text)) return false
  return removeLockIfUnchanged(path, text)
}

/** Create the lock file. Returns what was written, or null when another tool holds the lock. */
function tryCreateLock(path) {
  let fd
  try {
    fd = openSync(path, "wx")
  } catch (error) {
    // On Windows a lock that is being deleted reports EPERM instead of EEXIST.
    if (error?.code === "EEXIST" || (error?.code === "EPERM" && readLockText(path) !== null)) return null
    throw error
  }
  const text = JSON.stringify({ pid: process.pid, started_at: new Date().toISOString(), tool: LOCK_TOOL })
  try {
    writeSync(fd, text)
  } catch (error) {
    closeSync(fd)
    try {
      unlinkSync(path)
    } catch {
      // Nothing more to do.
    }
    throw error
  }
  closeSync(fd)
  return text
}

/**
 * Take the git lock of the project, waiting for another tool to let go.
 * Returns a function that releases it, or null when the lock stayed taken for the
 * whole wait. The release removes the file only while it is still the one this
 * call wrote.
 */
function takeGitLock(project, { waitMs = LOCK_WAIT_MS, staleMs = LOCK_STALE_MS } = {}) {
  mkdirSync(join(project, LOCK_FOLDER), { recursive: true })
  const path = join(project, LOCK_FOLDER, LOCK_FILE)
  const deadline = Date.now() + waitMs
  for (;;) {
    const text = tryCreateLock(path)
    if (text !== null) {
      return () => {
        if (readLockText(path) !== text) return
        try {
          unlinkSync(path)
        } catch {
          // Already gone.
        }
      }
    }
    if (clearStaleLock(path, staleMs)) continue
    const remaining = deadline - Date.now()
    if (remaining <= 0) return null
    sleepSync(Math.min(LOCK_POLL_MS, remaining))
  }
}

function gitEnv() {
  // Never open an editor. Keep git messages stable.
  return { ...process.env, GIT_EDITOR: "true", LC_ALL: "C" }
}

/** Run `git -C <project> <args>`. Return { status, stdout, stderr }. Never throws on a non-zero exit. */
function runGit(project, args) {
  const result = spawnSync("git", ["-C", project, ...args], {
    encoding: "utf8",
    env: gitEnv(),
    maxBuffer: 256 * 1024 * 1024,
  })
  if (result.error) throw result.error
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" }
}

/** Run git and return stdout. Throw an Error with git's own message on a non-zero exit. */
function git(project, args) {
  const result = runGit(project, args)
  if (result.status !== 0) {
    const message = result.stderr.trim() || result.stdout.trim() || `git ${args.join(" ")} failed`
    throw new Error(message)
  }
  return result.stdout
}

function hasCommits(project) {
  return runGit(project, ["rev-parse", "--verify", "--quiet", "HEAD"]).status === 0
}

/** The path of the project folder inside its repository, with a trailing slash. Empty at the top. */
function projectPrefix(project) {
  return git(project, ["rev-parse", "--show-prefix"]).trim()
}

/** The project folder contains a `wiki/` folder. Used to catch a wrong `--project`, such as `<project>/wiki`. */
export function isWikiProject(project) {
  try {
    return statSync(join(project, "wiki")).isDirectory()
  } catch {
    return false
  }
}

function hasActionPrefix(subject) {
  return ACTION_PREFIXES.some((prefix) => subject.startsWith(prefix))
}

function isGeneratedPath(path) {
  return GENERATED_PATHS.includes(path) || path.startsWith(GENERATED_DIR)
}

/** `raw/` holds the sources and `.gitignore` keeps secrets out: an undo keeps both as they are. */
function isKeptPath(path) {
  return path.startsWith(KEPT_DIR) || path === KEPT_FILE
}

/** Whether the commit changed `.llm-wiki/` or `.gitignore` of the project. */
function touchesProtectedPath(project, sha) {
  const output = git(project, [
    "diff-tree",
    "--root",
    "--no-commit-id",
    "-r",
    "--name-only",
    sha,
    "--",
    ...PROTECTED_PATHS,
  ])
  return output.trim() !== ""
}

/**
 * Put `raw/` and `.gitignore` back to HEAD after the revert, in the index and
 * in the work tree. A file the revert removed comes back; a file it added goes away.
 */
function keepHeadVersionOfKeptPaths(project) {
  const changed = git(project, [
    "diff",
    "--cached",
    "--name-only",
    "--relative",
    "-z",
    "HEAD",
    "--",
    KEPT_DIR,
    KEPT_FILE,
  ])
    .split("\0")
    .filter((path) => path !== "")
  if (changed.length === 0) return
  git(project, ["--literal-pathspecs", "restore", "--source=HEAD", "--staged", "--worktree", "--", ...changed])
}

function localDate() {
  const now = new Date()
  const pad = (value) => String(value).padStart(2, "0")
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
}

/**
 * List the action commits that changed the project, newest first.
 * @param {string} projectPath
 * @param {number} [limit]
 * @returns {{ sha: string, subject: string, date: string }[]}
 */
export function listActions(projectPath, limit = 20) {
  const project = resolve(projectPath)
  if (!hasCommits(project)) {
    // An unborn branch has no history. A missing repository still throws here.
    git(project, ["rev-parse", "--git-dir"])
    return []
  }
  // --grep only narrows the search. The subject is checked again below.
  const output = git(project, [
    "log",
    "--no-merges",
    "--extended-regexp",
    `--grep=^(${ACTION_PREFIXES.map((prefix) => prefix.slice(0, -1)).join("|")}):`,
    `--format=%H${FIELD_SEPARATOR}%s${FIELD_SEPARATOR}%aI${RECORD_SEPARATOR}`,
    "--",
    ".",
  ])
  const actions = []
  for (const record of output.split(RECORD_SEPARATOR)) {
    const [sha, subject, date] = record.replace(/^\n/, "").split(FIELD_SEPARATOR)
    if (!sha || subject === undefined || !hasActionPrefix(subject)) continue
    actions.push({ sha, subject, date })
    if (actions.length >= limit) break
  }
  return actions
}

/** Repository paths with unmerged entries, relative to the repository top. */
function unmergedPaths(project) {
  const output = git(project, ["diff", "--name-only", "--diff-filter=U", "-z"])
  return output.split("\0").filter((path) => path !== "")
}

/**
 * Whether the work tree has changes that make a revert unsafe.
 * Changes under the project folder count, except untracked files under
 * `.llm-wiki/`. Staged changes elsewhere in the repository count too, because
 * the undo commit would include them.
 */
function isDirty(project, prefix) {
  const output = git(project, ["status", "--porcelain", "-z"])
  const entries = output.split("\0")
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]
    if (entry === "") continue
    const index = entry[0]
    const worktree = entry[1]
    const path = entry.slice(3)
    // A rename or copy entry is followed by a second entry with the old path.
    if (index === "R" || index === "C" || worktree === "R" || worktree === "C") i += 1
    const inProject = prefix === "" || path.startsWith(prefix)
    if (inProject) {
      const isLlmWikiFile = index === "?" && path.startsWith(prefix + LLM_WIKI_DIR)
      if (!isLlmWikiFile) return true
    } else if (index !== " " && index !== "?" && index !== "!") {
      return true
    }
  }
  return false
}

/** Give back the current version of a generated file that the revert could not merge. */
function keepCurrentVersion(project, path) {
  const stages = git(project, ["ls-files", "--unmerged", "-z", "--", path])
    .split("\0")
    .filter((line) => line !== "")
    .map((line) => line.split(/\s+/)[2])
  if (stages.includes("2")) {
    git(project, ["checkout", "--ours", "--", path])
    git(project, ["add", "--", path])
  } else {
    // The current version has no such file. Keep it that way.
    git(project, ["rm", "--force", "--quiet", "--", path])
  }
}

const NEEDS_ATTENTION =
  "The work tree is not clean after the undo stopped. Run git status in the project folder and fix it by hand."

/**
 * Stop the revert and check the tree. If the tree is still not clean, reset it
 * once more and restore the project files from HEAD. Return whether the tree is clean.
 */
function abortRevert(project, prefix) {
  const result = runGit(project, ["revert", "--abort"])
  if (result.status !== 0) runGit(project, ["reset", "--merge"])
  if (!isDirty(project, prefix)) return true
  runGit(project, ["reset", "--merge"])
  runGit(project, ["checkout", "HEAD", "--", "."])
  return !isDirty(project, prefix)
}

/** The text of `wiki/log.md` in HEAD. Empty when HEAD has no such file. */
function headLogText(project) {
  const result = runGit(project, ["show", `HEAD:./${LOG_PATH}`])
  return result.status === 0 ? result.stdout : ""
}

/**
 * Write `wiki/log.md` as the HEAD version plus one line. The log is append-only
 * history, so a revert never removes an entry from it.
 */
function writeLogWithLine(project, line) {
  let text = headLogText(project)
  if (text !== "" && !text.endsWith("\n")) text += "\n"
  const logFile = join(project, LOG_PATH)
  mkdirSync(dirname(logFile), { recursive: true })
  writeFileSync(logFile, `${text}${line}\n`)
}

/** Fill only the part of the identity that git does not have. Never write to the git config. */
function identityArgs(project) {
  const args = []
  if (runGit(project, ["config", "user.name"]).stdout.trim() === "") {
    args.push("-c", `user.name=${FALLBACK_NAME}`)
  }
  if (runGit(project, ["config", "user.email"]).stdout.trim() === "") {
    args.push("-c", `user.email=${FALLBACK_EMAIL}`)
  }
  return args
}

/**
 * Revert one action commit and record the undo.
 * @param {string} projectPath The project folder: the folder that contains `wiki/` and `raw/`.
 * @param {string} sha The commit to undo.
 * @param {string} [today] Date for the log line, `YYYY-MM-DD`. Defaults to the local date.
 * @param {{ lockWaitMs?: number, lockStaleMs?: number }} [options] How long to wait for the git lock (default 30 s)
 *   and how old a lock must be to count as left over (default 10 minutes).
 * @returns {{ ok: true, sha: string, reverted: string } | { ok: false, reason: "conflict", files: string[] } | { ok: false, reason: "busy", message: string } | { ok: false, reason: "not-action" | "dirty" | "not-a-wiki-project" | "protected" }}
 *   On success `sha` is the full sha of the new undo commit. `reverted` is the full sha of the commit that was undone.
 */
export function revertAction(projectPath, sha, today = localDate(), options = {}) {
  const project = resolve(projectPath)
  if (!isWikiProject(project)) return { ok: false, reason: "not-a-wiki-project" }
  const prefix = projectPrefix(project)

  // A sha that starts with `-` would read as a git option.
  if (typeof sha !== "string" || sha === "" || sha.startsWith("-")) return { ok: false, reason: "not-action" }
  const resolved = runGit(project, ["rev-parse", "--verify", "--quiet", `${sha}^{commit}`])
  if (resolved.status !== 0) return { ok: false, reason: "not-action" }
  const fullSha = resolved.stdout.trim()

  // The commit must be part of the current history.
  if (runGit(project, ["merge-base", "--is-ancestor", fullSha, "HEAD"]).status !== 0) {
    return { ok: false, reason: "not-action" }
  }
  const subject = git(project, ["log", "-1", "--format=%s", fullSha]).trim()
  const parents = git(project, ["rev-list", "--parents", "-n", "1", fullSha]).trim().split(/\s+/).slice(1)
  if (!hasActionPrefix(subject) || parents.length > 1) return { ok: false, reason: "not-action" }
  if (touchesProtectedPath(project, fullSha)) return { ok: false, reason: "protected" }

  // From here the script changes the repository. Another tool must not commit or
  // stage between the dirty check and the undo commit, so the lock starts before the check.
  const release = takeGitLock(project, { waitMs: options.lockWaitMs, staleMs: options.lockStaleMs })
  if (release === null) return { ok: false, reason: "busy", message: GIT_LOCK_BUSY_MESSAGE }
  try {
    return revertLocked(project, prefix, fullSha, subject, today)
  } finally {
    release()
  }
}

/** The part of revertAction that runs under the git lock. */
function revertLocked(project, prefix, fullSha, subject, today) {
  if (isDirty(project, prefix)) return { ok: false, reason: "dirty" }

  const revert = runGit(project, ["revert", "--no-commit", fullSha])
  let stopped = false
  try {
    const conflicted = revert.status === 0 ? [] : unmergedPaths(project)
    if (revert.status !== 0 && conflicted.length === 0) {
      throw new Error(revert.stderr.trim() || `git revert ${fullSha} failed`)
    }

    const toProjectPath = (path) => (prefix !== "" && path.startsWith(prefix) ? path.slice(prefix.length) : path)
    for (const path of conflicted) {
      const projectRelative = toProjectPath(path)
      if (projectRelative === path && prefix !== "") continue // outside the project: not generated
      if (isGeneratedPath(projectRelative) || isKeptPath(projectRelative)) keepCurrentVersion(project, projectRelative)
    }

    const remaining = revert.status === 0 ? [] : unmergedPaths(project)
    if (remaining.length > 0) {
      stopped = true
      if (!abortRevert(project, prefix)) throw new Error(NEEDS_ATTENTION)
      return { ok: false, reason: "conflict", files: remaining.map(toProjectPath) }
    }

    // An undo changes only the wiki: sources and .gitignore keep their HEAD version.
    keepHeadVersionOfKeptPaths(project)
    // Whether the revert touched wiki/log.md or not, start from the HEAD version.
    writeLogWithLine(project, `## [${today}] undo | ${subject}`)
    git(project, ["add", "--", LOG_PATH])
    git(project, [
      ...["-c", "commit.gpgsign=false"],
      ...identityArgs(project),
      ...["commit", "--no-verify", "--quiet", "-m", `undo: ${subject}`, "-m", `Reverts ${fullSha}.`],
    ])
    return { ok: true, sha: git(project, ["rev-parse", "HEAD"]).trim(), reverted: fullSha }
  } catch (error) {
    if (stopped) throw error
    if (!abortRevert(project, prefix)) {
      const message = error instanceof Error ? error.message : String(error)
      throw new Error(`${message} ${NEEDS_ATTENTION}`)
    }
    throw error
  }
}

// ---------------------------------------------------------------------------
// Command line

function parseArguments(argv) {
  const positional = []
  const options = {}
  for (let i = 0; i < argv.length; i++) {
    const argument = argv[i]
    if (argument === "--project" || argument === "--limit") {
      const value = argv[i + 1]
      if (value === undefined) throw new Error(`${argument} needs a value`)
      options[argument.slice(2)] = value
      i += 1
    } else if (argument.startsWith("--")) {
      throw new Error(`Unknown option: ${argument}`)
    } else {
      positional.push(argument)
    }
  }
  return { positional, options }
}

function main(argv) {
  const { positional, options } = parseArguments(argv)
  const [command, ...rest] = positional
  const project = resolve(options.project ?? process.cwd())

  if (command === "list" && rest.length === 0) {
    let limit = 20
    if (options.limit !== undefined) {
      limit = Number(options.limit)
      if (!Number.isInteger(limit) || limit < 1) throw new Error("--limit needs a whole number of 1 or more")
    }
    if (!isWikiProject(project)) return { code: 2, output: { ok: false, reason: "not-a-wiki-project" } }
    return { code: 0, output: listActions(project, limit) }
  }
  if (command === "revert" && rest.length === 1 && options.limit === undefined) {
    const result = revertAction(project, rest[0], localDate())
    return { code: result.ok ? 0 : 2, output: result }
  }
  throw new Error("Usage: node undo.mjs list [--limit N] [--project PATH] | node undo.mjs revert <sha> [--project PATH]")
}

function isEntryPoint() {
  if (!process.argv[1]) return false
  let entry = process.argv[1]
  try {
    entry = realpathSync(entry)
  } catch {
    // Keep the path as given.
  }
  return import.meta.url === pathToFileURL(entry).href || fileURLToPath(import.meta.url) === entry
}

if (isEntryPoint()) {
  try {
    const { code, output } = main(process.argv.slice(2))
    process.stdout.write(`${JSON.stringify(output, null, 2)}\n`)
    process.exitCode = code
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    process.stdout.write(`${JSON.stringify({ ok: false, reason: "error", message }, null, 2)}\n`)
    process.exitCode = 1
  }
}
