import { ask } from "@tauri-apps/plugin-dialog"
import {
  gitCommitAll,
  gitCommitPaths,
  gitHead,
  gitInfo,
  gitInit,
  gitRestorePaths,
} from "@/commands/git"
import { deleteFile, fileExists, readFile, writeFile } from "@/commands/fs"
import { invalidateProjectFileSnapshotPaths } from "@/commands/file-sync"
import { getStore } from "@/lib/project-store"
import { getFileName, isAbsolutePath, normalizePath } from "@/lib/path-utils"
import { parsedMarkdownOutputPath } from "@/lib/parsed-source-output"
import { sourceIdentityForPath, sourceSummarySlugFromIdentity } from "@/lib/source-identity"
import { useActivityStore } from "@/stores/activity-store"
import { buildActionCommitMessage } from "./commit-message"

export { buildActionCommitMessage, titleFromSourcePath } from "./commit-message"

export type GitHistoryMode = "ask" | "on" | "off"

export interface GitHistoryDeps {
  /** Stored choice for the project. `"ask"` when nothing is stored. */
  loadMode(projectId: string): Promise<GitHistoryMode>
  saveMode(projectId: string, mode: GitHistoryMode): Promise<void>
  askUser(message: string): Promise<boolean>
}

const MODE_KEY_PREFIX = "gitHistoryMode:"

const ASK_MESSAGE =
  "Turn on version history for this wiki? Each ingest becomes one git commit that you can undo."
const BASELINE_MESSAGE = "chore: save changes before ingest"
const INFLIGHT_FILE = ".llm-wiki/git-inflight.json"

function modeKey(projectId: string): string {
  return `${MODE_KEY_PREFIX}${projectId}`
}

function nestedAskMessage(topLevel: string): string {
  return `This wiki is inside another git repository at ${topLevel}. Turn on version history and record each ingest there? Commits include only this wiki folder.`
}

export const defaultGitHistoryDeps: GitHistoryDeps = {
  async loadMode(projectId) {
    const store = await getStore()
    const saved = await store.get<string>(modeKey(projectId))
    return saved === "on" || saved === "off" ? saved : "ask"
  },
  async saveMode(projectId, mode) {
    const store = await getStore()
    await store.set(modeKey(projectId), mode)
    await store.save()
  },
  async askUser(message) {
    return ask(message, { title: "Version history", kind: "info" })
  },
}

// One answer per project for the whole session. The promise is cached, not the
// boolean, so two ingests starting together share one prompt.
const resolved = new Map<string, Promise<boolean>>()
// The settled answers, kept beside the promises so sync callers can read them.
const decisions = new Map<string, boolean>()

/** Forget the cached answer for one project, or for every project when no id is given. */
export function resetGitHistoryCache(projectId?: string): void {
  if (projectId === undefined) {
    resolved.clear()
    decisions.clear()
  } else {
    resolved.delete(projectId)
    decisions.delete(projectId)
  }
}

/**
 * The settled answer for this project, read without waiting. `undefined` while
 * the answer is still pending, was never asked for, or could not be resolved.
 */
export function getCachedGitHistory(projectId: string): boolean | undefined {
  return decisions.get(projectId)
}

/** Whether version history is known to be on for this project. `false` when off or not settled yet. */
export function isGitHistoryOnCached(projectId: string): boolean {
  return decisions.get(projectId) === true
}

async function decide(
  projectId: string,
  projectPath: string,
  deps: GitHistoryDeps,
): Promise<boolean> {
  // A stored "off" needs no git probe at all.
  const mode = await deps.loadMode(projectId)
  if (mode === "off") return false

  const info = await gitInfo(projectPath)
  if (!info.available) return false
  if (mode === "on") {
    if (!info.isRepo) await gitInit(projectPath)
    return true
  }

  // mode === "ask"
  if (info.isRepo && info.isRoot) {
    await deps.saveMode(projectId, "on")
    return true
  }
  // A project nested in a bigger repo would record its history in that repo:
  // name it, so the user knows which repository the commits go to.
  const question = info.isRepo && info.topLevel ? nestedAskMessage(info.topLevel) : ASK_MESSAGE
  if (await deps.askUser(question)) {
    // A project nested in a bigger repo uses that repo: commits stay limited to
    // the project folder, so no new repository is created here.
    if (!info.isRepo) await gitInit(projectPath)
    await deps.saveMode(projectId, "on")
    return true
  }
  await deps.saveMode(projectId, "off")
  return false
}

