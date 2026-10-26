/**
 * The pages of a wiki as a recut reads them: the references of each page, and the text exactly as it is on disk.
 */
import { lstatSync, readFileSync, realpathSync } from "node:fs"
import { resolveInProject } from "../io"
import { readWikiPages } from "../mirror-pages"
import type { PageSource } from "./page-edits"
import { isInsideRoot, realProjectRoot } from "./inside"
import { recutPage } from "./page-refs"

export interface ReadPageSources {
  sources: PageSource[]
  /** Pages that a recut must not edit, with the reason: text or a rename would change more than the domain. */
  blocked: Map<string, string>
}

/** Every page under `wiki/` (a page that a link brings in from outside the project is read, but blocked), sorted by path. A folder or file that cannot be read throws (see `readWikiPages`). */
export function readPageSources(project: string): ReadPageSources {
  const sources: PageSource[] = []
  const blocked = new Map<string, string>()
  const root = realProjectRoot(project)
  for (const wikiPage of readWikiPages(project, { allowMissingWiki: true })) {
    const bytes = readFileSync(resolveInProject(project, wikiPage.path))
    const text = bytes.toString("utf8")
    if (!isInsideRoot(root, realpathSync(resolveInProject(project, wikiPage.path)))) blocked.set(wikiPage.path, "the file is outside the project")
    else if (!Buffer.from(text, "utf8").equals(bytes)) blocked.set(wikiPage.path, "the file is not valid UTF-8")
    else if (lstatSync(resolveInProject(project, wikiPage.path)).isSymbolicLink()) blocked.set(wikiPage.path, "the file is a link")
    sources.push({ page: recutPage(wikiPage.path, wikiPage.markdown), text })
  }
  return { sources, blocked }
}
