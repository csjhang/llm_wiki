/**
 * Domain-first index of a mechanism wiki: reading the pages and writing the index files.
 *
 * The text of each file comes from `domain-index-render.ts`. This file scans
 * `wiki/`, writes the files that changed, and builds the index text that the
 * ingest prompts carry: the root index, the mechanism index, and the index of
 * the domain that the source belongs to.
 */
import { listDirectory, readFile, writeFile } from "@/commands/fs"
import { normalizePath } from "@/lib/path-utils"
import type { FileNode } from "@/types/wiki"
import { listMarkdownFiles } from "./context"
import type { MechanismContext } from "./context"
import {
  compareText,
  domainIndexPath,
  indexedPageFromMarkdown,
  isDomainIndexPath,
  MECHANISM_INDEX_PATH,
  MECHANISM_TYPE,
  renderDomainIndex,
  renderMechanismIndex,
  renderRootIndex,
  ROOT_INDEX_PATH,
} from "./domain-index-render"
import type { IndexedPage } from "./domain-index-render"

export type { IndexedPage } from "./domain-index-render"

/** Files of `wiki/` that are not pages: the app keeps them (`wiki/indexes/` is skipped as a folder). */
const NON_PAGE_FILES: ReadonlySet<string> = new Set([ROOT_INDEX_PATH, "wiki/log.md", "wiki/overview.md"])

/**
 * The prompt text lists at most this many unassigned pages, because the root index goes into
 * every prompt. The index file that is written lists all of them.
 */
const MAX_UNASSIGNED_IN_PROMPT = 200

/** How many pages are read at once. */
const READ_BATCH_SIZE = 32

/**
 * Every page under `wiki/`, sorted by path. Left out: `wiki/index.md`, `wiki/log.md`,
 * `wiki/overview.md`, and everything in `wiki/indexes/`. A page that cannot be read is
 * left out too. A project without a `wiki/` folder has no pages.
 */
export async function scanWikiPages(projectPath: string): Promise<IndexedPage[]> {
  return scanWikiPagesWith(projectPath, indexedPageFromMarkdown)
}

/**
 * The same scan as `scanWikiPages`, with the page built by `build` from the project path of the file
 * and its text. The structural lint uses it to read more fields of each page.
 */
export async function scanWikiPagesWith<T extends IndexedPage>(
  projectPath: string,
  build: (path: string, markdown: string) => T,
): Promise<T[]> {
  const base = trimTrailingSlashes(projectPath)
  let tree: FileNode[]
  try {
    tree = await listDirectory(`${base}/wiki`)
  } catch {
    return []
  }

  const paths = collectPagePaths(tree, "wiki").sort(compareText)
  const pages: T[] = []
  for (let start = 0; start < paths.length; start += READ_BATCH_SIZE) {
    const batch = paths.slice(start, start + READ_BATCH_SIZE)
    const read = await Promise.all(
      batch.map(async (path) => {
        try {
          return build(path, await readFile(`${base}/${path}`))
        } catch {
          return null
        }
      }),
    )
    for (const page of read) if (page !== null) pages.push(page)
  }
  return pages
}

/** Paths of the `.md` files in `nodes`, from the project root. `folder` is the path of `nodes`. */
function collectPagePaths(nodes: FileNode[], folder: string): string[] {
  const paths: string[] = []
  for (const node of nodes) {
    const path = `${folder}/${node.name}`
    if (node.is_dir) {
      if (!isDomainIndexPath(`${path}/`)) paths.push(...collectPagePaths(node.children ?? [], path))
    } else if (node.name.endsWith(".md") && node.name.length > ".md".length && !NON_PAGE_FILES.has(path)) {
      paths.push(path)
    }
  }
  return paths
}

