/**
 * Layer-1 lint of a mechanism wiki: structural checks that need no model.
 *
 * `checkStructure` takes the pages, the domain files, the identity, the card map, and today's
 * date. It returns a list of findings and changes nothing. It is pure: no file access, no Tauri,
 * no store. The `wiki-tool` CLI bundles this file, so it may import only pure modules.
 * The index module `domain-index.ts` reads files, so it is not imported here.
 *
 * Check ids: `domain-missing`, `domain-unknown`, `concept-cross-domain`, `mechanism-no-instance`,
 * `mirror-retired`, `map-missing-page`, `hypothesis-stale-draft`, `domain-too-large`,
 * `domain-too-small`. A hypothesis page counts under its `to_domain` for every check (ruling R19).
 */
import { parseFrontmatter } from "@/lib/frontmatter"
import type { DomainsConfig } from "@/lib/wiki-config/domains"
import type { WikiIdentity } from "@/lib/wiki-config/wiki-identity"
import { compareText, indexedPageFromMarkdown, isDomainIndexPath, MECHANISM_TYPE } from "./domain-index-render"
import type { IndexedPage } from "./domain-index-render"

/** A page with the frontmatter fields that the checks read. */
export interface StructurePage extends IndexedPage {
  /** Raw file names from the `sources` field. */
  sources: string[]
  /** Domain paths from the `also` field. */
  also: string[]
  status?: string
  /** The `updated` date, as written. */
  updated?: string
  /** Slugs from the `instances` field of a mechanism page. Absent when the field is absent. */
  instances?: string[]
  /** The `from_domain` of a hypothesis page. Null for any other page. */
  fromDomain?: string | null
}

export interface StructureInput {
  pages: StructurePage[]
  /** `domains.yaml` of this wiki. */
  domains: DomainsConfig
  identity: WikiIdentity
  /** The pages of `heptabase-map.json`. Null when the wiki has no card map. */
  cardMap: { pages: Record<string, { status: string; card_id: string }> } | null
  /** Today, as `YYYY-MM-DD`. */
  today: string
  /**
   * `domains.yaml` of the reading wiki (ruling U9). In a work wiki, a domain that this file lists
   * is known. Null or absent when there is none. A reading wiki ignores it.
   */
  libraryDomains?: DomainsConfig | null
}

export interface StructureFinding {
  check: string
  /** Path of the page, or null for a finding about a domain. */
  page: string | null
  message: string
  /** The domains that the finding names. */
  domains?: string[]
}

/** Files of `wiki/` that are not pages. The app keeps them. */
const NON_PAGE_PATHS: ReadonlySet<string> = new Set(["wiki/index.md", "wiki/log.md", "wiki/overview.md"])

/** Shown in the title of a retired mirror card. The tool puts the full prefix before the title. */
const RETIRED_TITLE_PREFIX = "🗄 已停用"

const RAW_SOURCES_DIR = "raw/sources/"
const HYPOTHESIS_TYPE = "hypothesis"
const SOURCE_TYPE = "source"
const CROSS_DOMAIN_TYPES: readonly string[] = ["concept", "entity"]
const MS_PER_DAY = 86_400_000

// --- reading a page ----------------------------------------------------

/** The page that `markdown` is, at `path`, with the fields that the checks read. */
export function structurePageFromMarkdown(path: string, markdown: string): StructurePage {
  const base = indexedPageFromMarkdown(path, markdown)
  const { frontmatter } = parseFrontmatter(markdown)
  const text = (key: string): string | undefined => {
    const value = frontmatter?.[key]
    if (typeof value !== "string") return undefined
    const trimmed = value.trim()
    return trimmed === "" ? undefined : trimmed
  }
  const list = (key: string): string[] => {
    const value = frontmatter?.[key]
    const items = Array.isArray(value) ? value : typeof value === "string" ? [value] : []
    return items.map((item) => item.trim()).filter((item) => item !== "")
  }

  const page: StructurePage = { ...base, sources: list("sources"), also: list("also") }
  const status = text("status")
  if (status !== undefined) page.status = status
  const updated = text("updated")
  if (updated !== undefined) page.updated = updated
  if (frontmatter !== null && frontmatter !== undefined && "instances" in frontmatter) page.instances = list("instances")
  page.fromDomain = base.type === HYPOTHESIS_TYPE ? (text("from_domain") ?? null) : null
  return page
}

// --- the checks --------------------------------------------------------

/** Run every check. The findings are sorted by check id, then by page path, so the output is stable. */
export function checkStructure(input: StructureInput): StructureFinding[] {
  // Pages the checks look at: real pages under `wiki/`. The index files are made by the app.
  const pages = input.pages.filter((page) => isWikiPage(page.path))
  const findings: StructureFinding[] = [
    ...checkDomainMissing(pages),
    ...checkDomainUnknown(pages, input),
    ...checkCrossDomain(pages),
    ...checkMechanismInstances(pages, input.identity),
    ...checkCardMap(input),
    ...checkStaleDrafts(pages, input),
    ...checkDomainSizes(pages, input),
  ]
  return findings.sort(compareFindings)
}

