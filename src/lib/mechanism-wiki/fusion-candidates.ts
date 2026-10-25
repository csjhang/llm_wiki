/**
 * Fusion candidates.
 *
 * A new mechanism page may also work in domains where the wiki has no instance of it yet. After an ingest
 * writes a new mechanism page in a reading wiki, `proposeFusionCandidates` asks the model for up to three
 * such domains and sends them to review as one `fusion-candidate` item. The user starts a fusion from that
 * item (`mech:start-fusion`, which copies the command of the `wiki-fuse` skill) or skips it
 * (`mech:dismiss-fusion`, which records the skipped pairs so they never come back).
 *
 * The model answers in lines of `CANDIDATE: <domain> | <surface|structural|mathematical> | <reason>`.
 * `parseCandidates` keeps only the lines that name a domain of this wiki, that has no instance of the
 * mechanism, and that the user did not skip. The item stores the kept lines in its description in the same
 * form, so `mech:dismiss-fusion` can read them back.
 */
import { readFile, writeFileAtomic } from "@/commands/fs"
import { parseFrontmatter } from "@/lib/frontmatter"
import { streamChat } from "@/lib/llm-client"
import { isAbsolutePath, normalizePath } from "@/lib/path-utils"
import { withProjectLock } from "@/lib/project-mutex"
import { resolveIngestReasoning } from "@/lib/reasoning-capabilities"
import { findSection, MECHANISM_SECTIONS } from "@/lib/wiki-config/section-headings"
import { hasOwn } from "@/lib/wiki-config/yaml-util"
import { reviewIdFor, useReviewStore } from "@/stores/review-store"
import type { ReviewItem } from "@/stores/review-store"
import type { LlmConfig } from "@/stores/wiki-store"
import { canWriteMechanismPages } from "./context"
import type { MechanismContext } from "./context"

type ReviewDraft = Omit<ReviewItem, "id" | "resolved" | "createdAt">

export type FusionStrength = "surface" | "structural" | "mathematical"

export interface FusionCandidate {
  /** Project-relative path of the mechanism page. Empty when the caller of `parseCandidates` gave none. */
  mechanism: string
  targetDomain: string
  reason: string
  strength: FusionStrength
}

/** A candidate that the user skipped. The same pair is never proposed again. */
export interface DismissedPair {
  mechanism: string
  targetDomain: string
}

/** Where the skipped pairs are kept, relative to the project. A JSON array of `DismissedPair`. */
export const FUSION_DISMISSED_FILE = ".llm-wiki/fusion-dismissed.json"

/** The review type and the option actions of a fusion candidate item. */
export const FUSION_CANDIDATE_TYPE = "fusion-candidate" as const
export const START_FUSION_ACTION = "mech:start-fusion"
export const DISMISS_FUSION_ACTION = "mech:dismiss-fusion"

/** A new mechanism gets at most this many candidates. */
export const MAX_CANDIDATES = 3

/** How many of the newest snapshots tell which boards the user works on. */
const RECENT_SNAPSHOTS = 5

/** The card map. wiki-tool writes it to the project folder; the folder `.llm-wiki` is the fallback. */
const CARD_MAP_FILES = ["heptabase-map.json", ".llm-wiki/heptabase-map.json"] as const

/** The model has nothing to write but three short lines; the rest is room for a reasoning model. */
const MAX_OUTPUT_TOKENS = 4_096

const STRENGTHS: readonly FusionStrength[] = ["surface", "structural", "mathematical"]

const CANDIDATE_FORMAT = "CANDIDATE: <domain> | <surface|structural|mathematical> | <reason>"

/** The Known instances section. `section-headings.ts` always defines it. */
const INSTANCES_SECTION = MECHANISM_SECTIONS.filter((section) => section.key === "instances")[0]

/** `- [[slug]] (domain): term`. The captured group is the domain. */
const INSTANCE_LINE = /^[ \t]*[-*+][ \t]+!?\[\[[^\]\r\n]*\]\][ \t]*\(([^)\r\n]+)\)/

