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
 * `domain-too-small`, and `config-invalid` (ruling U14). A hypothesis page counts under its `to_domain`
 * for every check (ruling R19).
 * A hypothesis page that lacks `from_domain` or `to_domain` gets `domain-missing` (ruling U10).
 */
import { parseFrontmatter } from "@/lib/frontmatter"
import type { DomainsConfig } from "@/lib/wiki-config/domains"
import type { ConfigIssue } from "@/lib/wiki-config/types"
import type { WikiIdentity } from "@/lib/wiki-config/wiki-identity"
import { isRecord } from "@/lib/wiki-config/yaml-util"
import { compareText, indexedPageFromMarkdown, isAppOwnPath, MECHANISM_TYPE, withoutBom } from "./domain-index-render"
import type { IndexedPage } from "./domain-index-render"
import { isSyncable, RETIRED_TITLE_PREFIX } from "./mirror-rules"

/** A page with the frontmatter fields that the checks read. */
export interface StructurePage extends IndexedPage {
  /** Raw file names from the `sources` field. */
  sources: string[]
  /** Domain paths from the `also` field. */
  also: string[]
  status?: string
  /** The `updated` date, as written. */
  updated?: string
  /** The `created` date, as written. A draft hypothesis without a readable `updated` date uses it. */
  created?: string
  /** Slugs from the `instances` field of a mechanism page. Absent when the field is absent. */
  instances?: string[]
  /**
   * The `from_domain` of a hypothesis page. Null for any other page, and for a hypothesis page without
   * one. A hypothesis page where it is null or absent gets `domain-missing`.
   */
  fromDomain?: string | null
  /**
   * True when the Heptabase sync mirrors this page (`isSyncable`, judged by the `type` in the frontmatter, as the
   * sync does). Absent counts as false. `mirror-retired` uses it: the card of a mirrored page comes back at the next sync.
   */
  mirrored?: boolean
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
   * `domains.yaml` of the reading wiki (ruling U9, refined). In a work wiki, a domain that this file lists
   * is known as the `from_domain` or `to_domain` of a hypothesis page. The `domain` and the `also` list of
   * every page must be in `domains`. Null or absent when there is none. A reading wiki ignores it.
   */
  libraryDomains?: DomainsConfig | null
  /**
   * Problems found while the config files were read (ruling U14). Build each one with `configProblemText`.
   * Each problem gives one `config-invalid` finding. A problem in `domains.yaml` of this wiki turns off
   * `domain-unknown` and the domain size checks, because the list of domains is not known. A problem in
   * `domains.yaml` of the reading wiki turns off only the library part of `domain-unknown`.
   */
  configProblems?: string[]
}

export interface StructureFinding {
  check: string
  /** Path of the page, or null for a finding about a domain. */
  page: string | null
  message: string
  /** The domains that the finding names. */
  domains?: string[]
}

/** Where a config problem was found: in a file of this wiki, or in a file of the reading wiki. */
export type ConfigProblemSource = "this" | "library"

/** Starts the text of a problem in a file of the reading wiki. */
const LIBRARY_PROBLEM_PREFIX = "reading wiki "

/**
 * The text of one config problem for `StructureInput.configProblems`. `issue.path` starts with the
 * name of the file, as `ConfigIssue` paths do. A problem in a file of the reading wiki gets the
 * prefix "reading wiki ".
 */
export function configProblemText(issue: ConfigIssue, source: ConfigProblemSource): string {
  const text = issue.path === "" ? issue.message : `${issue.path}: ${issue.message}`
  return source === "library" ? `${LIBRARY_PROBLEM_PREFIX}${text}` : text
}

type ConfigProblemKind = "domains" | "library-domains" | "threshold" | "other"

function classifyProblem(problem: string): ConfigProblemKind {
  const library = problem.startsWith(LIBRARY_PROBLEM_PREFIX)
  const names = /^domains\.yaml(?:$|[:\s])/.test(library ? problem.slice(LIBRARY_PROBLEM_PREFIX.length) : problem)
  if (names) return library ? "library-domains" : "domains"
  // A bad value under `lint:` in wiki.yaml (final review, M2). The threshold takes its default.
  return !library && /^wiki\.yaml:lint(?:$|[.:\s])/.test(problem) ? "threshold" : "other"
}

const RAW_SOURCES_DIR = "raw/sources/"
const HYPOTHESIS_TYPE = "hypothesis"
/** The fields of a hypothesis page that may name a domain of the reading wiki. */
const HYPOTHESIS_DOMAIN_FIELDS: readonly string[] = ["from_domain", "to_domain"]
const SOURCE_TYPE = "source"
const CROSS_DOMAIN_TYPES: readonly string[] = ["concept", "entity"]
const MS_PER_DAY = 86_400_000

