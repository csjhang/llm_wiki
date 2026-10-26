/**
 * Where a file really is. A recut writes files of the project only. A folder or a file in the project can be a link to
 * somewhere else, and a write through it would change a file outside the project. `resolveInProject` checks the text of
 * the path; these functions follow the links.
 */
import { realpathSync } from "node:fs"
import { basename, dirname, join, sep } from "node:path"
import { resolveInProject } from "../io"

/** The real path of the project folder. */
export function realProjectRoot(project: string): string {
  return realpathSync(project)
}

/** True when `real` is the real project folder or a path below it. */
export function isInsideRoot(realRoot: string, real: string): boolean {
  return real === realRoot || real.startsWith(realRoot.endsWith(sep) ? realRoot : realRoot + sep)
}

/**
 * The real path of `path`, with every link followed. A path that does not exist yet is resolved from its nearest
 * folder that exists, so a new file in a linked folder is found where it would land.
 */
export function realPathOrParent(path: string): string {
  // The names that do not exist, from the deepest one up.
  const missing: string[] = []
  let current = path
  for (;;) {
    try {
      return join(realpathSync(current), ...[...missing].reverse())
    } catch (error) {
      const code = error instanceof Error ? (error as NodeJS.ErrnoException).code : undefined
      const parent = dirname(current)
      if ((code !== "ENOENT" && code !== "ENOTDIR") || parent === current) throw error
      missing.push(basename(current))
      current = parent
    }
  }
}

/**
 * Why a recut must not write the project file `relativePath`, or null when it may. The file is outside the project once
 * links are followed, or its path cannot be resolved (a link loop, no permission): the text names the cause and the path.
 */
export function insideProblem(project: string, relativePath: string): string | null {
  try {
    const real = realPathOrParent(resolveInProject(project, relativePath))
    return isInsideRoot(realProjectRoot(project), real) ? null : `the file is outside the project (it is ${real})`
  } catch (error) {
    return `the path cannot be resolved (${error instanceof Error ? error.message : String(error)})`
  }
}
