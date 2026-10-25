/**
 * `wiki-tool fuse commit` - commit hypothesis pages (and the pages that go with them) with a fuse commit message.
 *
 * `--project P --title T --file F [--file F...]`. Every file must be inside the project. Each listed file under
 * `wiki/hypotheses/` is checked first with `fuse check`; when any fails, nothing is committed and the command exits
 * with the problems, each with the path of its page. Then the files are committed, and only them, with
 * `fuse: <T> (N pages)` as the subject (N is the number of distinct files) and a body that lists the paths.
 *
 * The commit goes through `commitPathsLocked`, the one writer of the git history that takes the shared git lock, fills
 * the identity that git does not have, skips hooks and signing, never commits `.llm-wiki/`, and refuses during a merge
 * or a rebase. Output: `{ ok: true, sha }` (`sha` is null when the files had nothing to commit) or `{ ok: false,
 * problems }`.
 */
import { buildActionCommitMessage } from "@/lib/commit-message"
import { parseArgs } from "../args"
import { commitPathsLocked } from "../git"
import { GIT_LOCK_BUSY_MESSAGE } from "../git-lock"
import { type CommandResult, isDirectory, resolveInProject } from "../io"
import { checkHypothesisFile, isHypothesisPath, projectRelativePath } from "./check"

const OPTION_SPEC = { values: ["project", "title"], lists: ["file"] } as const

export async function fuseCommit(args: string[]): Promise<CommandResult> {
  const { parsed, problems } = parseArgs(args, OPTION_SPEC)
  const { project, title } = parsed.values
  const files = parsed.lists.file
  if (project === undefined) problems.push("missing option: --project")
  if (title === undefined) problems.push("missing option: --title")
  else if (title.trim() === "") problems.push("--title must not be empty")
  if (files.length === 0) problems.push("missing option: --file")
  if (problems.length > 0 || project === undefined || title === undefined) return { ok: false, problems }
  if (!isDirectory(project)) return { ok: false, problems: [`project folder not found: ${project}`] }

  const paths = listedPaths(project, files, problems)
  if (problems.length > 0) return { ok: false, problems }

  // The hypothesis pages first: one failing page stops the whole commit.
  for (const path of paths.filter(isHypothesisPath)) {
    for (const found of checkHypothesisFile(project, path)) problems.push(`${path}: ${found}`)
  }
  if (problems.length > 0) return { ok: false, problems }

  const message = buildActionCommitMessage("fuse", title, paths)
  try {
    const result = await commitPathsLocked(project, paths, message)
    return result.ok ? { ok: true, sha: result.sha } : { ok: false, problems: [result.problem] }
  } catch (error) {
    // The lock stayed with another tool for the whole wait: a known state, not a bug.
    if (error instanceof Error && error.message === GIT_LOCK_BUSY_MESSAGE) return { ok: false, problems: [error.message] }
    throw error
  }
}

/**
 * The listed files as paths from the project folder, once each. A file outside the project, and a folder, are
 * problems: a folder would take in pages that the check never saw.
 */
function listedPaths(project: string, files: readonly string[], problems: string[]): string[] {
  const paths: string[] = []
  for (const file of files) {
    let path: string
    try {
      path = projectRelativePath(project, file)
    } catch (error) {
      problems.push(error instanceof Error ? error.message : String(error))
      continue
    }
    if (isDirectory(resolveInProject(project, file))) {
      problems.push(`${file} is a folder: list the files to commit`)
      continue
    }
    if (!paths.includes(path)) paths.push(path)
  }
  return paths
}