/**
 * Decide whether git history is on for this project, asking the user the first
 * time. Resolves `true` when on. A git or store failure logs a warning and
 * resolves `false` without caching, so a later ingest tries again.
 */
export function resolveGitHistory(
  projectId: string,
  projectPath: string,
  deps: GitHistoryDeps = defaultGitHistoryDeps,
): Promise<boolean> {
  const cached = resolved.get(projectId)
  if (cached) return cached

  const pending: Promise<boolean> = decide(projectId, projectPath, deps)
    .then((on) => {
      // A reset while the answer was in flight drops it.
      if (resolved.get(projectId) === pending) decisions.set(projectId, on)
      return on
    })
    .catch((err: unknown) => {
      console.warn("[git-history] could not resolve version history:", err)
      resolved.delete(projectId)
      return false
    })
  resolved.set(projectId, pending)
  return pending
}

// ── Ingest runs ──────────────────────────────────────────────────────────

/**
 * One ingest run, as the queue sees it. The object itself identifies the run:
 * a task restarted after a project switch is a new run with the same task id.
 */
export interface IngestHistoryRun {
  readonly taskId: string
  /** The task's source: project-relative (`raw/sources/a.pdf`) or absolute. */
  readonly sourcePath: string
}

/** `.llm-wiki/git-inflight.json`: the open run, so a crash can be undone at the next start. */
interface InflightRecord {
  taskId: string
  sourcePath: string
  /** HEAD after the baseline. A restore is only safe while HEAD is still this commit. */
  baselineSha: string
  /** Project-relative paths the run wrote so far. */
  paths: string[]
  startedAt: number
}

interface OpenRun {
  record: InflightRecord
  /** A newer baseline or a recovery already put this run's files back. */
  superseded: boolean
  closed: boolean
  writeQueued: boolean
}

let openRuns = new WeakMap<IngestHistoryRun, OpenRun>()
/** The run that owns each project's in-flight record. */
const currentRuns = new Map<string, OpenRun>()
/** Every git action of a project runs after the previous one has settled. */
const gitChains = new Map<string, Promise<void>>()

/** Forget every open run. For tests; the queue never needs it. */
export function resetIngestHistoryRuns(): void {
  openRuns = new WeakMap()
  currentRuns.clear()
  gitChains.clear()
}

/** The open run of `run`, unless it has already been committed or restored. */
function liveRun(run: IngestHistoryRun | undefined): OpenRun | undefined {
  const open = run ? openRuns.get(run) : undefined
  return open && !open.closed ? open : undefined
}

function projectKey(projectPath: string): string {
  return normalizePath(projectPath).replace(/\/+$/, "")
}

/**
 * Run `action` after every git action already queued for this project, so a
 * stale run's commit or restore never interleaves with a new run's baseline.
 */
function serialized<T>(projectPath: string, action: () => Promise<T>): Promise<T> {
  const key = projectKey(projectPath)
  const previous = gitChains.get(key) ?? Promise.resolve()
  const result = previous.then(action)
  const tail = result.then(
    () => undefined,
    () => undefined,
  )
  gitChains.set(key, tail)
  void tail.then(() => {
    if (gitChains.get(key) === tail) gitChains.delete(key)
  })
  return result
}

/** git's message for an error, cut to its first line. */
function firstLine(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err)
  const line = text
    .split(/\r?\n/)
    .map((part) => part.trim())
    .find((part) => part !== "")
  if (!line) return "unknown error"
  return line.length > 240 ? `${line.slice(0, 239)}…` : line
}

/** Put a warning in the activity panel. Never throws. */
function showWarning(sourcePath: string | undefined, detail: string, files: readonly string[] = []): void {
  try {
    useActivityStore.getState().addItem({
      type: "ingest",
      title: sourcePath ? getFileName(sourcePath) : "Version history",
      status: "error",
      detail,
      filesWritten: [...files],
    })
  } catch (err) {
    console.warn("[git-history] could not show a warning:", err)
  }
}