// --- reading a page ----------------------------------------------------

/** The page that `markdown` is, at `path`, with the fields that the checks read. A byte order mark before the frontmatter is ignored. */
export function structurePageFromMarkdown(path: string, rawMarkdown: string): StructurePage {
  const markdown = withoutBom(rawMarkdown)
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
  const created = text("created")
  if (created !== undefined) page.created = created
  if (frontmatter !== null && frontmatter !== undefined && "instances" in frontmatter) page.instances = list("instances")
  page.fromDomain = base.type === HYPOTHESIS_TYPE ? (text("from_domain") ?? null) : null
  page.mirrored = isSyncable({ type: text("type") ?? "", sources: page.sources })
  return page
}

// --- the card map and the date -----------------------------------------

/**
 * The pages of `heptabase-map.json` with the two fields the checks read, from the text of the file. Null when
 * the text is not JSON or not a card map of version 1 with a `pages` mapping: the lint then leaves the card map
 * out of its checks. An entry without a text `status` and a text `card_id` is left out. A byte order mark
 * before the JSON is ignored. The app and the `wiki-tool` CLI both read the card map with this function.
 */
export function cardMapFromJson(text: string): StructureInput["cardMap"] {
  let raw: unknown
  try {
    raw = JSON.parse(text.replace(/^\uFEFF/, ""))
  } catch {
    return null
  }
  if (!isRecord(raw) || raw.version !== 1 || !isRecord(raw.pages)) return null
  const entries: Array<[string, { status: string; card_id: string }]> = []
  for (const [path, entry] of Object.entries(raw.pages)) {
    if (isRecord(entry) && typeof entry.status === "string" && typeof entry.card_id === "string") {
      entries.push([path, { status: entry.status, card_id: entry.card_id }])
    }
  }
  // `fromEntries` makes plain own properties, also for a page path such as `__proto__`.
  return { pages: Object.fromEntries(entries) }
}

/** The local date of `now` (today by default) as `YYYY-MM-DD`. This is the `today` of `checkStructure`. */
export function localDate(now: Date = new Date()): string {
  const two = (value: number): string => String(value).padStart(2, "0")
  return `${String(now.getFullYear()).padStart(4, "0")}-${two(now.getMonth() + 1)}-${two(now.getDate())}`
}

// --- the checks --------------------------------------------------------

/** Run every check. The findings are sorted by check id, then by page path, so the output is stable. */
export function checkStructure(input: StructureInput): StructureFinding[] {
  if (utcDay(input.today) === null) {
    // A caller bug: every age would be wrong. Do not guess.
    throw new Error(`today must be a date in YYYY-MM-DD form, got "${input.today}"`)
  }
  // Pages the checks look at: real pages under `wiki/`. The index files are made by the app.
  const pages = input.pages.filter((page) => isWikiPage(page.path))
  const problems = (input.configProblems ?? []).map((problem) => problem.trim()).filter((problem) => problem !== "")
  const kinds = problems.map(classifyProblem)
  // A broken list of domains tells nothing about a domain, so the checks that need it stay quiet (ruling U14).
  const domainsBroken = kinds.includes("domains")
  const libraryBroken = kinds.includes("library-domains")
  const findings: StructureFinding[] = [
    ...checkConfigProblems(problems, kinds),
    ...checkDomainMissing(pages),
    ...(domainsBroken ? [] : checkDomainUnknown(pages, input, libraryBroken)),
    ...checkCrossDomain(pages),
    ...checkMechanismInstances(pages, input.identity),
    ...checkCardMap(input),
    ...checkStaleDrafts(pages, input),
    ...(domainsBroken ? [] : checkDomainSizes(pages, input)),
  ]
  return findings.sort(compareFindings)
}

function isWikiPage(path: string): boolean {
  return path.replace(/\\/g, "/").toLowerCase().startsWith("wiki/") && !isAppOwnPath(path)
}

/** One finding for each config problem. The text of the problem is in the message. */
function checkConfigProblems(problems: string[], kinds: ConfigProblemKind[]): StructureFinding[] {
  return problems.map((problem, index) => {
    const kind = kinds[index]
    const consequence =
      kind === "domains"
        ? "The domain checks are skipped until you fix the file."
        : kind === "library-domains"
          ? "The domains of the reading wiki are not checked until you fix the file."
          : kind === "threshold"
            ? "The default value of the threshold is used until you fix the file."
            : "Fix the file."
    return {
      check: "config-invalid",
      page: null,
      message: `A config file has a problem: ${problem.replace(/[.\s]+$/, "")}. ${consequence}`,
    }
  })
}

