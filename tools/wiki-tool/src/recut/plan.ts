/**
 * The plan of a recut: the JSON that `recut apply` takes, the check of it against the wiki, and the changes it makes
 * to the domain list. Everything here is pure; the files are read and written in `apply.ts`.
 *
 * Four operations (design section 9.2):
 * - `rename` and `move` are one operation: a domain and its child domains (`from/...`) get a new name (`to` and
 *   `to/...`). The two names differ in what the user means, not in what the code does.
 * - `split` replaces one domain by new domains. `assignments` gives the new domain of every page that uses the old one.
 * - `merge` brings several domains into one. The target is a new domain, one of the merged domains, or another
 *   domain that exists; its `lens` and `description` come from the plan.
 *
 * A target of `rename`, `move`, and `split` must not exist. The child domains of a split or merged domain stay where
 * they are (the output names them).
 */
import { MECHANISM_TYPE } from "@/lib/mechanism-wiki/domain-index-render"
import { DOMAIN_NAME_PATTERN, type DomainEntry, type DomainsConfig } from "@/lib/wiki-config/domains"
import { hasOwn, isRecord } from "@/lib/wiki-config/yaml-util"
import { compareText } from "../mirror-pages"
import type { GeneratedDomain } from "./domains-file"
import type { RecutPage } from "./page-refs"

export interface DomainText {
  domain: string
  lens: string
  description: string
}

export interface RenamePlan {
  op: "rename" | "move"
  from: string
  to: string
}

export interface SplitPlan {
  op: "split"
  from: string
  into: DomainText[]
  /** Page path to its new domain. */
  assignments: Record<string, string>
}

export interface MergePlan {
  op: "merge"
  from: string[]
  into: DomainText
}

export type RecutPlan = RenamePlan | SplitPlan | MergePlan

// --- reading the plan ----------------------------------------------------

const OPS = ["rename", "move", "split", "merge"] as const
const KEYS: Record<(typeof OPS)[number], readonly string[]> = {
  rename: ["op", "from", "to"],
  move: ["op", "from", "to"],
  split: ["op", "from", "into", "assignments"],
  merge: ["op", "from", "into"],
}
const DOMAIN_TEXT_KEYS = ["domain", "lens", "description"] as const

export type ParsedPlan = { ok: true; plan: RecutPlan } | { ok: false; problems: string[] }

/** The plan in `text` (JSON). Every problem of its shape is returned, each as one message. */
export function parseRecutPlan(text: string): ParsedPlan {
  let raw: unknown
  try {
    raw = JSON.parse(text.replace(/^\uFEFF/, ""))
  } catch (error) {
    return { ok: false, problems: [`the plan is not valid JSON: ${error instanceof Error ? error.message : String(error)}`] }
  }
  if (!isRecord(raw)) return { ok: false, problems: ["the plan must be a JSON object"] }
  const op = raw.op
  if (typeof op !== "string") return { ok: false, problems: ['the plan needs "op": rename, move, split, or merge'] }
  if (!(OPS as readonly string[]).includes(op)) {
    return { ok: false, problems: [`unknown op: ${JSON.stringify(op)} (use rename, move, split, or merge)`] }
  }
  const kind = op as (typeof OPS)[number]

  const problems = Object.keys(raw)
    .filter((key) => !KEYS[kind].includes(key))
    .map((key) => `unknown key in the plan: ${key}`)

  if (kind === "rename" || kind === "move") {
    const from = textOf(raw.from)
    const to = textOf(raw.to)
    if (from === null) problems.push(`${kind} needs "from" as text`)
    if (to === null) problems.push(`${kind} needs "to" as text`)
    return problems.length > 0 || from === null || to === null ? { ok: false, problems } : { ok: true, plan: { op: kind, from, to } }
  }

  if (kind === "split") {
    const from = textOf(raw.from)
    if (from === null) problems.push('split needs "from" as text')
    const into: DomainText[] = []
    if (!Array.isArray(raw.into) || raw.into.length === 0) {
      problems.push('split needs "into" with at least one domain')
    } else {
      raw.into.forEach((item, index) => {
        const entry = readDomainText(item, `into[${index}]`, problems)
        if (entry !== null) into.push(entry)
      })
    }
    const assignments: Record<string, string> = {}
    if (!isRecord(raw.assignments)) {
      problems.push('split needs "assignments" as an object of page path to new domain')
    } else {
      for (const [path, value] of Object.entries(raw.assignments)) {
        const domain = textOf(value)
        if (domain === null) problems.push(`assignments[${JSON.stringify(path)}] must be the name of a new domain as text`)
        else Object.defineProperty(assignments, path, { value: domain, enumerable: true, writable: true, configurable: true })
      }
    }
    return problems.length > 0 || from === null ? { ok: false, problems } : { ok: true, plan: { op: "split", from, into, assignments } }
  }

  const from: string[] = []
  if (!Array.isArray(raw.from) || raw.from.some((item) => textOf(item) === null)) {
    problems.push('merge needs "from" as a list of domains')
  } else {
    from.push(...(raw.from as string[]))
  }
  let into: DomainText | null = null
  if (!isRecord(raw.into)) problems.push('merge needs "into" with domain, lens, and description')
  else into = readDomainText(raw.into, "into", problems)
  return problems.length > 0 || into === null ? { ok: false, problems } : { ok: true, plan: { op: "merge", from, into } }
}

