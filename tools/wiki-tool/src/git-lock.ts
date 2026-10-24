/**
 * The git lock that the app, wiki-undo, and wiki-tool share.
 *
 * A tool that writes to the git repository of a wiki project takes
 * `<project>/.llm-wiki/git.lock` first, so two tools never run their git
 * commands at the same time. The file is created exclusively and holds
 * `{ "pid": <n>, "started_at": "<iso>", "tool": "<app|wiki-tool|wiki-undo>",
 * "host": "<hostname>", "platform": "<os>" }`.
 * A second tool polls every 200 ms for up to 30 s, then gives up with
 * "another wiki tool is using git". A lock is left over, and is removed and
 * taken over, when it is older than 10 minutes or when its `pid` is not a
 * running process on this machine. A pid says something only on the machine
 * and the platform that wrote it, so this early check applies only when the
 * lock's `host` and `platform` are this process's own.
 * A lock path that exists but cannot be read (a folder, no permission) counts as
 * held: the caller waits, then gives up. It never spins.
 *
 * The same rules are in `src-tauri/src/commands/git_history.rs` and in
 * `plugins/llm-wiki/skills/wiki-undo/scripts/undo.mjs`. Change all three together.
 * `.llm-wiki/` is git-ignored, so the lock is never committed.
 */
import { closeSync, lstatSync, mkdirSync, openSync, readFileSync, statSync, unlinkSync, writeSync } from "node:fs"
import { hostname } from "node:os"
import { join } from "node:path"
import { isDirectory } from "./io"

/** The error message when another tool keeps the lock for the whole wait. */
export const GIT_LOCK_BUSY_MESSAGE = "another wiki tool is using git"

const LOCK_FOLDER = ".llm-wiki"
const LOCK_FILE = "git.lock"
const LOCK_TOOL = "wiki-tool"
const DEFAULT_WAIT_MS = 30_000
const DEFAULT_STALE_MS = 10 * 60_000
const POLL_MS = 200

export interface GitLockOptions {
  /** How long to wait for another tool to let go. Default 30 s. */
  waitMs?: number
  /** The age after which a lock counts as left over. Default 10 minutes. */
  staleMs?: number
}

function readText(path: string): string | null {
  try {
    return readFileSync(path, "utf8")
  } catch {
    return null
  }
}

/**
 * True unless the path is certainly not there. A path that cannot be looked at for another reason counts as there:
 * the caller must not take it for a lock that is gone.
 */
function pathExists(path: string): boolean {
  try {
    lstatSync(path)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ENOENT"
  }
}

/**
 * How long ago the holder took the lock: by its `started_at`, or by the time of
 * the file when the text has no start time that parses (a lock that is being
 * written has no text yet). Null when the file is gone.
 */
function lockAgeMs(path: string, text: string): number | null {
  try {
    const startedAt: unknown = JSON.parse(text)?.started_at
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
 * without a usable pid says nothing, and `EPERM` means the process exists. The
 * pid is meaningful only on the machine and in the process namespace that
 * wrote it, so a lock whose `host` and `platform` are not this process's own
 * (or are missing) says nothing either: only its age counts.
 */
function holderIsGone(text: string): boolean {
  let pid: unknown
  try {
    const lock = JSON.parse(text)
    if (lock?.host !== hostname() || lock?.platform !== process.platform) return false
    pid = lock?.pid
  } catch {
    return false
  }
  // Signal 0 only checks that the process exists. Pid 0 would mean the whole process group.
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid < 1) return false
  try {
    process.kill(pid, 0)
    return false
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH"
  }
}

/**
 * Remove the lock only if it still holds `judged`, the text that was judged
 * stale. Another tool may have replaced the stale lock with its own since the
 * judgment, and that new lock must stay. Returns true when the caller should try
 * to take the lock again right away: the lock was removed, is gone, or was replaced.
 */
export function removeLockIfUnchanged(path: string, judged: string): boolean {
  const current = readText(path)
  // A lock that is there but cannot be read is not gone.
  if (current === null) return !pathExists(path)
  if (current !== judged) return true
  try {
    unlinkSync(path)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT"
  }
}

/** Remove the lock when it is stale. Returns true when the caller should try to take it again right away. */
function clearStaleLock(path: string, staleMs: number): boolean {
  const text = readText(path)
  // A lock that is there but cannot be read (a folder, no permission) is held: wait for it, do not retry at once.
  if (text === null) return !pathExists(path)
  const age = lockAgeMs(path, text)
  if (age === null) return true
  if (age <= staleMs && !holderIsGone(text)) return false
  return removeLockIfUnchanged(path, text)
}

/** Create the lock file. Returns what was written, or null when another tool holds the lock. */
function tryCreate(path: string): string | null {
  let fd: number
  try {
    fd = openSync(path, "wx")
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    // On Windows a lock that is being deleted reports EPERM instead of EEXIST.
    if (code === "EEXIST" || (code === "EPERM" && readText(path) !== null)) return null
    throw error
  }
  const text = JSON.stringify({
    pid: process.pid,
    started_at: new Date().toISOString(),
    tool: LOCK_TOOL,
    host: hostname(),
    platform: process.platform,
  })
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function acquire(path: string, waitMs: number, staleMs: number): Promise<string> {
  const deadline = Date.now() + waitMs
  for (;;) {
    const text = tryCreate(path)
    if (text !== null) return text
    if (clearStaleLock(path, staleMs)) continue
    const remaining = deadline - Date.now()
    if (remaining <= 0) throw new Error(GIT_LOCK_BUSY_MESSAGE)
    await sleep(Math.min(POLL_MS, remaining))
  }
}

/** Remove the lock, but only while it is still the one this call wrote. */
function release(path: string, text: string): void {
  if (readText(path) !== text) return
  try {
    unlinkSync(path)
  } catch {
    // Already gone.
  }
}

/**
 * Run `work` while holding the git lock of the project. Waits for another tool
 * to let go, then fails with "another wiki tool is using git". The lock is
 * released when `work` returns or throws.
 */
export async function withGitLock<T>(
  projectPath: string,
  work: () => Promise<T> | T,
  opts: GitLockOptions = {},
): Promise<T> {
  // `mkdir -p` below would create a project folder that does not exist.
  if (!isDirectory(projectPath)) throw new Error(`project folder not found: ${projectPath}`)
  const folder = join(projectPath, LOCK_FOLDER)
  mkdirSync(folder, { recursive: true })
  const path = join(folder, LOCK_FILE)
  const text = await acquire(path, opts.waitMs ?? DEFAULT_WAIT_MS, opts.staleMs ?? DEFAULT_STALE_MS)
  try {
    return await work()
  } finally {
    release(path, text)
  }
}