/**
 * A page without `domain`. Mechanism pages apply to many domains, so they have none. A hypothesis page
 * has `from_domain` and `to_domain` instead, and a missing one is named (ruling U10).
 */
function checkDomainMissing(pages: StructurePage[]): StructureFinding[] {
  const findings: StructureFinding[] = []
  for (const page of pages) {
    if (page.type === MECHANISM_TYPE) continue
    if (page.type === HYPOTHESIS_TYPE) {
      if (isBlank(page.fromDomain)) findings.push(missingHypothesisDomain(page, "from_domain"))
      if (isBlank(page.domain)) findings.push(missingHypothesisDomain(page, "to_domain"))
    } else if (isBlank(page.domain)) {
      findings.push({
        check: "domain-missing",
        page: page.path,
        message: "This page has no domain. Set domain to a path from domains.yaml.",
      })
    }
  }
  return findings
}

function missingHypothesisDomain(page: StructurePage, key: "from_domain" | "to_domain"): StructureFinding {
  return {
    check: "domain-missing",
    page: page.path,
    message: `This hypothesis has no ${key}. Set it to a path from domains.yaml.`,
  }
}

/**
 * A domain, an `also` entry, or a hypothesis `from_domain` or `to_domain` that no domains file lists.
 * Ruling U9: in a work wiki, the domains of the reading wiki are known only as the `from_domain` and
 * `to_domain` of a hypothesis. Every other field must name a domain of this wiki.
 */