function textOf(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null
}

function readDomainText(value: unknown, label: string, problems: string[]): DomainText | null {
  if (!isRecord(value)) {
    problems.push(`${label} must be an object with domain, lens, and description`)
    return null
  }
  for (const key of Object.keys(value)) {
    if (!(DOMAIN_TEXT_KEYS as readonly string[]).includes(key)) problems.push(`unknown key in ${label}: ${key}`)
  }
  const fields = DOMAIN_TEXT_KEYS.map((key) => [key, textOf(value[key])] as const)
  for (const [key, field] of fields) if (field === null) problems.push(`${label} needs "${key}" as text`)
  const [domain, lens, description] = fields.map(([, field]) => field)
  return domain === null || lens === null || description === null ? null : { domain, lens, description }
}

// --- checking the plan ---------------------------------------------------

export interface ValidateInput {
  plan: RecutPlan
  /** `domains.yaml` of the wiki. */
  domains: DomainsConfig
  pages: readonly RecutPage[]
  /** The names of the lenses that `domains.yaml` accepts. */
  lenses: readonly string[]
}

const MAX_LISTED = 20

/** Why the plan cannot run on this wiki. An empty list means that it can. */
export function validateRecutPlan(input: ValidateInput): string[] {
  const { plan } = input
  if (plan.op === "split") return validateSplit(input, plan)
  if (plan.op === "merge") return validateMerge(input, plan)
  return validateRename(input, plan)
}

function listed(names: readonly string[]): string {
  const shown = names.slice(0, MAX_LISTED).join(", ")
  return names.length > MAX_LISTED ? `${shown} and ${names.length - MAX_LISTED} more` : shown
}

function unknownDomain(domain: string): string {
  return `the domain ${domain} is not in domains.yaml`
}

function nameProblem(name: string): string | null {
  return DOMAIN_NAME_PATTERN.test(name)
    ? null
    : `the new name "${name}" is not a domain name: use lowercase letters, digits, and "-", with "/" between levels`
}

function validateRename({ plan, domains }: ValidateInput, rename: RenamePlan): string[] {
  const { from, to } = rename
  if (!hasOwn(domains.domains, from)) return [unknownDomain(from)]
  const bad = nameProblem(to)
  if (bad !== null) return [bad]
  if (to === from) return [`the new name is the old name: ${from}`]
  if (to.startsWith(`${from}/`)) return [`cannot move ${from} below itself (${to})`]

  const mapper = createMapper(plan)
  const moved = movedDomains(domains, from)
  const problems: string[] = []
  for (const domain of moved) {
    const target = mapper.map(domain, "")
    if (hasOwn(domains.domains, target) && !moved.includes(target)) problems.push(`the domain ${target} already exists`)
  }
  return problems
}

/** The domains of a rename: `from` and the domains below it, in the order of the file. */
function movedDomains(domains: DomainsConfig, from: string): string[] {
  return Object.keys(domains.domains).filter((domain) => domain === from || domain.startsWith(`${from}/`))
}