/** One `CANDIDATE:` line. The group is everything after the keyword. A bullet before the keyword is allowed. */
const CANDIDATE_LINE = /^[ \t]*(?:[-*][ \t]+)?CANDIDATE:(.*)$/

// --- reading and writing the lines -------------------------------------

/** A `CANDIDATE:` line as written, before it is checked against the wiki. */
export interface CandidateLine {
  domain: string
  strength: string
  reason: string
}

/** Every line of `text` that has the form of a candidate line, in order. Nothing else is checked. */
export function readCandidateLines(text: string): CandidateLine[] {
  const lines: CandidateLine[] = []
  for (const raw of text.split(/\r?\n/)) {
    const match = CANDIDATE_LINE.exec(raw)
    if (match === null) continue
    const parts = match[1].split("|")
    if (parts.length < 3) continue
    lines.push({
      domain: parts[0].trim(),
      strength: parts[1].trim().toLowerCase(),
      reason: parts.slice(2).join("|").trim(),
    })
  }
  return lines
}

/** The domains that the Known instances section of a mechanism page names, in page order, without repeats. */
export function instanceDomainsOf(mechanismPage: string): string[] {
  const section = findSection(mechanismPage, INSTANCES_SECTION)
  if (section === null) return []
  const domains: string[] = []
  for (const line of section.split(/\r?\n/)) {
    const domain = INSTANCE_LINE.exec(line)?.[1].trim()
    if (domain !== undefined && domain !== "" && !domains.includes(domain)) domains.push(domain)
  }
  return domains
}

// --- the prompt ---------------------------------------------------------

export interface CandidatePromptOptions {
  /** Domains that the user skipped for this mechanism. */
  dismissedDomains?: readonly string[]
  /** Domains to skip besides the ones that the page names, for example the domain of the source of this ingest. */
  skipDomains?: readonly string[]
}

/**
 * The prompt that asks the model for fusion candidates of one mechanism. It carries the page, the domains
 * of the wiki with their lens, the domains to skip, and the boards the user works on. It asks for at most
 * three lines in the form of `CANDIDATE_FORMAT` and nothing else.
 */
export function buildCandidatePrompt(
  mechanismPage: string,
  ctx: MechanismContext,
  recentBoards: readonly string[],
  options: CandidatePromptOptions = {},
): string {
  const domains = Object.entries(ctx.domains.domains)
    .map(([name, entry]) => `- ${name} (lens: ${entry.lens}): ${entry.description}`)
    .join("\n")
  const hasInstance = unique([...instanceDomainsOf(mechanismPage), ...(options.skipDomains ?? [])])
  const dismissed = unique(options.dismissedDomains ?? [])
  const boards = unique(recentBoards.map((board) => board.trim()).filter((board) => board !== ""))

  const preferences = [
    "A domain whose lens fits the mechanism and that has no instance of it yet.",
    ...(boards.length > 0 ? ["A domain that the recent boards touch."] : []),
  ]

  return [
    "You find domains where a mechanism may also work. A mechanism is a structure that repeats across domains.",
    "Read the mechanism page below. Then choose the domains of this wiki where the same structure may appear.",
    "",
    "## Mechanism page",
    "",
    mechanismPage.trim(),
    "",
    "## Domains of this wiki",
    "",
    "Choose only from these domains. Write each name exactly as it appears here.",
    "",
    domains === "" ? "(none)" : domains,
    ...(hasInstance.length > 0
      ? ["", `Each of these domains already has an instance of this mechanism, so never choose them: ${hasInstance.join(", ")}`]
      : []),
    ...(dismissed.length > 0
      ? ["", `The user dismissed these domains for this mechanism, so never choose them: ${dismissed.join(", ")}`]
      : []),
    ...(boards.length > 0
      ? ["", "## Recent boards", "", "The user works on these boards now. Prefer domains that they touch.", "", ...boards.map((board) => `- ${board}`)]
      : []),
    "",
    "## Task",
    "",
    `Write at most ${MAX_CANDIDATES} candidates. Prefer, in this order:`,
    ...preferences.map((preference, index) => `${index + 1}. ${preference}`),
    "",
    "Give each candidate a strength. It says what kind of match you expect:",
    "- surface: the same look or the same words, with little shared structure.",
    "- structural: the parts and the flows match one to one.",
    "- mathematical: the same equation or the same update rule.",
    "",
    "Write one line per candidate, in exactly this form, and write nothing else:",
    CANDIDATE_FORMAT,
    "The reason is one short sentence in domain-neutral words. It says which part of the mechanism meets which part of the domain.",
    "If no domain fits, write nothing.",
  ].join("\n")
}