function checkDomainUnknown(pages: StructurePage[], input: StructureInput, libraryBroken: boolean): StructureFinding[] {
  const own = new Set(Object.keys(input.domains.domains))
  const isWork = input.identity.role === "work"
  const library = isWork && input.libraryDomains ? new Set(Object.keys(input.libraryDomains.domains)) : null
  // The reading wiki's list cannot be read (ruling U14): a hypothesis domain that this wiki does not list is not judged.
  const libraryUnreadable = isWork && libraryBroken
  const isKnown = (domain: string, field: string): boolean =>
    own.has(domain) ||
    (HYPOTHESIS_DOMAIN_FIELDS.includes(field) && (libraryUnreadable || (library !== null && library.has(domain))))

  const findings: StructureFinding[] = []
  for (const page of pages) {
    // The fields that name an unknown domain on this page, in reading order. A domain that two fields hold is reported once.
    const unknown = new Map<string, string[]>()
    const check = (domain: string | null | undefined, field: string): void => {
      if (typeof domain !== "string" || domain === "" || isKnown(domain, field)) return
      const fields = unknown.get(domain) ?? []
      if (!fields.includes(field)) fields.push(field)
      unknown.set(domain, fields)
    }
    if (page.type === HYPOTHESIS_TYPE) {
      check(page.fromDomain, "from_domain")
      check(page.domain, "to_domain")
    } else {
      check(page.domain, "domain")
    }
    for (const domain of page.also) check(domain, "also")

    for (const [domain, fields] of unknown) {
      const lookedInLibrary = library !== null && fields.some((field) => HYPOTHESIS_DOMAIN_FIELDS.includes(field))
      const where = lookedInLibrary
        ? "It is in neither domains.yaml of this wiki nor domains.yaml of the reading wiki. Add it to domains.yaml, or fix the page."
        : "Add it to domains.yaml, or fix the page."
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
 *
 * A name matches the whole raw name (`heptabase/<card-id>.md`). When the page gives a bare name
 * (`<card-id>.md`) and no source page has that whole name, the name matches by base name, but only
 * when exactly one source page has that base name.
 */
function checkCrossDomain(pages: StructurePage[]): StructureFinding[] {
  const domainsOfName = new Map<string, Set<string>>()
  const pagesOfBaseName = new Map<string, Set<StructurePage>>()
  for (const page of pages) {
    if (page.type !== SOURCE_TYPE) continue
    for (const file of page.sources) {
      const key = sourceKey(file)
      const domains = domainsOfName.get(key) ?? new Set<string>()
      if (hasDomain(page)) domains.add(page.domain as string)
      domainsOfName.set(key, domains)
      const base = key.slice(key.lastIndexOf("/") + 1)
      pagesOfBaseName.set(base, (pagesOfBaseName.get(base) ?? new Set<StructurePage>()).add(page))
    }
  }

  const domainsOfReference = (reference: string): Iterable<string> => {
    const key = sourceKey(reference)
    const exact = domainsOfName.get(key)
    if (exact) return exact
    const candidates = key.includes("/") ? undefined : pagesOfBaseName.get(key)
    if (candidates?.size !== 1) return []
    const [only] = candidates
    return hasDomain(only) ? [only.domain as string] : []
  }

  const findings: StructureFinding[] = []
  for (const page of pages) {
    if (!CROSS_DOMAIN_TYPES.includes(page.type)) continue
    const domains = new Set<string>()
    for (const file of page.sources) for (const domain of domainsOfReference(file)) domains.add(domain)
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

/**
 * A retired card is left in Heptabase for the user to delete. An active entry needs its page.
 *
 * A retired entry whose page file exists again is not reported when the sync mirrors the page (`mirrored`): the
 * next sync updates that card and makes it active, so the user must not delete it. When the user deleted a
 * retired card, the next sync drops the entry (`hepta plan-down` plans `forget`), and this finding ends.
 */
function checkCardMap(input: StructureInput): StructureFinding[] {
  if (input.cardMap === null) return []
  // Every page counts here, so a page that no check looks at still keeps its card.
  const byPath = new Map(input.pages.map((page) => [normalizePath(page.path), page]))
  const findings: StructureFinding[] = []
  for (const [rawPath, entry] of Object.entries(input.cardMap.pages)) {
    const path = normalizePath(rawPath)
    if (entry.status === "retired") {
      const page = byPath.get(path)
      if (page?.mirrored === true) continue
      findings.push({
        check: "mirror-retired",
        page: path,
        message:
          `The card of ${path}${page === undefined ? "" : ` ("${page.title}")`} is retired. Card id: ${entry.card_id}. ` +
          `Find the card in the mirror tag by this id or by the "${RETIRED_TITLE_PREFIX}" title prefix. Delete it by hand. ` +
          "The next wiki-sync then drops the entry from the card map.",
      })
    } else if (entry.status === "active" && !byPath.has(path)) {
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
 * The age counts from `updated`. When `updated` is missing or not a date, it counts from `created`.
 * A draft with neither date is reported, because its age is unknown.
 */
function checkStaleDrafts(pages: StructurePage[], input: StructureInput): StructureFinding[] {
  const limit = input.identity.lint.draft_days
  const findings: StructureFinding[] = []
  for (const page of pages) {
    if (page.type !== HYPOTHESIS_TYPE || page.status !== "draft") continue
    const dated = [
      { label: "updated", text: page.updated },
      { label: "created", text: page.created },
    ].find((candidate) => candidate.text !== undefined && utcDay(candidate.text) !== null)
    if (!dated || dated.text === undefined) {
      findings.push({
        check: "hypothesis-stale-draft",
        page: page.path,
        message: "The date of this draft hypothesis is not readable. Set updated to a date in YYYY-MM-DD form.",
      })
      continue
    }
    const age = daysBetween(dated.text, input.today)
    if (age === null || age <= limit) continue
    findings.push({
      check: "hypothesis-stale-draft",
      page: page.path,
      message:
        `This hypothesis has been a draft for ${age} days (${dated.label} ${dated.text.trim().slice(0, 10)}). ` +
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

/** The UTC time of a `YYYY-MM-DD` date (a time after it is allowed). Null when the text is not a real date. */
function utcDay(text: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:$|[T\s])/.exec(text.trim())
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
 *
 * `domain-too-large` uses the pages of the domain itself: splitting it into child domains is the cure. `domain-too-small`
 * adds the pages of every listed domain below it (`<domain>/...`), so a parent whose pages are all in its children is
 * not reported as empty. A domain of the wiki that `domains.yaml` does not list has no count.
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
      continue
    }
    const children = [...counts].filter(([other]) => other.startsWith(`${domain}/`))
    const total = children.reduce((sum, [, childCount]) => sum + childCount, count)
    if (total < min) {
      findings.push({
        check: "domain-too-small",
        page: null,
        message: `Domain "${domain}" has ${plural(total)}${children.length > 0 ? " with its child domains" : ""}. The minimum is ${min}. Add pages, or merge it into a parent domain.`,
        domains: [domain],
      })
    }
  }
  return findings
}

// --- helpers -----------------------------------------------------------

function hasDomain(page: StructurePage): boolean {
  return !isBlank(page.domain)
}

/** True for null, undefined, and text of white space only. */
function isBlank(value: string | null | undefined): boolean {
  return value === null || value === undefined || value.trim() === ""
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
