/**
 * Shared contract and file helpers of wiki-tool.
 *
 * Every command returns one CommandResult. The dispatcher in cli.ts prints it as
 * JSON and maps it to an exit code. File helpers in this module never reach
 * outside the folder a command is given: resolveInProject throws first.
 */
import { randomBytes } from "node:crypto"
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeSync } from "node:fs"
import { dirname, isAbsolute, relative, resolve, sep } from "node:path"

/** What a command returns. `ok: false` needs a `problems` list of messages. */
export interface CommandResult {
  ok: boolean
  [key: string]: unknown
}

/** A command gets the arguments after `<group> <command>`. */
export type CommandHandler = (args: string[]) => CommandResult | Promise<CommandResult>

/** A named set of commands. Each group lives in its own file and cli.ts lists it. */
export interface CommandGroup {
  name: string
  commands: Record<string, CommandHandler>
}

/** Read and parse a JSON file. A parse error names the file. */
export function readJsonFile<T>(path: string): T {
  const text = readFileSync(path, "utf8").replace(/^\uFEFF/, "")
  try {
    return JSON.parse(text) as T
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    throw new Error(`cannot parse JSON file ${path}: ${reason}`)
  }
}

/**
 * Write a file so a reader sees the old or the new content, never a part of it.
 * The content goes to a temporary file in the same folder, then a rename replaces
 * the target. A failed write removes the temporary file. Missing parent folders
 * are created.
 */
export function writeFileAtomic(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true })
  const tempPath = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`
  try {
    const fd = openSync(tempPath, "wx")
    try {
      writeSync(fd, content)
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    renameSync(tempPath, path)
  } catch (error) {
    try {
      unlinkSync(tempPath)
    } catch {
      // The temporary file was not created, or it is already gone.
    }
    throw error
  }
}

/**
 * Resolve `relativePath` against the project folder and return the absolute path.
 * Throws when the result is outside the project folder. The project folder itself
 * is allowed. The check is on the path text; it does not follow symbolic links.
 */
export function resolveInProject(projectPath: string, relativePath: string): string {
  const root = resolve(projectPath)
  const target = resolve(root, relativePath)
  const fromRoot = relative(root, target)
  const outside = fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)
  if (outside) {
    throw new Error(`path is outside the project: ${relativePath}`)
  }
  return target
}