// --- reading the answer -------------------------------------------------

/**
 * The candidates in the answer of the model.
 *
 * A line is kept when it has the form `CANDIDATE: <domain> | <strength> | <reason>`, the domain is a domain of
 * `ctx` (exact match after trimming), the strength is one of the three, the reason is not empty, the domain
 * has no instance (`instanceDomains`), and the pair is not in `dismissed`. A domain that appears twice is
 * kept once. The first `MAX_CANDIDATES` kept lines are returned, in the order of the answer.
 *
 * `mechanism` is the project-relative path of the mechanism page. With it, only the dismissed pairs of that
 * mechanism count, and each candidate carries it. Without it, `dismissed` is taken as the pairs of the
 * mechanism that is being checked, so every domain in it is dropped.
 */
export function parseCandidates(
  output: string,
  ctx: MechanismContext,
  dismissed: readonly DismissedPair[],
  instanceDomains: readonly string[],
  mechanism?: string,
): FusionCandidate[] {
  const blocked = new Set<string>(instanceDomains.map((domain) => domain.trim()))
  for (const pair of dismissed) {
    if (mechanism === undefined || pair.mechanism === mechanism) blocked.add(pair.targetDomain)
  }

  const candidates: FusionCandidate[] = []
  for (const line of readCandidateLines(output)) {
    if (candidates.length >= MAX_CANDIDATES) break
    if (!hasOwn(ctx.domains.domains, line.domain)) continue
    if (!isStrength(line.strength) || line.reason === "") continue
    if (blocked.has(line.domain)) continue
    blocked.add(line.domain)
    candidates.push({ mechanism: mechanism ?? "", targetDomain: line.domain, reason: line.reason, strength: line.strength })
  }
  return candidates
}

function isStrength(value: string): value is FusionStrength {
  return (STRENGTHS as readonly string[]).includes(value)
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)]
}

// --- the skipped pairs --------------------------------------------------

