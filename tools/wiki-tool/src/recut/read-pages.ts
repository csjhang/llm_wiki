/**
 * The pages of a wiki as a recut reads them: the references of each page, and the text exactly as it is on disk.
 */
import { lstatSync, readFileSync, realpathSync } from "node:fs"
import { join } from "node:path"
import { resolveInProject } from "../io"
import { readWikiPages } from "../mirror-pages"
import { isInsideRoot, realProjectRoot } from "./inside"
import type { PageSource } from "./page-edits"
import { recutPage } from "./page-refs"

export interface ReadPageSources {
  sources: PageSource[]
  /** Pages that a recut must not edit, with the reason: text or a rename would change more than the domain. */
  blocked: Map<string, string>
}

/**
 * Every page under `wiki/`, sorted by path. A folder or file that cannot be read throws (see `readWikiPages`). A page
 * that a recut must not edit is read but blocked, with the reason: it is outside the project once links are followed, a
 * folder in its path or the file itself is a link (the real file is not at the path of the page, so a commit that names
 * the page would miss it), or its bytes are not valid UTF-8 (text would change them).
 */
export function readPageSources(project: string): ReadPageSources {
  const sources: PageSource[] = []
  const blocked = new Map<string, string>()
  const root = realProjectRoot(project)
  for (const wikiPage of readWikiPages(project, { allowMissingWiki: true })) {
    const full = resolveInProject(project, wikiPage.path)
    const bytes = readFileSync(full)
    const text = bytes.toString("utf8")
    const reason = blockReason(root, wikiPage.path, full, bytes, text)
    if (reason !== null) blocked.set(wikiPage.path, reason)
    sources.push({ page: recutPage(wikiPage.path, wikiPage.markdown), text })
  }
  return { sources, blocked }
}

function blockReason(root: string, path: string, full: string, bytes: Buffer, text: string): string | null {
  let real: string
  try {
    real = realpathSync(full)
  } catch (error) {
    return `the path cannot be resolved (${error instanceof Error ? error.message : String(error)})`
  }
  if (!isInsideRoot(root, real)) return "the file is outside the project"
  if (lstatSync(full).isSymbolicLink()) return "the file is a link"
  if (real !== join(root, ...path.split("/"))) return "a folder in its path is a link"
  if (!Buffer.from(text, "utf8").equals(bytes)) return "the file is not valid UTF-8"
  return null
}
