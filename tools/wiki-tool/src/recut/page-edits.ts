/**
 * The edits that a recut makes to the pages: the text of every page that changes, before and after.
 *
 * Two kinds of text change. In the frontmatter of any page, the references to a domain (`domain`, the items of
 * `also`, and for a hypothesis `from_domain` and `to_domain`, ruling U3) get their new name. In a mechanism page, the
 * `(<domain>)` of the Known instances lines gets its new name (ruling U4). Nothing else changes, byte for byte.
 *
 * A split gives each reference the new domain of its page (`assignments`). An instance line names the page of the
 * instance by its slug, so it takes the assignment of that page; when no page, or two pages with different
 * assignments, match the slug, the line stays and a note says so.
 *
 * When a recut touches the `also` list of a page, an item that now repeats the domain of the page, or an item before it,
 * is removed if the form of the list allows that. A list that the recut does not touch stays as it is.
 *
 * Nothing is written here. A page whose frontmatter this module cannot edit safely is a problem with its path.
 */
import { MECHANISM_TYPE } from "@/lib/mechanism-wiki/domain-index-render"
import { editDomainKeys } from "./frontmatter-edit"
import { rewriteInstanceLines } from "./instances"
import { HYPOTHESIS_TYPE, type RecutPage } from "./page-refs"
import { createMapper, type RecutPlan } from "./plan"

export interface PageSource {
  page: RecutPage
  /** The text of the file as it is on disk (with a byte order mark, if it has one). */
  text: string
}

export interface PageEdit {
  path: string
  before: string
  after: string
}

export interface PageEdits {
  /** The pages that change, in the order of `sources`. */
  edits: PageEdit[]
  /** Pages that cannot be edited safely. Each starts with the path. */
  problems: string[]
  /** Things the user should know about. */
  notes: string[]
}

export function computePageEdits(plan: RecutPlan, sources: readonly PageSource[]): PageEdits {
  const mapper = createMapper(plan)
  const assigned = plan.op === "split" ? assignedDomainsBySlug(plan.assignments, sources) : null
  const result: PageEdits = { edits: [], problems: [], notes: [] }

  for (const { page, text: original } of sources) {
    let text = original
    const mapped = (domain: string): string => mapper.map(domain.trim(), page.path)

    // The references in the frontmatter.
    if (page.refs.some((ref) => mapped(ref.value) !== ref.value)) {
      const primary = page.domain === null ? null : mapped(page.domain)
      const primaryChanged = page.domain !== null && primary !== page.domain
      const edit = editDomainKeys(text, {
        singleKeys: page.type === HYPOTHESIS_TYPE ? ["domain", "to_domain", "from_domain"] : ["domain"],
        value: (_key, old) => {
          const next = mapped(old)
          return next === old.trim() ? old : next
        },
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
      if (edit.ok) text = edit.text
      else result.problems.push(`${page.path}: ${edit.reason}`)
    }

    // The Known instances lines of a mechanism page.
    if (page.type === MECHANISM_TYPE) {
      const rewritten = rewriteInstanceLines(text, (domain, slug) => {
        if (assigned === null || plan.op !== "split") return mapper.map(domain, page.path)
        if (domain !== plan.from) return domain
        const found = assigned.get(slug.toLowerCase())
        return found !== undefined && found.size === 1 ? [...found][0] : null
      })
      text = rewritten.text
      for (const line of rewritten.unresolved) {
        const count = assigned?.get(line.slug.toLowerCase())?.size ?? 0
        const reason = count === 0 ? "no page with this slug was assigned" : "pages with this slug were assigned to different domains"
        result.notes.push(`${page.path}: the instance line [[${line.slug}]] (${line.domain}) stays as it is, because ${reason}.`)
      }
    }

    if (text !== original) result.edits.push({ path: page.path, before: original, after: text })
  }
  return result
}

/** The new domains of the assigned pages, by the lower-case slug of the page. */
function assignedDomainsBySlug(assignments: Readonly<Record<string, string>>, sources: readonly PageSource[]): Map<string, Set<string>> {
  const bySlug = new Map<string, Set<string>>()
  for (const { page } of sources) {
    if (!Object.prototype.hasOwnProperty.call(assignments, page.path)) continue
    const key = page.slug.toLowerCase()
    bySlug.set(key, new Set([...(bySlug.get(key) ?? []), assignments[page.path]]))
  }
  return bySlug
}
