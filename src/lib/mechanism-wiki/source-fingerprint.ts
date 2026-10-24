/**
 * Source fingerprints: skip a source that repeats one the wiki already ingested.
 *
 * The upstream ingest cache only knows a file by its own name, so the same article that arrives
 * twice (a web clip and a Heptabase snapshot, say) is ingested twice. A mechanism wiki keeps a
 * fingerprint of every source it ingested in `.llm-wiki/source-fingerprints.json`:
 *
 * - The URL, with tracking parameters, fragment, and trailing slash removed.
 * - A sample of the normalized text: the first 4,000 characters of the lowercased text without
 *   frontmatter, link targets, markup, or punctuation.
 *
 * A new source is a duplicate when its normalized URL matches or the Jaccard similarity of the
 * 5-word shingles of the two samples is at least 0.85. A fingerprint only counts while the source
 * summary page it points at still exists; when the user undid that ingest, the fingerprint is
 * dropped and the source can be ingested again.
 *
 * Every read-modify-write of the file runs under a per-project lock, because ingests can run in
 * parallel when version history is off.
 */
import { createDirectory, fileExists, readFile, writeFile } from "@/commands/fs"
import { parseFrontmatter } from "@/lib/frontmatter"
import { normalizePath } from "@/lib/path-utils"
import { withProjectLock } from "@/lib/project-mutex"
import { sourceIdentityForPath, sourceSummarySlugFromIdentity } from "@/lib/source-identity"
import type { ReviewItem } from "@/stores/review-store"

const FINGERPRINT_FILE = ".llm-wiki/source-fingerprints.json"
const FILE_VERSION = 1
/** Words per shingle. */
const SHINGLE_SIZE = 5
/** Shingle similarity at or above this is the same text. */
const SIMILARITY_THRESHOLD = 0.85
/** Normalized characters kept as the text sample of a fingerprint. */
const SAMPLE_CHARS = 4_000
/** Lines at the top of a source that are searched for a URL when the frontmatter has none. */
const URL_SCAN_LINES = 20
/** A newer copy is worth a review when it has at least 6/5 of the characters of the older one. */
const LONGER_NUMERATOR = 6
const LONGER_DENOMINATOR = 5

export interface Fingerprint {
  /** Project-relative path of the raw source. */
  sourcePath: string
  /** Normalized URL, or null when the source names none. */
  url: string | null
  /** The first 4,000 normalized characters. */
  textSample: string
  /** Length of the whole normalized text. */
  length: number
  /**
   * The source summary page (`wiki/sources/<slug>.md`) that stands for this source. For a copy that
   * was skipped as a duplicate, the page of the first copy. Null when none was recorded: the page
   * of `sourcePath` itself is meant.
   */
  summaryPath: string | null
}

export interface DuplicateHit {
  existing: Fingerprint
  reason: "url" | "text"
  /** 1 for a URL match. The shingle similarity for a text match. */
  score: number
}

type NewReview = Omit<ReviewItem, "id" | "resolved" | "createdAt">

/** What `checkDuplicateSource` found when it skips a source. */
export interface DuplicateSkip {
  /** The source summary page of the first copy. Ingest returns it as the written file. */
  summaryPath: string
  hit: DuplicateHit
  /** Set when the new copy has at least 20% more text than the first one. */
  review: NewReview | null
}

// ── URLs ──────────────────────────────────────────────────────────────

/**
 * Lowercase the host, drop `utm_*`, `fbclid`, `gclid`, the fragment, and trailing slashes. The path
 * keeps its case. Text that is not an http(s) URL comes back trimmed.
 */
export function normalizeUrl(url: string): string {
  const trimmed = url.trim()
  let parsed: URL
  try {
    parsed = new URL(trimmed)
  } catch {
    return trimmed
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return trimmed

  const path = parsed.pathname.replace(/\/+$/, "")
  const query = parsed.search
    .slice(1)
    .split("&")
    .filter((part) => part !== "" && !isTrackingParam(part))
    .join("&")
  return `${parsed.protocol}//${parsed.host}${path}${query === "" ? "" : `?${query}`}`
}

function isTrackingParam(part: string): boolean {
  const key = part.split("=")[0].toLowerCase()
  return key.startsWith("utm_") || key === "fbclid" || key === "gclid"
}

const HTTP_URL_START = /^https?:\/\//i
const URL_IN_TEXT = /https?:\/\/[^\s<>"'`)\]]+/i

/** The frontmatter `url` or `source`, else the first http(s) URL in the first 20 lines. Normalized. */
function extractUrl(content: string, frontmatter: ReturnType<typeof parseFrontmatter>["frontmatter"]): string | null {
  for (const key of ["url", "source"]) {
    const value = frontmatter?.[key]
    if (typeof value === "string" && HTTP_URL_START.test(value.trim())) return normalizeUrl(value)
  }
  const head = content.split(/\r?\n/, URL_SCAN_LINES).join("\n")
  const found = head.match(URL_IN_TEXT)?.[0]
  if (!found) return null
  return normalizeUrl(found.replace(/[.,;:!?]+$/, ""))
}

// ── Text ──────────────────────────────────────────────────────────────

const MARKDOWN_LINK = /!?\[([^\]]*)\]\([^)]*\)/g
const BARE_URL = /https?:\/\/\S+/g
const HTML_TAG = /<\/?[a-z][^>\n]*>/g
const NOT_TEXT = /[^\p{L}\p{N}\p{M}\s]+/gu
/** Han and kana: written without spaces, so every character counts as a word. */
const SPACELESS_SCRIPT = /[぀-ヿ㐀-䶿一-鿿豈-﫿]/gu

