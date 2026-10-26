import { invoke } from "@tauri-apps/api/core"

export interface GitInfo {
  available: boolean
  isRepo: boolean
  /** The project folder is the top of its repository, not nested in a bigger one. */
  isRoot: boolean
  /** The top folder of the repository the project is in, as git prints it. `null` outside a repository. */
  topLevel: string | null
}

/** Whether git is runnable, whether `projectPath` is inside a work tree, and which folder is that work tree's top. */
export async function gitInfo(projectPath: string): Promise<GitInfo> {
  return invoke<GitInfo>("git_info", { projectPath })
}

/** `git init`, write the wiki `.gitignore`, and make the baseline commit. */
export async function gitInit(projectPath: string): Promise<void> {
  return invoke<void>("git_init", { projectPath })
}

/** Commit everything under the project folder. Resolves to the full SHA of the new HEAD, or null when nothing was committed. */
export async function gitCommitAll(
  projectPath: string,
  message: string,
): Promise<string | null> {
  return invoke<string | null>("git_commit_all", { projectPath, message })
}

/**
 * Commit only these project-relative paths (a path ending in `/` is a folder;
 * deleted paths are recorded). Staged changes to other paths stay staged.
 * Resolves to the full SHA of the new HEAD, or null when nothing was committed.
 */
export async function gitCommitPaths(
  projectPath: string,
  paths: readonly string[],
  message: string,
): Promise<string | null> {
  return invoke<string | null>("git_commit_paths", { projectPath, paths, message })
}

/**
 * Put these paths inside `wiki/` back as they are in HEAD and touch nothing
 * else: tracked files are restored, untracked files are deleted, and a path
 * ending in `/` is a folder whose untracked files are deleted.
 */
export async function gitRestorePaths(
  projectPath: string,
  paths: readonly string[],
): Promise<void> {
  return invoke<void>("git_restore_paths", { projectPath, paths })
}

/** The full SHA of HEAD, or null before the first commit. */
export async function gitHead(projectPath: string): Promise<string | null> {
  return invoke<string | null>("git_head", { projectPath })
}

/**
 * How many commits after `since` (every commit when it is null) touch the project folder and have a subject that starts with
 * `prefix`. `since` is a commit sha of 7 to 64 hex digits. One that is not in the history of HEAD counts every commit, like
 * `wiki-tool lint changed-domains`. A repository with no commit gives 0. Rejects when git fails or `since` is not a sha.
 */
export async function gitCountSubjects(
  projectPath: string,
  since: string | null,
  prefix: string,
): Promise<number> {
  return invoke<number>("git_count_subjects", { projectPath, since, prefix })
}