function isWikiPage(path: string): boolean {
  const key = path.replace(/\\/g, "/").toLowerCase()
  return key.startsWith("wiki/") && !isDomainIndexPath(key) && !NON_PAGE_PATHS.has(key)
}

/** A page without `domain`. Mechanism pages apply to many domains, and hypothesis pages use `to_domain`. */
function checkDomainMissing(pages: StructurePage[]): StructureFinding[] {
  return pages
    .filter((page) => page.type !== MECHANISM_TYPE && page.type !== HYPOTHESIS_TYPE && !hasDomain(page))
    .map((page) => ({
      check: "domain-missing",
      page: page.path,
      message: "This page has no domain. Set domain to a path from domains.yaml.",
    }))
}

/** A domain, an `also` entry, or a hypothesis `from_domain` or `to_domain` that no domains file lists. */
function checkDomainUnknown(pages: StructurePage[], input: StructureInput): StructureFinding[] {
  const known = new Set(Object.keys(input.domains.domains))
  const useLibrary = input.identity.role === "work" && Boolean(input.libraryDomains)
  if (useLibrary && input.libraryDomains) for (const name of Object.keys(input.libraryDomains.domains)) known.add(name)
  const where = useLibrary
    ? "It is in neither domains.yaml of this wiki nor domains.yaml of the reading wiki. Add it to domains.yaml, or fix the page."
    : "Add it to domains.yaml, or fix the page."

  const findings: StructureFinding[] = []
  for (const page of pages) {
    // The fields that hold a domain on this page, in reading order. A domain that two fields hold is reported once.
    const uses = new Map<string, string[]>()
    const note = (domain: string | null | undefined, field: string): void => {
      if (typeof domain !== "string" || domain === "") return
      const fields = uses.get(domain) ?? []
      if (!fields.includes(field)) fields.push(field)
      uses.set(domain, fields)
    }
    if (page.type === HYPOTHESIS_TYPE) {
      note(page.fromDomain, "from_domain")
      note(page.domain, "to_domain")
    } else {
      note(page.domain, "domain")
    }
    for (const domain of page.also) note(domain, "also")

    for (const [domain, fields] of uses) {
      if (known.has(domain)) continue
      findings.push({
        check: "domain-unknown",
        page: page.path,
        message: `Unknown domain "${domain}" in ${fields.length === 1 ? "field" : "fields"} ${fields.join(", ")}. ${where}`,
        domains: [domain],
      })
    }
  }
  return findings
}

/**
 * A concept or entity page whose sources are in two or more domains. A page lists the raw file names
 * in `sources`. A source page lists the raw file it summarizes in its own `sources`, so the raw
 * file name links the two. The domain of each source page is its `domain`.
 */
function checkCrossDomain(pages: StructurePage[]): StructureFinding[] {
  const domainsOfFile = new Map<string, Set<string>>()
  for (const page of pages) {
    if (page.type !== SOURCE_TYPE || !hasDomain(page)) continue
    for (const file of page.sources) {
      const key = sourceKey(file)
      const domains = domainsOfFile.get(key) ?? new Set<string>()
      domains.add(page.domain as string)
      domainsOfFile.set(key, domains)
    }
  }

  const findings: StructureFinding[] = []
  for (const page of pages) {
    if (!CROSS_DOMAIN_TYPES.includes(page.type)) continue
    const domains = new Set<string>()
    for (const file of page.sources) for (const domain of domainsOfFile.get(sourceKey(file)) ?? []) domains.add(domain)
    if (domains.size < 2) continue
    const names = [...domains].sort(compareText)
    findings.push({
      check: "concept-cross-domain",
      page: page.path,
      message: `This ${page.type} page cites sources from ${names.length} domains: ${names.join(", ")}. Split the page by domain, or move the shared structure to a mechanism page.`,
      domains: names,
    })
  }
  return findings
}

