/**
 * How a recut reads a page: the references that the page makes to a domain.
 *
 * A page names a domain in four keys of its frontmatter. `domain` and every item of `also` are on any page. A
 * hypothesis page has no `domain` (it counts under its `to_domain`, ruling R19) and names its two domains in
 * `from_domain` and `to_domain` (ruling U3). The same rules as `indexedPageFromMarkdown` and
 * `structurePageFromMarkdown` apply: a value is a trimmed, non-empty string, and a page without readable frontmatter
 * makes no reference.
 */
import { parseFrontmatter } from "@/lib/frontmatter"
import { indexedPageFromMarkdown } from "@/lib/mechanism-wiki/domain-index-render"

export type RefKey = "domain" | "to_domain" | "from_domain" | "also"

export const HYPOTHESIS_TYPE = "hypothesis"

export interface PageRef {
  key: RefKey
  value: string
}

export interface RecutPage {
  /** Path from the project root, with `/`. */
  path: string
  slug: string
  title: string
  type: string
  /** Where the page counts: its `domain`, for a hypothesis its `to_domain`. Null when it has none. */
  domain: string | null
  /** In the order `domain`, `to_domain`, `from_domain`, then the items of `also`. */
  refs: PageRef[]
  /** The text of the page, without a byte order mark. */
  markdown: string
}

export function recutPage(path: string, markdown: string): RecutPage {
  const indexed = indexedPageFromMarkdown(path, markdown)
  const { frontmatter } = parseFrontmatter(markdown)
  const refs: PageRef[] = []
  const text = (key: "domain" | "to_domain" | "from_domain"): void => {
    const value = frontmatter?.[key]
    if (typeof value === "string" && value.trim() !== "") refs.push({ key, value: value.trim() })
  }
  text("domain")
  if (indexed.type === HYPOTHESIS_TYPE) {
    text("to_domain")
    text("from_domain")
  }
  const also = frontmatter?.also
  for (const item of Array.isArray(also) ? also : typeof also === "string" ? [also] : []) {
    if (item.trim() !== "") refs.push({ key: "also", value: item.trim() })
  }
  return { path: indexed.path, slug: indexed.slug, title: indexed.title, type: indexed.type, domain: indexed.domain, refs, markdown }
}