/** The problems of new domains that a split or a merge makes (name, lens, description). */
function newDomainProblems(entries: readonly DomainText[], lenses: readonly string[], taken: (domain: string) => boolean): string[] {
  const problems: string[] = []
  const seen = new Set<string>()
  for (const entry of entries) {
    const bad = nameProblem(entry.domain)
    if (bad !== null) {
      problems.push(bad)
      continue
    }
    if (seen.has(entry.domain)) problems.push(`the new domain ${entry.domain} is listed twice`)
    else if (taken(entry.domain)) problems.push(`the domain ${entry.domain} already exists`)
    seen.add(entry.domain)
    if (!lenses.includes(entry.lens)) {
      problems.push(`the lens "${entry.lens}" of ${entry.domain} is not a lens: use one of ${lenses.join(", ")}`)
    }
    if (entry.description.trim() === "") problems.push(`the description of ${entry.domain} is empty`)
  }
  return problems
}

function validateSplit({ domains, pages, lenses }: ValidateInput, split: SplitPlan): string[] {
  if (!hasOwn(domains.domains, split.from)) return [unknownDomain(split.from)]
  const stage = newDomainProblems(split.into, lenses, (domain) => hasOwn(domains.domains, domain))
  if (stage.length > 0) return stage

  const problems: string[] = []
  const users = pages.filter((page) => page.refs.some((ref) => ref.value === split.from))
  const left = users.filter((page) => !hasOwn(split.assignments, page.path)).map((page) => page.path)
  if (left.length > 0) {
    problems.push(`the split leaves ${left.length} page${left.length === 1 ? "" : "s"} without a new domain: ${listed(left)}`)
  }
  const userPaths = new Set(users.map((page) => page.path))
  const strangers = Object.keys(split.assignments).filter((path) => !userPaths.has(path))
  if (strangers.length > 0) problems.push(`the assignments name a page that does not use ${split.from}: ${listed(strangers)}`)
  const newNames = new Set(split.into.map((entry) => entry.domain))
  for (const [path, domain] of Object.entries(split.assignments)) {
    if (!newNames.has(domain)) problems.push(`the assignment of ${path} names ${domain}, which is not in "into"`)
  }
  return problems
}

function validateMerge({ domains, lenses }: ValidateInput, merge: MergePlan): string[] {
  if (merge.from.length < 2) return ['a merge needs at least two domains in "from"']
  const problems: string[] = []
  merge.from.forEach((domain, index) => {
    if (merge.from.indexOf(domain) !== index) problems.push(`the domain ${domain} is listed twice in "from"`)
    else if (!hasOwn(domains.domains, domain)) problems.push(unknownDomain(domain))
  })
  if (problems.length > 0) return problems
  // The target may be new, one of the merged domains, or another domain that exists.
  return newDomainProblems([merge.into], lenses, () => false)
}

// --- the effect of the plan ----------------------------------------------

export interface DomainMapper {
  /** The new name of `domain` as a reference of the page at `pagePath`. A domain that the plan does not touch comes back as it is. */
  map(domain: string, pagePath: string): string
}

export function createMapper(plan: RecutPlan): DomainMapper {
  if (plan.op === "split") {
    return { map: (domain, pagePath) => (domain === plan.from && hasOwn(plan.assignments, pagePath) ? plan.assignments[pagePath] : domain) }
  }
  if (plan.op === "merge") {
    return { map: (domain) => (plan.from.includes(domain) ? plan.into.domain : domain) }
  }
  return {
    map: (domain) => {
      if (domain === plan.from) return plan.to
      return domain.startsWith(`${plan.from}/`) ? `${plan.to}${domain.slice(plan.from.length)}` : domain
    },
  }
}

export interface DomainChanges {
  /** `domains.yaml` after the recut. */
  next: DomainsConfig
  /** Old name to new name: the key line of the entry changes. */
  renames: Map<string, string>
  /** The entries that replace the entry of a domain. An empty list removes the entry. */
  replacements: Map<string, GeneratedDomain[]>
  /** The domains that the recut removes from the list (their index files go too). */
  removed: string[]
  /** Things the user should know about, in plain sentences. */
  notes: string[]
}

