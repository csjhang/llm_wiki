/**
 * `wiki-tool recut pages` - the pages that a recut of one domain concerns.
 *
 * `--project P --domain D` gives `{ ok: true, pages }`. Each entry is `{ path, title, type, key, excerpt }`: a page and the
 * key of its frontmatter that names D. `key` is `domain`, or for a hypothesis page `to_domain` or `from_domain` (ruling
 * U3), or `also` for a page that lists D as another domain. A page that names D in two keys has two entries. The
 * entries are in path order, and in the order `domain`, `to_domain`, `from_domain`, `also` for one page. `excerpt` is
 * the first 300 characters of the body after the frontmatter (not counting white space at its start), cut at a
 * character, never inside one. This is the input for the proposal of the new domain of each page in a split. D must be
 * a domain of `domains.yaml`. The command changes nothing.
 */
import { parseFrontmatter } from "@/lib/frontmatter"
import type { CommandResult } from "../io"
import { loadLintProject, notMechanismWiki, parseLintArgs } from "../lint/project"
import { readWikiPages } from "../mirror-pages"
import { type RefKey, recutPage } from "./page-refs"

const EXCERPT_LENGTH = 300

interface PageEntry {
  path: string
  title: string
  type: string
  key: RefKey
  excerpt: string
}

export function recutPages(args: string[]): CommandResult {
  const parsed = parseLintArgs(args, ["domain"], ["domain"])
  if (!parsed.ok) return parsed.result
  const { project, values } = parsed
  const domain = values.domain

  const config = loadLintProject(project)
  if (config === null) return notMechanismWiki(project)
  if (config.blockingProblems.length > 0) {
    return { ok: false, problems: config.blockingProblems.map((problem) => `${problem}. Run "lint structure" for the details`) }
  }
  if (!Object.prototype.hasOwnProperty.call(config.domains.domains, domain)) return { ok: false, problems: [`unknown domain: ${domain}`] }

  const pages: PageEntry[] = []
  for (const wikiPage of readWikiPages(project, { allowMissingWiki: true })) {
    const page = recutPage(wikiPage.path, wikiPage.markdown)
    const keys = [...new Set(page.refs.filter((ref) => ref.value === domain).map((ref) => ref.key))]
    if (keys.length === 0) continue
    const excerpt = Array.from(parseFrontmatter(wikiPage.markdown).body.replace(/^\s+/, "")).slice(0, EXCERPT_LENGTH).join("")
    for (const key of keys) pages.push({ path: page.path, title: page.title, type: page.type, key, excerpt })
  }
  return { ok: true, pages }
}
