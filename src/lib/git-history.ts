import { ask } from "@tauri-apps/plugin-dialog"
import { gitCommitAll, gitInfo, gitInit, gitRestoreDir } from "@/commands/git"
import { getStore } from "@/lib/project-store"
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

function modeKey(projectId: string): string {
  return `${MODE_KEY_PREFIX}${projectId}`
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

/** Forget the cached answer for one project, or for every project when no id is given. */
export function resetGitHistoryCache(projectId?: string): void {
  if (projectId === undefined) resolved.clear()
  else resolved.delete(projectId)
}

async function decide(
  projectId: string,
  projectPath: string,
  deps: GitHistoryDeps,
): Promise<boolean> {
  const info = await gitInfo(projectPath)
  if (!info.available) return false

  const mode = await deps.loadMode(projectId)
  if (mode === "off") return false
  if (mode === "on") {
    if (!info.isRepo) await gitInit(projectPath)
    return true
  }

  // mode === "ask"
  if (info.isRepo && info.isRoot) {
    await deps.saveMode(projectId, "on")
    return true
  }
  if (await deps.askUser(ASK_MESSAGE)) {
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

  const pending = decide(projectId, projectPath, deps).catch((err: unknown) => {
    console.warn("[git-history] could not resolve version history:", err)
    resolved.delete(projectId)
    return false
  })
  resolved.set(projectId, pending)
  return pending
}

/** Commit whatever is already uncommitted so the ingest commit holds only ingest changes. */
export async function prepareIngestBaseline(projectPath: string): Promise<void> {
  try {
    await gitCommitAll(projectPath, BASELINE_MESSAGE)
  } catch (err) {
    console.warn("[git-history] baseline commit failed:", err)
  }
}

/** Commit the files an ingest wrote. Resolves the SHA, or `null` when nothing changed or git failed. */
export async function commitIngest(
  projectPath: string,
  title: string,
  files: readonly string[],
): Promise<string | null> {
  try {
    return await gitCommitAll(
      projectPath,
      buildActionCommitMessage("ingest", title, files),
    )
  } catch (err) {
    console.warn("[git-history] ingest commit failed:", err)
    return null
  }
}

/** Undo a failed or cancelled ingest. Restores `wiki/` only; `raw/` and `.llm-wiki/` are never touched. */
export async function restoreFailedIngest(projectPath: string): Promise<void> {
  try {
    await gitRestoreDir(projectPath, "wiki")
  } catch (err) {
    console.warn("[git-history] restore after failed ingest failed:", err)
  }
}
