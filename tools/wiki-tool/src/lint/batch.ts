/**
 * `wiki-tool lint batch` - group the pages of one domain into batches for a semantic review.
 *
 * `--project P --domain D [--max-chars N]` gives `{ ok: true, batches, notes? }`; `batches` is a list of lists of
 * page paths. The pages of D are the pages whose `domain` is D, and the hypothesis pages whose `to_domain` is D
 * (ruling R19). A page that only lists D in `also` is not one, and a mechanism page is not one: the skill reads
 * the mechanism pages on their own. The pages are sorted by type, then by path, and filled into batches in that
 * order. A batch is closed when the next file would bring its total over `--max-chars` (default 60000), or when the
 * type changes. The size of a file is the number of characters in its text. A file larger than the limit is a batch
 * of its own, and `notes` names it. A domain that no domain list holds, in this wiki or (in a work wiki) in the
 * reading wiki, is a handled problem.
 */
import { MECHANISM_TYPE } from "@/lib/mechanism-wiki/domain-index-render"
import { structurePageFromMarkdown } from "@/lib/mechanism-wiki/lint-structure"
import type { CommandResult } from "../io"
import { compareText, readWikiPages } from "../mirror-pages"
import { libraryOnlyDomains, loadLintProject, notMechanismWiki, ownDomains, parseLintArgs } from "./project"

/** The size limit of a batch when `--max-chars` is not given. The skill `wiki-lint` names it. */
export const DEFAULT_MAX_CHARS = 60_000

export function lintBatch(args: string[]): CommandResult {
  const parsed = parseLintArgs(args, ["domain", "max-chars"], ["domain"])
  if (!parsed.ok) return parsed.result
  const { project, values } = parsed
  const domain = values.domain

  let maxChars = DEFAULT_MAX_CHARS
  if (values["max-chars"] !== undefined) {
    const text = values["max-chars"]
    maxChars = /^\d+$/.test(text) ? Number(text) : Number.NaN
    if (!Number.isSafeInteger(maxChars) || maxChars < 1) {
      return { ok: false, problems: [`--max-chars must be a positive integer: ${JSON.stringify(text)}`] }
    }
  }

  const config = loadLintProject(project)
  if (config === null) return notMechanismWiki(project)
  if (config.blockingProblems.length > 0) {
    return { ok: false, problems: config.blockingProblems.map((problem) => `${problem}. Run "lint structure" for the details`) }
  }
  if (![...ownDomains(config), ...libraryOnlyDomains(config)].includes(domain)) {
    return { ok: false, problems: [`unknown domain: ${domain}`] }
  }

  const pages = readWikiPages(project, { allowMissingWiki: true })
    .map((page) => ({ page: structurePageFromMarkdown(page.path, page.markdown), size: page.markdown.length }))
    .filter(({ page }) => page.domain === domain && page.type !== MECHANISM_TYPE)
    .sort((a, b) => compareText(a.page.type, b.page.type) || compareText(a.page.path, b.page.path))

  const batches: string[][] = []
  const notes: string[] = []
  let current: string[] = []
  let currentType = ""
  let total = 0
  for (const { page, size } of pages) {
    const full = current.length > 0 && (page.type !== currentType || total + size > maxChars)
    if (full) {
      batches.push(current)
      current = []
      total = 0
    }
    if (size > maxChars) {
      notes.push(`${page.path} has ${size} characters, more than the limit of ${maxChars}. It is a batch of its own.`)
    }
    current.push(page.path)
    currentType = page.type
    total += size
  }
  if (current.length > 0) batches.push(current)
  return { ok: true, batches, ...(notes.length > 0 ? { notes } : {}) }
}