/**
 * Write `wiki/index.md`, `wiki/indexes/_mechanisms.md`, and `wiki/indexes/<domain>.md`
 * for every domain of `domains.yaml`. A file whose content did not change is not
 * written. The result lists the paths that were written, from the project root, in
 * the order root, mechanisms, domains by path.
 *
 * `onFileWritten` is called with the path of each file right after it is written. The
 * ingest passes its written-file tracking, so version history commits and restores the
 * index files with the rest of the ingest, also when a later write fails.
 *
 * The index of a domain that has no pages any more, or that `domains.yaml` no longer lists,
 * stays as it is.
 */
export async function rebuildDomainIndex(
  projectPath: string,
  ctx: MechanismContext,
  onFileWritten?: (relativePath: string) => void,
): Promise<string[]> {
  const base = trimTrailingSlashes(projectPath)
  const pages = await scanWikiPages(projectPath)
  const files: Array<{ path: string; content: string }> = [
    { path: ROOT_INDEX_PATH, content: renderRootIndex(pages, ctx.domains) },
    { path: MECHANISM_INDEX_PATH, content: renderMechanismIndex(pages) },
    ...Object.keys(ctx.domains.domains)
      .sort(compareText)
      .map((domain) => ({ path: domainIndexPath(domain), content: renderDomainIndex(domain, pages) })),
  ]

  const written: string[] = []
  for (const file of files) {
    const current = await readFile(`${base}/${file.path}`).catch(() => null)
    if (current === file.content) continue
    await writeFile(`${base}/${file.path}`, file.content)
    written.push(file.path)
    onFileWritten?.(file.path)
  }
  return written
}

/**
 * The index text that the ingest prompts carry in a mechanism wiki: the root index, the
 * mechanism index of the mechanism library, and, when `domain` is given, the index of that
 * domain. It is built from the pages as they are now, not from the files in `wiki/indexes/`.
 * In a reading wiki the library is the wiki itself. In a work wiki it is the reading wiki,
 * and the root index counts its mechanisms instead of the (missing) ones of the work wiki.
 * The root index lists at most `MAX_UNASSIGNED_IN_PROMPT` unassigned pages here; the written
 * `wiki/index.md` lists all of them.
 */
export async function buildScopedIndexText(
  projectPath: string,
  ctx: MechanismContext,
  domain: string | null,
): Promise<string> {
  const pages = await scanWikiPages(projectPath)
  const mechanisms = await libraryMechanismPages(projectPath, ctx.mechanismLibraryPath, pages)
  const root = renderRootIndex(
    [...pages.filter((page) => page.type !== MECHANISM_TYPE), ...mechanisms],
    ctx.domains,
    { maxUnassigned: MAX_UNASSIGNED_IN_PROMPT },
  )
  const parts = [root, renderMechanismIndex(mechanisms)]
  if (domain !== null) parts.push(renderDomainIndex(domain, pages))
  return parts.join("\n")
}

/** The mechanism pages of the library. `pages` are the already scanned pages of the project. */
async function libraryMechanismPages(
  projectPath: string,
  libraryPath: string | null,
  pages: IndexedPage[],
): Promise<IndexedPage[]> {
  if (libraryPath === null) return []
  const libraryPages =
    trimTrailingSlashes(libraryPath) === trimTrailingSlashes(projectPath) ? pages : await scanWikiPages(libraryPath)
  return libraryPages.filter((page) => page.type === MECHANISM_TYPE)
}

/**
 * The slugs of the mechanism pages in the library: the stems of the `*.md` files in
 * `<libraryPath>/wiki/mechanisms/`. Empty when the library path is null or the folder
 * cannot be listed.
 */
export async function listMechanismSlugs(libraryPath: string | null): Promise<Set<string>> {
  if (libraryPath === null) return new Set()
  const files = await listMarkdownFiles(`${trimTrailingSlashes(libraryPath)}/wiki/mechanisms`)
  return new Set(files.map((file) => file.stem))
}

function trimTrailingSlashes(path: string): string {
  return normalizePath(path).replace(/\/+$/, "")
}