export function planDomains(plan: RecutPlan, current: DomainsConfig): DomainChanges {
  const names = Object.keys(current.domains)
  const renames = new Map<string, string>()
  const replacements = new Map<string, GeneratedDomain[]>()
  const entries: Array<[string, DomainEntry]> = []
  const notes: string[] = []

  if (plan.op === "split") {
    const dropped = current.domains[plan.from].whiteboards
    replacements.set(plan.from, plan.into.map((entry) => generated(entry.domain, entry, [])))
    for (const name of names) {
      if (name === plan.from) for (const entry of plan.into) entries.push([entry.domain, { lens: entry.lens, description: entry.description, whiteboards: [] }])
      else entries.push([name, copyEntry(current.domains[name])])
    }
    if (dropped.length > 0) {
      notes.push(`The whiteboard hints of ${plan.from} were dropped: ${dropped.join(", ")}. Add them to the new domains by hand if you need them.`)
    }
  } else if (plan.op === "merge") {
    // The target takes the place of its own entry when it exists, else of the first merged entry in the file.
    const merged = names.filter((name) => plan.from.includes(name))
    const place = hasOwn(current.domains, plan.into.domain) ? plan.into.domain : merged[0]
    // The whiteboard hints of every domain that joins, in the order of the file.
    const joined = names.filter((name) => name === plan.into.domain || plan.from.includes(name))
    const whiteboards = [...new Set(joined.flatMap((name) => current.domains[name].whiteboards))]
    for (const name of names) {
      if (name === place) {
        replacements.set(name, [generated(plan.into.domain, plan.into, whiteboards)])
        entries.push([plan.into.domain, { lens: plan.into.lens, description: plan.into.description, whiteboards }])
      } else if (merged.includes(name)) {
        replacements.set(name, [])
      } else {
        entries.push([name, copyEntry(current.domains[name])])
      }
    }
  } else {
    const mapper = createMapper(plan)
    for (const name of names) {
      const next = mapper.map(name, "")
      if (next !== name) renames.set(name, next)
      entries.push([next, copyEntry(current.domains[name])])
    }
  }

  const next: DomainsConfig = { version: 1, domains: Object.fromEntries(entries) }
  const removed = names.filter((name) => !hasOwn(next.domains, name))
  if (plan.op === "split" || plan.op === "merge") {
    const stay = names.filter((name) => hasOwn(next.domains, name) && removed.some((gone) => name.startsWith(`${gone}/`)))
    if (stay.length > 0) notes.push(`These child domains stay as they are: ${stay.join(", ")}.`)
  }
  return { next, renames, replacements, removed, notes }
}

function copyEntry(entry: DomainEntry): DomainEntry {
  return { lens: entry.lens, description: entry.description, whiteboards: [...entry.whiteboards] }
}

function generated(name: string, text: DomainText, whiteboards: readonly string[]): GeneratedDomain {
  return { name, lens: text.lens, description: text.description, whiteboards: [...whiteboards] }
}

/** The subject of the commit without its prefix and its count: `rename <from> → <to>`. */
export function planTitle(plan: RecutPlan): string {
  if (plan.op === "split") return `split ${plan.from} → ${plan.into.map((entry) => entry.domain).join("+")}`
  if (plan.op === "merge") return `merge ${plan.from.join("+")} → ${plan.into.domain}`
  return `${plan.op} ${plan.from} → ${plan.to}`
}

// --- merge candidates ----------------------------------------------------

export interface MergeCandidate {
  a: string
  b: string
}

/**
 * Pairs of pages with the same slug that a merge brings into one domain: the pages of the merged domains and of the
 * target, from two different domains. The two paths of a pair are in path order, and so are the pairs.
 */
export function findMergeCandidates(plan: RecutPlan, pages: readonly RecutPage[]): MergeCandidate[] {
  if (plan.op !== "merge") return []
  const joined = new Set([...plan.from, plan.into.domain])
  const bySlug = new Map<string, RecutPage[]>()
  for (const page of pages) {
    if (page.domain === null || !joined.has(page.domain) || page.type === MECHANISM_TYPE) continue
    bySlug.set(page.slug, [...(bySlug.get(page.slug) ?? []), page])
  }
  const pairs: MergeCandidate[] = []
  for (const group of bySlug.values()) {
    const sorted = [...group].sort((x, y) => compareText(x.path, y.path))
    for (let first = 0; first < sorted.length; first += 1) {
      for (let second = first + 1; second < sorted.length; second += 1) {
        if (sorted[first].domain !== sorted[second].domain) pairs.push({ a: sorted[first].path, b: sorted[second].path })
      }
    }
  }
  return pairs.sort((x, y) => compareText(x.a, y.a) || compareText(x.b, y.b))
}