function uniquePaths(paths: Iterable<string>): string[] {
  const seen = new Set<string>()
  const unique: string[] = []
  for (const path of paths) {
    const normalized = normalizePath(path)
    if (normalized === "" || seen.has(normalized)) continue
    seen.add(normalized)
    unique.push(normalized)
  }
  return unique
}

/**
 * A path a restore may touch: project-relative, inside `wiki/`, never `wiki/`
 * itself. git_restore_paths refuses the whole call for any other path, so the
 * same rule is applied here first.
 */
function isRestorablePath(path: string): boolean {
  if (/^([\\/]|[A-Za-z]:|:)/.test(path)) return false
  const segments = path.split(/[\\/]/).filter((segment) => segment !== "" && segment !== ".")
  return segments.length >= 2 && segments[0] === "wiki" && !segments.includes("..")
}

/** `sourcePath` relative to the project, or `null` when it lies outside it. */
function projectRelative(projectPath: string, sourcePath: string): string | null {
  const pp = projectKey(projectPath)
  const sp = normalizePath(sourcePath)
  if (!isAbsolutePath(sp)) return sp.replace(/^(\.\/)+/, "")
  return sp.startsWith(`${pp}/`) ? sp.slice(pp.length + 1) : null
}

function absoluteSource(projectPath: string, sourcePath: string): string {
  const sp = normalizePath(sourcePath)
  return isAbsolutePath(sp) ? sp : `${projectKey(projectPath)}/${sp}`
}

/** `wiki/media/<source-slug>/` when that folder exists, else `null`. */
async function existingMediaFolder(projectPath: string, sourcePath: string): Promise<string | null> {
  const slug = sourceSummarySlugFromIdentity(sourceIdentityForPath(projectKey(projectPath), sourcePath))
  if (!slug) return null
  const folder = `wiki/media/${slug}`
  try {
    return (await fileExists(`${projectKey(projectPath)}/${folder}`)) ? `${folder}/` : null
  } catch {
    return null
  }
}

function inflightPath(projectPath: string): string {
  return `${projectKey(projectPath)}/${INFLIGHT_FILE}`
}

async function writeInflight(projectPath: string, record: InflightRecord): Promise<void> {
  try {
    await writeFile(inflightPath(projectPath), JSON.stringify(record, null, 2))
  } catch (err) {
    console.warn("[git-history] could not write the in-flight record:", err)
  }
}

async function deleteInflight(projectPath: string): Promise<void> {
  try {
    await deleteFile(inflightPath(projectPath))
  } catch {
    // Already gone.
  }
}

async function readInflight(projectPath: string): Promise<InflightRecord | "unreadable" | null> {
  let text: string
  try {
    text = await readFile(inflightPath(projectPath))
  } catch {
    return null
  }
  try {
    const parsed = JSON.parse(text) as Partial<InflightRecord>
    if (
      typeof parsed.taskId !== "string" ||
      typeof parsed.sourcePath !== "string" ||
      typeof parsed.baselineSha !== "string" ||
      !Array.isArray(parsed.paths) ||
      parsed.paths.some((path) => typeof path !== "string")
    ) {
      return "unreadable"
    }
    return parsed as InflightRecord
  } catch {
    return "unreadable"
  }
}

/** The run stops owning the in-flight record; the record is deleted if it is still this run's. */
async function closeRun(projectPath: string, open: OpenRun | undefined): Promise<void> {
  if (!open || open.closed) return
  open.closed = true
  const key = projectKey(projectPath)
  if (currentRuns.get(key) !== open) return
  currentRuns.delete(key)
  await deleteInflight(projectPath)
}

/** Forget the generation checkpoints and the ingest-cache entry of this source. */
async function clearResumeState(projectPath: string, sourcePath: string): Promise<void> {
  try {
    const { clearIngestResumeState } = await import("@/lib/ingest")
    await clearIngestResumeState(projectKey(projectPath), sourcePath)
  } catch (err) {
    console.warn("[git-history] could not clear the resume state:", err)
  }
}

/**
 * Restore `paths` from HEAD. The file watcher learns first that these paths
 * change because of the app, so a page the restore deletes is not handled as
 * an external delete (which would clean up links and the index). Throws on a
 * git failure.
 */
