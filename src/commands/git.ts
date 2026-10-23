import { invoke } from "@tauri-apps/api/core"

export interface GitInfo {
  available: boolean
  isRepo: boolean
  /** The project folder is the top of its repository, not nested in a bigger one. */
  isRoot: boolean
}

/** Whether git is runnable, whether `projectPath` is inside a work tree, and whether it is that work tree's root. */
export async function gitInfo(projectPath: string): Promise<GitInfo> {
  return invoke<GitInfo>("git_info", { projectPath })
}

/** `git init`, write the wiki `.gitignore`, and make the baseline commit. */
export async function gitInit(projectPath: string): Promise<void> {
  return invoke<void>("git_init", { projectPath })
}

/** Commit everything under the project folder. Resolves to the full SHA, or null when nothing changed. */
export async function gitCommitAll(
  projectPath: string,
  message: string,
): Promise<string | null> {
  return invoke<string | null>("git_commit_all", { projectPath, message })
}

/** Restore a project-relative folder to HEAD and delete its untracked files. */
export async function gitRestoreDir(
  projectPath: string,
  relativeDir: string,
): Promise<void> {
  return invoke<void>("git_restore_dir", { projectPath, relativeDir })
}
