/**
 * git-history-setting.ts - the "Version history (git)" switch of a project.
 *
 * The first ingest of a project asks once and stores the answer (`GitHistoryMode`). This module
 * lets the user change that answer later, in the settings. It adds no git logic: turning the
 * history on goes through `resolveGitHistory`, which starts the repository when the project has
 * none, exactly as the first ingest does.
 */
import {
  defaultGitHistoryDeps,
  resetGitHistoryCache,
  resolveGitHistory,
  type GitHistoryDeps,
} from "./git-history"

/** True when the stored choice of the project is "on". "ask" (never asked) and "off" are false. */
export async function loadGitHistoryEnabled(
  projectId: string,
  deps: GitHistoryDeps = defaultGitHistoryDeps,
): Promise<boolean> {
  return (await deps.loadMode(projectId)) === "on"
}

/**
 * Turn the version history of the project on or off. Resolves whether it is on now.
 *
 * Both ways store the choice and forget the answer that the session cached, so the next ingest reads
 * the new choice (a "No" given earlier no longer holds). Turning on then resolves the answer at once:
 * `resolveGitHistory` starts the repository when there is none. When git cannot be used, the earlier
 * choice is stored again and the result is `false`. Rejects when the choice cannot be stored.
 */
export async function setGitHistoryEnabled(
  projectId: string,
  projectPath: string,
  enabled: boolean,
  deps: GitHistoryDeps = defaultGitHistoryDeps,
): Promise<boolean> {
  const previous = await deps.loadMode(projectId)
  await deps.saveMode(projectId, enabled ? "on" : "off")
  resetGitHistoryCache(projectId)
  if (!enabled) return false

  if (await resolveGitHistory(projectId, projectPath, deps)) return true
  // Git is missing or the repository could not be started: do not leave a switch that does nothing.
  await deps.saveMode(projectId, previous)
  resetGitHistoryCache(projectId)
  return false
}