/** The raw file name of a source reference: no `raw/sources/` prefix, forward slashes, lower case. */
function sourceKey(reference: string): string {
  const key = reference.trim().replace(/\\/g, "/").replace(/^\.\//, "").toLowerCase()
  if (key.startsWith(RAW_SOURCES_DIR)) return key.slice(RAW_SOURCES_DIR.length)
  const at = key.indexOf(`/${RAW_SOURCES_DIR}`)
  return at === -1 ? key : key.slice(at + 1 + RAW_SOURCES_DIR.length)
}

/** A mechanism page without an instance. Only a reading wiki holds mechanism pages. */
function checkMechanismInstances(pages: StructurePage[], identity: WikiIdentity): StructureFinding[] {
  if (identity.role !== "reading") return []
  return pages
    .filter((page) => page.type === MECHANISM_TYPE && (page.instances ?? []).length === 0)
    .map((page) => ({
      check: "mechanism-no-instance",
      page: page.path,
      message: "This mechanism has no instance. Add an instance page under Known instances, or remove the mechanism.",
    }))
}

/** A retired card is left in Heptabase for the user to delete. An active entry needs its page. */
function checkCardMap(input: StructureInput): StructureFinding[] {
  if (input.cardMap === null) return []
  // Every page counts here, so a page that no check looks at still keeps its card.
  const titles = new Map(input.pages.map((page) => [normalizePath(page.path), page.title]))
  const findings: StructureFinding[] = []
  for (const [rawPath, entry] of Object.entries(input.cardMap.pages)) {
    const path = normalizePath(rawPath)
    if (entry.status === "retired") {
      const title = titles.get(path)
      findings.push({
        check: "mirror-retired",
        page: path,
        message:
          `The card of ${path}${title === undefined ? "" : ` ("${title}")`} is retired. Card id: ${entry.card_id}. ` +
          `Find the card in the mirror tag by this id or by the "${RETIRED_TITLE_PREFIX}" title prefix. Delete it by hand.`,
      })
    } else if (entry.status === "active" && !titles.has(path)) {
      findings.push({
        check: "map-missing-page",
        page: path,
        message: `The card map lists ${path} (card id: ${entry.card_id}) as active, but the page is not in the wiki. Restore the page, or let the next mirror sync retire the card.`,
      })
    }
  }
  return findings
}

/**
 * A hypothesis that has been a draft for more days than `draft_days`. Ruling R18: a draft
 * changes to `testing` when a row under "What to verify" links a page in `wiki/queries/`.
 */
function checkStaleDrafts(pages: StructurePage[], input: StructureInput): StructureFinding[] {
  const limit = input.identity.lint.draft_days
  const findings: StructureFinding[] = []
  for (const page of pages) {
    if (page.type !== HYPOTHESIS_TYPE || page.status !== "draft" || page.updated === undefined) continue
    const age = daysBetween(page.updated, input.today)
    if (age === null || age <= limit) continue
    findings.push({
      check: "hypothesis-stale-draft",
      page: page.path,
      message:
        `This hypothesis has been a draft for ${age} days (updated ${page.updated.slice(0, 10)}). ` +
        `To move it to testing, add a row under "What to verify" that links a page in wiki/queries/. ` +
        `If you cannot, update or remove the hypothesis.`,
    })
  }
  return findings
}

/** Whole days from `from` to `to`, both as `YYYY-MM-DD`. Null when either is not a real date. */
function daysBetween(from: string, to: string): number | null {
  const start = utcDay(from)
  const end = utcDay(to)
  return start === null || end === null ? null : Math.round((end - start) / MS_PER_DAY)
}

function utcDay(text: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(text.trim())
  if (!match) return null
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])]
  const time = Date.UTC(year, month - 1, day)
  const date = new Date(time)
  const real = date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
  return real ? time : null
}

/**
 * The page count of each domain of `domains.yaml`, with zero for a domain that has no page.
 * A page counts once, under its `domain` (a hypothesis: its `to_domain`), never under `also`.
 */
function checkDomainSizes(pages: StructurePage[], input: StructureInput): StructureFinding[] {
  const { max_domain_pages: max, min_domain_pages: min } = input.identity.lint
  const counts = new Map<string, number>(Object.keys(input.domains.domains).map((domain) => [domain, 0]))
  for (const page of pages) {
    if (page.domain !== null && counts.has(page.domain)) counts.set(page.domain, (counts.get(page.domain) ?? 0) + 1)
  }

  const findings: StructureFinding[] = []
  for (const [domain, count] of counts) {
    if (count > max) {
      findings.push({
        check: "domain-too-large",
        page: null,
        message: `Domain "${domain}" has ${plural(count)}. The limit is ${max}. Split it into sub-domains.`,
        domains: [domain],
      })
    } else if (count < min) {
      findings.push({
        check: "domain-too-small",
        page: null,
        message: `Domain "${domain}" has ${plural(count)}. The minimum is ${min}. Add pages, or merge it into a parent domain.`,
        domains: [domain],
      })
    }
  }
  return findings
}

// --- helpers -----------------------------------------------------------

function hasDomain(page: StructurePage): boolean {
  return page.domain !== null && page.domain.trim() !== ""
}

function plural(count: number): string {
  return `${count} ${count === 1 ? "page" : "pages"}`
}

function normalizePath(path: string): string {
  return path.replace(/\\/g, "/")
}

/** By check id, then page path (a finding without a page first), then the domains, then the message. */
function compareFindings(a: StructureFinding, b: StructureFinding): number {
  return (
    compareText(a.check, b.check) ||
    compareText(a.page ?? "", b.page ?? "") ||
    compareText((a.domains ?? []).join("\n"), (b.domains ?? []).join("\n")) ||
    compareText(a.message, b.message)
  )
}