/** The entries of `.llm-wiki/fusion-dismissed.json` as they are. A missing file or a file that is not an array gives []. */
async function readDismissedEntries(projectPath: string): Promise<unknown[]> {
  try {
    const parsed: unknown = JSON.parse(await readFile(`${projectRoot(projectPath)}/${FUSION_DISMISSED_FILE}`))
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function isDismissedPair(value: unknown): value is DismissedPair {
  if (typeof value !== "object" || value === null) return false
  const entry = value as Record<string, unknown>
  return typeof entry.mechanism === "string" && typeof entry.targetDomain === "string"
}

/** The pairs that the user skipped. A missing or unreadable file gives an empty list; an entry that is not a pair is left out. */
export async function readDismissedPairs(projectPath: string): Promise<DismissedPair[]> {
  return (await readDismissedEntries(projectPath)).filter(isDismissedPair)
}

/**
 * Add `pairs` to `.llm-wiki/fusion-dismissed.json`: the file is created when it is missing, a pair that is
 * in it already is not added again, and an entry of the file that is not a pair stays as it is.
 */
export async function recordDismissedPairs(projectPath: string, pairs: readonly DismissedPair[]): Promise<void> {
  const root = projectRoot(projectPath)
  await withProjectLock(`${root}\0${FUSION_DISMISSED_FILE}`, async () => {
    const entries = await readDismissedEntries(root)
    const known = new Set(entries.filter(isDismissedPair).map(pairKey))
    for (const pair of pairs) {
      const key = pairKey(pair)
      if (known.has(key)) continue
      known.add(key)
      entries.push({ mechanism: pair.mechanism, targetDomain: pair.targetDomain })
    }
    await writeFileAtomic(`${root}/${FUSION_DISMISSED_FILE}`, `${JSON.stringify(entries, null, 2)}\n`)
  })
}

function pairKey(pair: DismissedPair): string {
  return `${pair.mechanism}\0${pair.targetDomain}`
}

function projectRoot(projectPath: string): string {
  return normalizePath(projectPath).replace(/\/+$/, "")
}

// --- the boards the user works on --------------------------------------

/**
 * The titles of the boards that the user touched last: the distinct `heptabase_whiteboards` of the five
 * newest snapshots in the card map (by `card_updated_at`), newest first. Empty when the project has no
 * card map or no snapshot. A map, a snapshot, or a path that cannot be used is skipped; this never throws.
 */
export async function readRecentBoards(projectPath: string): Promise<string[]> {
  const root = projectRoot(projectPath)
  const sources = await readCardMapSources(root)
  const newest = sources
    .map((source) => ({ ...source, time: timeOf(source.updatedAt) }))
    .sort((a, b) => b.time - a.time || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    .slice(0, RECENT_SNAPSHOTS)

  const boards: string[] = []
  for (const source of newest) {
    for (const board of await readSnapshotBoards(root, source.path)) {
      if (!boards.includes(board)) boards.push(board)
    }
  }
  return boards
}

interface MapSource {
  path: string
  updatedAt: string
}

/** The `sources` of the first card map that can be read. */
async function readCardMapSources(root: string): Promise<MapSource[]> {
  for (const file of CARD_MAP_FILES) {
    try {
      const parsed: unknown = JSON.parse(await readFile(`${root}/${file}`))
      const sources = typeof parsed === "object" && parsed !== null ? (parsed as { sources?: unknown }).sources : undefined
      if (typeof sources !== "object" || sources === null || Array.isArray(sources)) continue
      const found: MapSource[] = []
      for (const entry of Object.values(sources as Record<string, unknown>)) {
        if (typeof entry !== "object" || entry === null) continue
        const { raw_path: path, card_updated_at: updatedAt } = entry as Record<string, unknown>
        if (typeof path === "string" && path.trim() !== "") {
          found.push({ path: path.trim(), updatedAt: typeof updatedAt === "string" ? updatedAt : "" })
        }
      }
      return found
    } catch {
      // The next candidate file.
    }
  }
  return []
}

function timeOf(text: string): number {
  const time = Date.parse(text)
  return Number.isNaN(time) ? Number.NEGATIVE_INFINITY : time
}

/** The boards in the frontmatter of one snapshot. A path that leaves the project, or a file that cannot be read, gives []. */
async function readSnapshotBoards(root: string, rawPath: string): Promise<string[]> {
  const relative = normalizePath(rawPath)
  const segments = relative.split("/")
  if (isAbsolutePath(relative) || segments.some((segment) => segment === "" || segment === "." || segment === "..")) return []
  try {
    const value = parseFrontmatter(await readFile(`${root}/${relative}`)).frontmatter?.heptabase_whiteboards
    const titles = Array.isArray(value) ? value : typeof value === "string" ? [value] : []
    return titles.filter((title): title is string => typeof title === "string").map((title) => title.trim()).filter((title) => title !== "")
  } catch {
    return []
  }
}

// --- proposing ----------------------------------------------------------

export interface ProposeOptions {
  /** The domain of the source of the ingest. It counts as a domain with an instance, even when the page lacks the line. */
  sourceDomain?: string | null
  /** Stops the call to the model, and then nothing is added. */
  signal?: AbortSignal
}

/**
 * Ask the model for fusion candidates of the mechanism page at `mechanismPath` (project-relative) and send
 * them to review as one `fusion-candidate` item. Returns the number of review items added: 1, or 0 when the
 * wiki cannot hold mechanism pages, no domain is left to try, the model names no usable candidate, or the
 * mechanism has its item already. Writes no file. Throws when the page cannot be read or the model call
 * fails; the ingest catches that, because candidates are an extra.
 */
export async function proposeFusionCandidates(
  projectPath: string,
  ctx: MechanismContext,
  mechanismPath: string,
  llm: LlmConfig,
  options: ProposeOptions = {},
): Promise<number> {
  if (!canWriteMechanismPages(ctx)) return 0
  const root = projectRoot(projectPath)
  const page = normalizePath(mechanismPath).replace(/^\/+/, "")
  const text = await readFile(`${root}/${page}`)

  const instanceDomains = unique([...instanceDomainsOf(text), ...(options.sourceDomain ? [options.sourceDomain.trim()] : [])])
  const dismissed = await readDismissedPairs(root)
  const dismissedHere = dismissed.filter((pair) => pair.mechanism === page).map((pair) => pair.targetDomain)
  const skipped = new Set([...instanceDomains, ...dismissedHere])
  // Nothing to ask: every domain has an instance or was skipped.
  if (Object.keys(ctx.domains.domains).every((domain) => skipped.has(domain))) return 0
  if (options.signal?.aborted) return 0

  const prompt = buildCandidatePrompt(text, ctx, await readRecentBoards(root), {
    dismissedDomains: dismissedHere,
    skipDomains: options.sourceDomain ? [options.sourceDomain.trim()] : [],
  })
  const output = await askModel(llm, prompt, options.signal)
  if (options.signal?.aborted) return 0

  const candidates = parseCandidates(output, ctx, dismissed, instanceDomains, page)
  if (candidates.length === 0) return 0

  const name = mechanismTitle(text, page)
  const item: ReviewDraft = {
    type: FUSION_CANDIDATE_TYPE,
    title: `Fusion candidates: ${name}`,
    description: [
      `Domains where ${name} may also work:`,
      ...candidates.map((candidate) => `CANDIDATE: ${candidate.targetDomain} | ${candidate.strength} | ${candidate.reason}`),
    ].join("\n"),
    affectedPages: [page],
    options: [
      { label: "Start fusion", action: START_FUSION_ACTION },
      { label: "Skip", action: DISMISS_FUSION_ACTION },
    ],
  }

  const store = useReviewStore.getState()
  const known = store.items.some((existing) => existing.id === reviewIdFor(item))
  store.addItems([item])
  return known ? 0 : 1
}

/** The `title` of the page, else its file stem. One line. */
function mechanismTitle(pageText: string, path: string): string {
  const title = parseFrontmatter(pageText).frontmatter?.title
  const text = typeof title === "string" ? title.replace(/\s+/g, " ").trim() : ""
  return text !== "" ? text : path.slice(path.lastIndexOf("/") + 1).replace(/\.md$/i, "")
}

/** One call to the model. Throws when the stream reports an error. */
async function askModel(llm: LlmConfig, prompt: string, signal: AbortSignal | undefined): Promise<string> {
  const state = { output: "", failure: null as Error | null }
  await streamChat(
    llm,
    [
      { role: "system", content: prompt },
      { role: "user", content: "List the fusion candidates now." },
    ],
    {
      onToken: (token) => {
        state.output += token
      },
      onDone: () => {},
      onError: (error) => {
        state.failure = error
      },
    },
    signal,
    { temperature: 0.1, reasoning: resolveIngestReasoning(llm), max_tokens: MAX_OUTPUT_TOKENS },
  )
  if (state.failure !== null) throw state.failure
  return state.output
}