/** Lowercase, keep link text but not link targets, drop markup and punctuation, collapse whitespace. */
function normalizeBody(body: string): string {
  return body
    .toLowerCase()
    .replace(MARKDOWN_LINK, "$1")
    .replace(BARE_URL, " ")
    .replace(HTML_TAG, " ")
    .replace(NOT_TEXT, " ")
    .replace(/\s+/g, " ")
    .trim()
}

/** The text of a source without its frontmatter, normalized. Normalizing normalized text changes nothing. */
function normalizeText(raw: string): string {
  const parsed = parseFrontmatter(raw)
  return normalizeBody(parsed.frontmatter === null ? raw : parsed.body)
}

function wordsOf(normalized: string): string[] {
  return normalized.replace(SPACELESS_SCRIPT, " $& ").split(/\s+/).filter(Boolean)
}

/** Every run of 5 words. Text shorter than 5 words is one shingle, so identical short texts match. */
function shinglesOf(words: string[]): Set<string> {
  const shingles = new Set<string>()
  if (words.length === 0) return shingles
  if (words.length < SHINGLE_SIZE) return shingles.add(words.join(" "))
  for (let i = 0; i + SHINGLE_SIZE <= words.length; i++) {
    shingles.add(words.slice(i, i + SHINGLE_SIZE).join(" "))
  }
  return shingles
}

/** Jaccard index of two shingle sets. Empty sets score 0. */
function jaccard(left: Set<string>, right: Set<string>): number {
  if (left.size === 0 || right.size === 0) return 0
  const [small, large] = left.size <= right.size ? [left, right] : [right, left]
  let shared = 0
  for (const shingle of small) if (large.has(shingle)) shared++
  return shared / (left.size + right.size - shared)
}

/** Jaccard similarity (0..1) of the 5-word shingles of the two normalized texts. Empty text scores 0. */
export function shingleSimilarity(a: string, b: string): number {
  return jaccard(shinglesOf(wordsOf(normalizeText(a))), shinglesOf(wordsOf(normalizeText(b))))
}

interface Described {
  url: string | null
  textSample: string
  length: number
}

function describeSource(content: string): Described {
  const parsed = parseFrontmatter(content)
  const normalized = normalizeBody(parsed.frontmatter === null ? content : parsed.body)
  // Do not cut a surrogate pair in half.
  const textSample = normalized.slice(0, SAMPLE_CHARS).replace(/[\ud800-\udbff]$/, "")
  return { url: extractUrl(content, parsed.frontmatter), textSample, length: normalized.length }
}

// ── Paths ─────────────────────────────────────────────────────────────

function projectRoot(projectPath: string): string {
  return normalizePath(projectPath).replace(/\/+$/, "")
}

/** The path under the project when there is one (`raw/sources/a.md`), else the normalized path. */
function relativeSourcePath(pp: string, sourcePath: string): string {
  const sp = normalizePath(sourcePath)
  const prefix = `${pp}/`
  return sp.toLowerCase().startsWith(prefix.toLowerCase()) ? sp.slice(prefix.length) : sp
}

/** The source summary page ingest writes for a source: `wiki/sources/<slug>.md`. */
export function summaryPathForSource(projectPath: string, sourcePath: string): string {
  const identity = sourceIdentityForPath(projectRoot(projectPath), sourcePath)
  return `wiki/sources/${sourceSummarySlugFromIdentity(identity)}.md`
}

/** The summary page a fingerprint stands for: the recorded one, else the page of its own source. */
function summaryPathOf(pp: string, fingerprint: Fingerprint): string {
  return fingerprint.summaryPath ?? summaryPathForSource(pp, fingerprint.sourcePath)
}