async function restorePaths(projectPath: string, paths: readonly string[]): Promise<void> {
  if (paths.length === 0) return
  try {
    await invalidateProjectFileSnapshotPaths(projectKey(projectPath), [...paths])
  } catch (err) {
    console.warn("[git-history] could not update the file watcher before a restore:", err)
  }
  await gitRestorePaths(projectKey(projectPath), paths)
}

/**
 * Undo a run that the app did not finish (a crash, or a run still open when a
 * newer one starts). Runs inside the project's git chain.
 */
async function recoverInflight(projectPath: string): Promise<void> {
  const key = projectKey(projectPath)
  const current = currentRuns.get(key)
  const stored = current ? current.record : await readInflight(projectPath)
  if (stored === null) return
  if (current) {
    current.superseded = true
    currentRuns.delete(key)
  }
  if (stored === "unreadable") {
    console.warn("[git-history] deleting an unreadable in-flight record")
    await deleteInflight(projectPath)
    return
  }

  try {
    const head = (await gitHead(key)) ?? ""
    // Only while HEAD is still the run's baseline do the restored versions
    // predate the run. Otherwise its commit (or another one) already landed.
    if (head === stored.baselineSha) {
      const paths = uniquePaths(stored.paths).filter(isRestorablePath)
      const media = await existingMediaFolder(projectPath, stored.sourcePath)
      await restorePaths(projectPath, media ? [...paths, media] : paths)
      await clearResumeState(projectPath, stored.sourcePath)
      if (paths.length > 0) {
        console.warn(`[git-history] put back ${paths.length} files of an interrupted ingest of ${stored.sourcePath}`)
        showWarning(
          stored.sourcePath,
          `Version history put back ${paths.length} files of an ingest that was interrupted.`,
          paths,
        )
      }
    }
  } catch (err) {
    console.warn("[git-history] could not put back an interrupted ingest:", err)
    showWarning(
      stored.sourcePath,
      `Version history could not put back the files of an ingest that was interrupted: ${firstLine(err)}`,
    )
  }
  await deleteInflight(projectPath)
}

/**
 * Undo an ingest that the app did not finish: a crash or a quit while it ran.
 * Call it when a project's queue starts; the next baseline also calls it.
 * Never rejects.
 */
export function recoverInterruptedIngest(projectPath: string): Promise<void> {
  return serialized(projectPath, () => recoverInflight(projectPath)).catch((err: unknown) => {
    console.warn("[git-history] recovery failed:", err)
  })
}

/**
 * Commit whatever is already uncommitted, so the ingest commit and a later
 * restore start from a recorded state. With a `run`, also start its in-flight
 * record. Resolves `true` for a new commit or when there was nothing to
 * commit, `false` when git failed (a restore is then not safe).
 */
export function prepareIngestBaseline(projectPath: string, run?: IngestHistoryRun): Promise<boolean> {
  return serialized(projectPath, async () => {
    await recoverInflight(projectPath)
    let sha: string | null
    try {
      sha = await gitCommitAll(projectKey(projectPath), BASELINE_MESSAGE)
    } catch (err) {
      console.warn("[git-history] baseline commit failed:", err)
      showWarning(run?.sourcePath, `Version history could not record this ingest: ${firstLine(err)}`)
      return false
    }
    if (!run) return true

    let baselineSha = sha
    if (baselineSha === null) {
      try {
        baselineSha = (await gitHead(projectKey(projectPath))) ?? ""
      } catch (err) {
        console.warn("[git-history] could not read HEAD after the baseline:", err)
        return true
      }
    }
    const open: OpenRun = {
      record: {
        taskId: run.taskId,
        sourcePath: run.sourcePath,
        baselineSha,
        paths: [],
        startedAt: Date.now(),
      },
      superseded: false,
      closed: false,
      writeQueued: false,
    }
    openRuns.set(run, open)
    currentRuns.set(projectKey(projectPath), open)
    await writeInflight(projectPath, open.record)
    return true
  })
}

/**
 * Note a path the run just wrote, so the in-flight record lists it. Sync and
 * cheap: the record is written later, in the project's git chain.
 */
