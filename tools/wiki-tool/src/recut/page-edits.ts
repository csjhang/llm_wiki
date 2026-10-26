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
import { editDomainKeys } from "@/lib/mechanism-wiki/frontmatter-edit"
import { rewriteInstanceLines } from "@/lib/mechanism-wiki/recut-instance-lines"
import { HYPOTHESIS_TYPE, type RecutPage, recutPage } from "./page-refs"
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

/** An instance line that a split could not give a new domain. It stays as it is. */
export interface UnresolvedInstance {
  path: string
  slug: string
  domain: string
}

export interface PageEdits {
  /** The pages that change, in the order of `sources`. */
  edits: PageEdit[]
  /** Pages that cannot be edited safely. Each starts with the path. */
  problems: string[]
  /** Things the user should know about. */
  notes: string[]
  /** The instance lines behind the notes about lines that stay. */
  unresolved: UnresolvedInstance[]
}

export function computePageEdits(plan: RecutPlan, sources: readonly PageSource[]): PageEdits {
  const mapper = createMapper(plan)
  const assigned = plan.op === "split" ? assignedDomainsBySlug(plan.assignments, sources) : null
  const result: PageEdits = { edits: [], problems: [], notes: [], unresolved: [] }

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

    checkHypothesisDomains(page, mapped, result)

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
        result.unresolved.push({ path: page.path, slug: line.slug, domain: line.domain })
        const count = assigned?.get(line.slug.toLowerCase())?.size ?? 0
        const reason = count === 0 ? "no page with this slug was assigned" : "pages with this slug were assigned to different domains"
        result.notes.push(`${page.path}: the instance line [[${line.slug}]] (${line.domain}) stays as it is, because ${reason}.`)
      }
    }

    if (text !== original) result.edits.push({ path: page.path, before: original, after: text })
  }
  return result
}

/**
 * A merge can give `from_domain` and `to_domain` of a hypothesis the same name. A stack needs two domains (`fuse check`
 * refuses the page), so the recut stops there. An analogy that borrows inside one domain is odd but valid, so it gets a
 * note. A hypothesis that had one domain before the recut is not the business of the recut.
 */
function checkHypothesisDomains(page: RecutPage, mapped: (domain: string) => string, result: PageEdits): void {
  if (page.type !== HYPOTHESIS_TYPE) return
  const from = page.refs.find((ref) => ref.key === "from_domain")?.value
  const to = page.refs.find((ref) => ref.key === "to_domain")?.value
  if (from === undefined || to === undefined || from === to || mapped(from) !== mapped(to)) return
  const domain = mapped(from)
  if (page.relation === "stack") {
    result.problems.push(
      `${page.path}: relation stack needs two domains, but this recut gives from_domain and to_domain the same domain ${domain}. Change the plan so that the two domains of this page stay two domains.`,
    )
  } else {
    const kind = page.relation === "analogy" ? "analogy" : "hypothesis"
    result.notes.push(`${page.path}: this ${kind} now has the same domain ${domain} in from_domain and to_domain. Check if it still makes sense.`)
  }
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

/**
 * The references that are still wrong after the edits: a reference in the final text of a page (the text after its edit, or
 * the text as it is when the page has no edit) that names a domain which the recut removes. This is the check that no page is
 * skipped without a word: an edit that finds nothing to change, for a form of frontmatter that it does not read, leaves the
 * old name in place, and the recut must stop there. The Known instances lines of a mechanism page count too, except the
 * lines that a split reported in `unresolved` (a note names them). Each problem starts with the path of the page.
 */
export function findLeftoverRefs(sources: readonly PageSource[], result: PageEdits, removed: readonly string[]): string[] {
  const gone = new Set(removed)
  const after = new Map(result.edits.map((edit) => [edit.path, edit.after]))
  const reported = new Set(result.unresolved.map((line) => `${line.path}\0${line.slug}\0${line.domain}`))
  const problems = new Set<string>()
  for (const { page, text } of sources) {
    const final = after.get(page.path) ?? text
    const markdown = final.replace(/^\uFEFF/, "")
    const read = recutPage(page.path, markdown)
    for (const ref of read.refs) {
      if (gone.has(ref.value)) {
        problems.add(
          `${page.path}: ${ref.key} still names ${ref.value}, which the recut removes, and this tool cannot rewrite it in this page. Write the frontmatter with its keys in the first column, then run the recut again.`,
        )
      }
    }
    if (read.type === MECHANISM_TYPE) {
      rewriteInstanceLines(markdown, (domain, slug) => {
        if (gone.has(domain) && !reported.has(`${page.path}\0${slug}\0${domain}`)) {
          problems.add(`${page.path}: the Known instances line [[${slug}]] still names ${domain}, which the recut removes.`)
        }
        return domain
      })
    }
  }
  return [...problems]
}