// ── The fingerprint file ──────────────────────────────────────────────

/** Paths of unreadable fingerprint files that were already reported, so a bad file warns once. */
const reported = new Set<string>()

function isFingerprint(value: unknown): value is Record<string, unknown> & Pick<Fingerprint, "sourcePath" | "textSample" | "length"> {
  if (typeof value !== "object" || value === null) return false
  const entry = value as Record<string, unknown>
  return (
    typeof entry.sourcePath === "string" &&
    typeof entry.textSample === "string" &&
    typeof entry.length === "number" &&
    Number.isFinite(entry.length)
  )
}

/** Ingest returns a recorded summary page as a written file, so only a `wiki/sources/` page is believed. */
function isSummaryPath(value: unknown): value is string {
  return typeof value === "string" && value.startsWith("wiki/sources/") && !value.includes("..")
}

/** A missing file, an unreadable or corrupt file, or entries of the wrong shape count as empty. */
async function readFingerprints(pp: string): Promise<Fingerprint[]> {
  const path = `${pp}/${FINGERPRINT_FILE}`
  try {
    if (!(await fileExists(path))) return []
    const parsed: unknown = JSON.parse(await readFile(path))
    const list = (parsed as { fingerprints?: unknown } | null)?.fingerprints
    if (!Array.isArray(list)) throw new Error("the file has no fingerprints list")
    reported.delete(path)
    return list.filter(isFingerprint).map((entry) => ({
      sourcePath: entry.sourcePath,
      url: typeof entry.url === "string" ? entry.url : null,
      textSample: entry.textSample,
      length: entry.length,
      summaryPath: isSummaryPath(entry.summaryPath) ? entry.summaryPath : null,
    }))
  } catch (err) {
    if (!reported.has(path)) {
      reported.add(path)
      console.warn(
        `[source-fingerprint] ${FINGERPRINT_FILE} cannot be read, so it counts as empty:`,
        err instanceof Error ? err.message : err,
      )
    }
    return []
  }
}

async function writeFingerprints(pp: string, fingerprints: Fingerprint[]): Promise<void> {
  await createDirectory(`${pp}/.llm-wiki`)
  await writeFile(`${pp}/${FINGERPRINT_FILE}`, JSON.stringify({ version: FILE_VERSION, fingerprints }, null, 2))
  reported.delete(`${pp}/${FINGERPRINT_FILE}`)
}

/** Runs `operation` after every earlier read-modify-write of this project's fingerprint file. */
function withFingerprintLock<T>(pp: string, operation: () => Promise<T>): Promise<T> {
  return withProjectLock(`${pp}\0source-fingerprints`, operation)
}

// ── Lookup and recording ──────────────────────────────────────────────

async function lookUp(pp: string, relativePath: string, candidate: Described): Promise<DuplicateHit | null> {
  const ownSummary = summaryPathForSource(pp, relativePath)
  return withFingerprintLock(pp, async () => {
    const fingerprints = await readFingerprints(pp)
    // Text samples are normalized already, so their shingles need no further cleaning.
    const candidateShingles = shinglesOf(wordsOf(candidate.textSample))
    const stale = new Set<Fingerprint>()
    const summaryExists = new Map<string, Promise<boolean>>()
    let urlHit: DuplicateHit | null = null
    let textHit: DuplicateHit | null = null

    for (const existing of fingerprints) {
      if (urlHit !== null) break // a URL match decides; nothing beats it
      // The same file edited and ingested again is not a copy of itself, and neither is a copy that
      // was skipped in favor of this source's own summary page.
      if (existing.sourcePath === relativePath) continue
      const summaryPath = summaryPathOf(pp, existing)
      if (summaryPath === ownSummary) continue

      const urlMatch = candidate.url !== null && existing.url !== null && normalizeUrl(existing.url) === candidate.url
      const score = urlMatch ? 1 : jaccard(candidateShingles, shinglesOf(wordsOf(existing.textSample)))
      if (!urlMatch && score < SIMILARITY_THRESHOLD) continue

      let exists = summaryExists.get(summaryPath)
      if (exists === undefined) {
        exists = fileExists(`${pp}/${summaryPath}`)
        summaryExists.set(summaryPath, exists)
      }
      if (!(await exists)) {
        stale.add(existing)
        continue
      }
      if (urlMatch) urlHit = { existing, reason: "url", score: 1 }
      else if (textHit === null || score > textHit.score) textHit = { existing, reason: "text", score }
    }

    if (stale.size > 0) {
      try {
        await writeFingerprints(pp, fingerprints.filter((fingerprint) => !stale.has(fingerprint)))
      } catch (err) {
        console.warn("[source-fingerprint] could not drop stale fingerprints:", err instanceof Error ? err.message : err)
      }
    }
    return urlHit ?? textHit
  })
}