export function trackIngestPath(projectPath: string, run: IngestHistoryRun, relativePath: string): void {
  const open = liveRun(run)
  if (!open || open.superseded) return
  const path = normalizePath(relativePath)
  if (open.record.paths.includes(path)) return
  open.record.paths.push(path)
  if (open.writeQueued) return
  open.writeQueued = true
  void serialized(projectPath, async () => {
    open.writeQueued = false
    if (!open.closed && !open.superseded) await writeInflight(projectPath, open.record)
  })
}

/**
 * Commit an ingest. The commit holds only this run's paths: `files` (listed in
 * the message), `extraPaths`, the paths the run tracked, its media folder, its
 * source and parsed copy, and `.gitignore`. Anything else stays uncommitted
 * until the next baseline. Resolves the SHA, or `null` when nothing changed or
 * git failed.
 */
export function commitIngest(
  projectPath: string,
  title: string,
  files: readonly string[],
  run?: IngestHistoryRun,
  extraPaths: readonly string[] = [],
): Promise<string | null> {
  return serialized(projectPath, async () => {
    const open = liveRun(run)
    try {
      const paths = [...files, ...extraPaths, ...(open?.record.paths ?? [])]
      if (run) {
        const media = await existingMediaFolder(projectPath, run.sourcePath)
        if (media) paths.push(media)
        const source = projectRelative(projectPath, run.sourcePath)
        if (source) paths.push(source)
        const parsed = parsedMarkdownOutputPath(projectKey(projectPath), absoluteSource(projectPath, run.sourcePath))
        const parsedRelative = parsed ? projectRelative(projectPath, parsed) : null
        if (parsedRelative) paths.push(parsedRelative)
      }
      paths.push(".gitignore")
      return await gitCommitPaths(
        projectKey(projectPath),
        uniquePaths(paths),
        buildActionCommitMessage("ingest", title, files),
      )
    } catch (err) {
      console.warn("[git-history] ingest commit failed:", err)
      showWarning(run?.sourcePath, `Version history could not record this ingest: ${firstLine(err)}`)
      return null
    } finally {
      // The ingest succeeded: whatever git did, a later baseline must not undo it.
      await closeRun(projectPath, open)
    }
  })
}

/**
 * Commit the paths that a review action changed (for example "Use an existing domain"), with the message the action
 * built. Only these paths go into the commit, and nothing else is saved first. It runs after the git actions that are
 * queued for the project. Resolves the SHA, or `null` when there was nothing to commit or git failed (a warning in the
 * activity panel then says why). Never rejects.
 */
export function commitReviewAction(projectPath: string, paths: readonly string[], message: string): Promise<string | null> {
  return serialized(projectPath, async () => {
    const unique = uniquePaths(paths)
    if (unique.length === 0) return null
    try {
      return await gitCommitPaths(projectKey(projectPath), unique, message)
    } catch (err) {
      console.warn("[git-history] review action commit failed:", err)
      showWarning(undefined, `Version history could not record this change: ${firstLine(err)}`, unique)
      return null
    }
  })
}

/**
 * Undo a failed or cancelled ingest: put back only the paths it wrote (and its
 * media folder) as they are in HEAD. Paths outside `wiki/` are never touched.
 * Then forget the source's resume state, so a retry starts from the restored
 * pages. Never rejects.
 */
export function restoreFailedIngest(
  projectPath: string,
  paths: readonly string[],
  run?: IngestHistoryRun,
): Promise<void> {
  return serialized(projectPath, async () => {
    const open = liveRun(run)
    if (open?.superseded) {
      // A newer baseline or a recovery already put this run's files back;
      // a second restore could undo the newer run's work.
      console.warn("[git-history] skipped the restore of a run that was already put back")
      return
    }
    try {
      const restorable = uniquePaths([...paths, ...(open?.record.paths ?? [])]).filter(isRestorablePath)
      const media = run ? await existingMediaFolder(projectPath, run.sourcePath) : null
      await restorePaths(projectPath, media ? [...restorable, media] : restorable)
    } catch (err) {
      console.warn("[git-history] restore after failed ingest failed:", err)
      showWarning(run?.sourcePath, `Version history could not put back the files of this ingest: ${firstLine(err)}`)
    }
    if (run) await clearResumeState(projectPath, run.sourcePath)
    await closeRun(projectPath, open)
  }).catch((err: unknown) => {
    console.warn("[git-history] restore failed:", err)
  })
}
