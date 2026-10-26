/**
 * Where a file really is. A recut writes files of the project only. A folder or a file in the project can be a link to
 * somewhere else, and a write through it would change a file outside the project. `resolveInProject` checks the text of
 * the path; these functions follow the links.
 */
import { lstatSync, realpathSync } from "node:fs"
import { basename, dirname, join, resolve, sep } from "node:path"
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
 * Why a recut must not write or remove the project file `relativePath`, or null when it may. The text names the cause:
 * the file is outside the project once links are followed, its path cannot be resolved (a link loop, no permission), or
 * the file or a folder in its path is a link that stays inside the project. A write through such a link would replace
 * the link with a regular file, so a recut treats these paths as it treats a page (see `read-pages.ts`).
 */
export function insideProblem(project: string, relativePath: string): string | null {
  try {
    const real = realPathOrParent(resolveInProject(project, relativePath))
    if (!isInsideRoot(realProjectRoot(project), real)) return `the file is outside the project (it is ${real})`
  } catch (error) {
    return `the path cannot be resolved (${error instanceof Error ? error.message : String(error)})`
  }
  return linkProblem(project, relativePath)
}

/** A link in the path, from the project folder down: "the file is a link" or "a folder in its path is a link". */
function linkProblem(project: string, relativePath: string): string | null {
  const names = relativePath.replace(/\\/g, "/").split("/").filter((name) => name !== "" && name !== ".")
  let current = resolve(project)
  for (const [index, name] of names.entries()) {
    current = join(current, name)
    try {
      if (lstatSync(current).isSymbolicLink()) return index === names.length - 1 ? "the file is a link" : "a folder in its path is a link"
    } catch (error) {
      const code = error instanceof Error ? (error as NodeJS.ErrnoException).code : undefined
      // The rest of the path does not exist yet: there is no link to find.
      if (code === "ENOENT" || code === "ENOTDIR") return null
      return `the path cannot be resolved (${error instanceof Error ? error.message : String(error)})`
    }
  }
  return null
}

/** True when something is at `path`, also a link that leads nowhere or loops. `existsSync` follows the link and says false. */
export function lexists(path: string): boolean {
  try {
    lstatSync(path)
    return true
  } catch {
    return false
  }
}