async function store(pp: string, fingerprint: Fingerprint): Promise<void> {
  await withFingerprintLock(pp, async () => {
    const fingerprints = await readFingerprints(pp)
    const at = fingerprints.findIndex((existing) => existing.sourcePath === fingerprint.sourcePath)
    if (at === -1) fingerprints.push(fingerprint)
    else fingerprints[at] = fingerprint
    await writeFingerprints(pp, fingerprints)
  })
}

/**
 * The fingerprint that `sourceContent` is a copy of, or null. A fingerprint of the same
 * `sourcePath` is not a copy, and one whose summary page is gone is dropped from the file.
 * A URL match wins over a text match.
 */
export async function findDuplicateSource(
  projectPath: string,
  sourcePath: string,
  sourceContent: string,
): Promise<DuplicateHit | null> {
  const pp = projectRoot(projectPath)
  return lookUp(pp, relativeSourcePath(pp, sourcePath), describeSource(sourceContent))
}

/**
 * Remember a source that was ingested. `summaryPath` is the `wiki/sources/` page written for it. A
 * source that was already recorded under the same path is replaced. Throws when the file cannot be
 * written; ingest catches that, because a missing fingerprint must never fail an ingest.
 */
export async function recordFingerprint(
  projectPath: string,
  sourcePath: string,
  sourceContent: string,
  summaryPath: string | null = null,
): Promise<void> {
  const pp = projectRoot(projectPath)
  await store(pp, {
    sourcePath: relativeSourcePath(pp, sourcePath),
    ...describeSource(sourceContent),
    summaryPath: summaryPath === null ? null : normalizePath(summaryPath),
  })
}

// ── Ingest hook ───────────────────────────────────────────────────────

/**
 * Ingest calls this before analysis, in a mechanism wiki only. When `sourceContent` repeats a source
 * that was ingested already, the new path is recorded against the same summary page (so later copies
 * match too) and the result says which page to return. Never throws: a failure here lets the ingest
 * go on as if the source were new.
 */
export async function checkDuplicateSource(
  projectPath: string,
  sourcePath: string,
  sourceContent: string,
): Promise<DuplicateSkip | null> {
  try {
    const pp = projectRoot(projectPath)
    const relativePath = relativeSourcePath(pp, sourcePath)
    const candidate = describeSource(sourceContent)
    const hit = await lookUp(pp, relativePath, candidate)
    if (hit === null) return null

    const summaryPath = summaryPathOf(pp, hit.existing)
    try {
      await store(pp, { sourcePath: relativePath, ...candidate, summaryPath })
    } catch (err) {
      console.warn("[source-fingerprint] could not record a duplicate source:", err instanceof Error ? err.message : err)
    }
    return {
      summaryPath,
      hit,
      review: duplicateReview(pp, normalizePath(sourcePath), relativePath, hit, summaryPath, candidate.length),
    }
  } catch (err) {
    console.warn("[source-fingerprint] duplicate check failed:", err instanceof Error ? err.message : err)
    return null
  }
}

/**
 * Review item for a copy with at least 20% more text than the first one. Its description ends with
 * the two raw source paths on lines of their own, which `mech:replace-source` reads.
 */
function duplicateReview(
  pp: string,
  sourcePath: string,
  relativePath: string,
  hit: DuplicateHit,
  summaryPath: string,
  newLength: number,
): NewReview | null {
  const { existing } = hit
  if (newLength <= existing.length || newLength * LONGER_DENOMINATOR < existing.length * LONGER_NUMERATOR) return null

  const newName = sourceIdentityForPath(pp, relativePath)
  const oldName = sourceIdentityForPath(pp, existing.sourcePath)
  const matched = hit.reason === "url" ? "the same URL" : `${Math.round(hit.score * 100)}% similar text`
  const more = existing.length > 0 ? `${Math.round((newLength / existing.length - 1) * 100)}% more text` : "more text"
  return {
    type: "duplicate-source",
    title: `Duplicate source: ${newName}`,
    description: [
      `${newName} repeats ${oldName} (${matched}) and has ${more}, so it was not ingested again. Use the newer text to replace the older source and ingest it again.`,
      `EXISTING: ${existing.sourcePath}`,
      `NEWER: ${relativePath}`,
    ].join("\n"),
    sourcePath,
    affectedPages: [summaryPath],
    options: [
      { label: "Use the newer text", action: "mech:replace-source" },
      { label: "Skip", action: "Skip" },
    ],
  }
}
