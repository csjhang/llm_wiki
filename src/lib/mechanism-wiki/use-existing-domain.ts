/**
 * The plan of "Use an existing domain" for a `new-domain` review item (spec 6.6).
 *
 * An ingest proposed a domain that `domains.yaml` does not list. The user chooses a domain that it lists. The plan
 * gives the pages of that ingest the chosen domain: the `domain` and the `also` items of the frontmatter, and the
 * `(<domain>)` of the Known instances lines of the mechanism pages that name an instance of the ingest. Nothing else
 * changes, byte for byte.
 *
 * The pages of the ingest are the pages whose `sources` name the raw source of the item. A raw name is compared the way
 * the structure lint compares it (`sourceKey`): without `raw/sources/`, with forward slashes, in lower case. A bare name
 * (`note.md`) also names a source in a folder (`web/note.md`) by its base name, unless the wiki names another source with
 * that base name in a folder: then it is not clear which source the page means, and the page is not touched.
 *
 * An instance line names the page of the instance by its slug, so a line changes only when its slug is the slug of a page
 * of the ingest that carried the proposed domain. A line of another ingest with the same proposed domain stays.
 *
 * This module is pure. A page that the line editor cannot change safely (flow or indented frontmatter, a value over
 * several lines) is a problem with its path, and the caller writes nothing.
 */
import { editDomainKeys } from "./frontmatter-edit"
import { MECHANISM_TYPE } from "./domain-index-render"
import { sourceKey, structurePageFromMarkdown } from "./lint-structure"
import type { StructurePage } from "./lint-structure"
import { rewriteInstanceLines } from "./recut-instance-lines"

const HYPOTHESIS_TYPE = "hypothesis"

/** A page as the plan reads it: the fields of the structure lint, and the text. */
export interface DomainPage extends StructurePage {
  /** The text of the file, as it is on disk (with a byte order mark, if it has one). */
  markdown: string
}

/** The page of the file `path` with this `markdown`. */
export function pageOfMarkdown(path: string, markdown: string): DomainPage {
  return { ...structurePageFromMarkdown(path, markdown), markdown }
}

export interface UseDomainInput {
  /** The raw source of the item, as the ingest gave it: project-relative or absolute. */
  source: string
  /** The domain that the ingest proposed. */
  proposed: string
  /** The domain of `domains.yaml` that the user chose. */
  chosen: string
}

export interface UseDomainEdit {
  path: string
  before: string
  after: string
}

export interface UseDomainPlan {
  /** The pages that change, in the order of the input. */
  edits: UseDomainEdit[]
  /** Pages that cannot be edited safely. Each starts with the path. */
  problems: string[]
}

export function planUseExistingDomain(pages: readonly DomainPage[], input: UseDomainInput): UseDomainPlan {
  const { proposed, chosen } = input
  const sourcePages = pagesOfSource(pages, input.source)
  const carriers = sourcePages.filter((page) => page.type !== HYPOTHESIS_TYPE && namesDomain(page, proposed))
  const carrierPaths = new Set(carriers.map((page) => page.path))
  const slugs = new Set(carriers.map((page) => page.slug.toLowerCase()))
  const result: UseDomainPlan = { edits: [], problems: [] }

  for (const page of pages) {
    let text = page.markdown

    if (carrierPaths.has(page.path)) {
      const edit = editFrontmatter(page, proposed, chosen)
      if (edit.ok) {
        text = edit.text
        const left = leftover(page.path, text, proposed)
        if (left !== null) result.problems.push(left)
      } else {
        result.problems.push(`${page.path}: ${edit.reason}`)
      }
    }

    if (page.type === MECHANISM_TYPE && slugs.size > 0) {
      text = rewriteInstanceLines(text, (domain, slug) => (domain === proposed && slugs.has(slug.toLowerCase()) ? chosen : domain)).text
    }

    if (text !== page.markdown) result.edits.push({ path: page.path, before: page.markdown, after: text })
  }
  return result
}

/** The pages whose `sources` name `source`. */
export function pagesOfSource<T extends StructurePage>(pages: readonly T[], source: string): T[] {
  const wanted = sourceKey(source)
  if (wanted === "") return []
  const base = wanted.slice(wanted.lastIndexOf("/") + 1)

  // A bare name is ambiguous when the wiki names another source with the same base name in a folder.
  let rival = false
  for (const page of pages) {
    for (const reference of page.sources) {
      const key = sourceKey(reference)
      if (key !== wanted && key.includes("/") && key.slice(key.lastIndexOf("/") + 1) === base) rival = true
    }
  }

  const names = (reference: string): boolean => {
    const key = sourceKey(reference)
    if (key === wanted) return true
    return !rival && !key.includes("/") && wanted.includes("/") && key === base
  }
  return pages.filter((page) => page.sources.some(names))
}

function namesDomain(page: StructurePage, domain: string): boolean {
  return page.domain === domain || page.also.includes(domain)
}

function editFrontmatter(page: DomainPage, proposed: string, chosen: string): ReturnType<typeof editDomainKeys> {
  const mapped = (value: string): string => (value.trim() === proposed ? chosen : value.trim())
  const primary = page.domain === null ? null : mapped(page.domain)
  const primaryChanged = page.domain !== null && primary !== page.domain
  return editDomainKeys(page.markdown, {
    singleKeys: ["domain"],
    value: (_key, old) => (old.trim() === proposed ? chosen : old),
    also: (old) => {
      const items = old.map(mapped)
      const touched = primaryChanged || items.some((item, index) => item !== old[index].trim())
      const seen = new Set<string>(primary === null ? [] : [primary])
      return items.map((item, index) => {
        const repeated = touched && item !== "" && seen.has(item)
        seen.add(item)
        return { value: item === old[index].trim() ? old[index] : item, redundant: repeated }
      })
    },
  })
}

/**
 * A problem when the page still names the proposed domain after the edit. This is the check that no page is skipped
 * without a word: an edit that finds no key to change, for a form of frontmatter that it does not read, leaves the old
 * name in place.
 */
function leftover(path: string, text: string, proposed: string): string | null {
  const after = structurePageFromMarkdown(path, text)
  if (!namesDomain(after, proposed)) return null
  return `${path}: it still names ${proposed}, and this app cannot rewrite it in this page. Write the frontmatter with its keys in the first column, then try again.`
}
