/**
 * Source fingerprints: skip a source that repeats one the wiki already ingested.
 *
 * The upstream ingest cache only knows a file by its own name, so the same article that arrives
 * twice (a web clip and a Heptabase snapshot, say) is ingested twice. A mechanism wiki keeps a
 * fingerprint of every source it ingested in `.llm-wiki/source-fingerprints.json`:
 *
 * - The URL, with tracking parameters, fragment, and trailing slash removed, and where it came
 *   from: the frontmatter (`url` or `source`) or the first lines of the body.
 * - A sample of the normalized text: the first 4,000 characters of the lowercased text without
 *   frontmatter, link targets, markup, or punctuation.
 *
 * A new source is a duplicate when
 * - its URL matches and both URLs come from frontmatter (a body URL is often the site logo or home
 *   page, so it is only evidence), or
 * - the Jaccard similarity of the 5-word shingles of the two samples is at least 0.85, or
 * - 90% of the shingles of the shorter sample (at least 1,000 characters) are in the other sample,
 *   which catches a copy that is 30% longer, or
 * - a body URL matches and the text similarity is at least 0.5.
 *
 * A fingerprint only counts while the source summary page it points at still exists; when the user
 * undid that ingest, the fingerprint is dropped and the source can be ingested again. The page of
 * the first copy gets the other entry point in its `also_from` frontmatter list.
 *
 * Every read-modify-write of the file runs under a per-project lock, because ingests can run in
 * parallel when version history is off.
 */
import yaml from "js-yaml"
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
/** Containment at or above this is a copy of a longer or shorter text. */
const CONTAINMENT_THRESHOLD = 0.9
/** Containment only counts when the shorter sample has this many characters: a short quote is not a copy. */
const CONTAINMENT_MIN_CHARS = 1_000
/** A body URL matches only with at least this text similarity. */
const BODY_URL_MIN_SCORE = 0.5
/** Normalized characters kept as the text sample of a fingerprint. */
const SAMPLE_CHARS = 4_000
/** Lines at the top of a source that are searched for a URL when the frontmatter has none. */
const URL_SCAN_LINES = 20
/** A newer copy is worth a review when it has at least 6/5 of the characters of the older one. */
const LONGER_NUMERATOR = 6
const LONGER_DENOMINATOR = 5

export type UrlSource = "frontmatter" | "body"

export interface Fingerprint {
  /** Project-relative path of the raw source. */
  sourcePath: string
  /** Normalized URL, or null when the source names none. */
  url: string | null
  /** Where the URL came from. A body URL needs text evidence to count. Null when there is no URL. */
  urlSource: UrlSource | null
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
  /** 1 for a frontmatter URL match. Otherwise the text similarity: the larger of Jaccard and containment. */
  score: number
}

type NewReview = Omit<ReviewItem, "id" | "resolved" | "createdAt">

/** What `checkDuplicateSource` found when it skips a source. */
export interface DuplicateSkip {
  /** The source summary page of the first copy. Ingest returns it as the written file. */
  summaryPath: string
  hit: DuplicateHit
  /**
   * The source the summary page was written for. `hit.existing` can be a copy that was skipped
   * earlier and recorded against that page.
   */
  original: Fingerprint
  /** Set when the new copy has at least 20% more text than the original. */
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

/**
 * The frontmatter `url` or `source`, else the first http(s) URL in the first 20 lines. Normalized,
 * with where it was found.
 */
function extractUrl(
  content: string,
  frontmatter: ParsedSource["frontmatter"],
): { url: string; urlSource: UrlSource } | null {
  for (const key of ["url", "source"]) {
    const value = frontmatter?.[key]
    if (typeof value === "string" && HTTP_URL_START.test(value.trim())) {
      return { url: normalizeUrl(value), urlSource: "frontmatter" }
    }
  }
  const head = content.split(/\r?\n/, URL_SCAN_LINES).join("\n")
  const found = head.match(URL_IN_TEXT)?.[0]
  if (!found) return null
  return { url: normalizeUrl(found.replace(/[.,;:!?]+$/, "")), urlSource: "body" }
}

// ── Text ──────────────────────────────────────────────────────────────

const MARKDOWN_LINK = /!?\[([^\]]*)\]\([^)]*\)/g
const BARE_URL = /https?:\/\/\S+/g
const HTML_TAG = /<\/?[a-z][^>\n]*>/g
const NOT_TEXT = /[^\p{L}\p{N}\p{M}\s]+/gu
/** Han and kana: written without spaces, so every character counts as a word. */
const SPACELESS_SCRIPT = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/gu

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

type ParsedSource = ReturnType<typeof parseFrontmatter>

/** The text after the frontmatter. A source without frontmatter is all body. */
function bodyOf(raw: string, parsed: ParsedSource): string {
  return parsed.frontmatter === null ? raw : parsed.body
}

/** The text of a source without its frontmatter, normalized. Normalizing normalized text changes nothing. */
function normalizeText(raw: string): string {
  return normalizeBody(bodyOf(raw, parseFrontmatter(raw)))
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

/** A normalized text sample and its shingles. */
interface Sample {
  text: string
  shingles: Set<string>
}

function sampleOf(text: string): Sample {
  return { text, shingles: shinglesOf(wordsOf(text)) }
}

function countShared(a: Set<string>, b: Set<string>): number {
  const [small, large] = a.size <= b.size ? [a, b] : [b, a]
  let shared = 0
  for (const shingle of small) if (large.has(shingle)) shared++
  return shared
}

/**
 * Jaccard index of two samples, and containment: the share of the shingles of the shorter sample that
 * the other has. Containment is 0 when the shorter sample is under 1,000 characters. Empty text scores 0.
 */
function compareSamples(a: Sample, b: Sample): { jaccard: number; containment: number } {
  if (a.shingles.size === 0 || b.shingles.size === 0) return { jaccard: 0, containment: 0 }
  const shared = countShared(a.shingles, b.shingles)
  const shorter = a.text.length <= b.text.length ? a : b
  return {
    jaccard: shared / (a.shingles.size + b.shingles.size - shared),
    containment: shorter.text.length >= CONTAINMENT_MIN_CHARS ? shared / shorter.shingles.size : 0,
  }
}

/** Jaccard similarity (0..1) of the 5-word shingles of the two normalized texts. Empty text scores 0. */
export function shingleSimilarity(a: string, b: string): number {
  return compareSamples(sampleOf(normalizeText(a)), sampleOf(normalizeText(b))).jaccard
}

/** The share (0..1) of the 5-word shingles of `shorter` that `longer` has. Empty text scores 0. */
export function shingleContainment(shorter: string, longer: string): number {
  const small = shinglesOf(wordsOf(normalizeText(shorter)))
  if (small.size === 0) return 0
  return countShared(small, shinglesOf(wordsOf(normalizeText(longer)))) / small.size
}

interface Described {
  url: string | null
  urlSource: UrlSource | null
  textSample: string
  length: number
}

function describeSource(content: string): Described {
  const parsed = parseFrontmatter(content)
  const normalized = normalizeBody(bodyOf(content, parsed))
  // Do not cut a surrogate pair in half.
  const textSample = normalized.slice(0, SAMPLE_CHARS).replace(/[\ud800-\udbff]$/, "")
  const found = extractUrl(content, parsed.frontmatter)
  return {
    url: found?.url ?? null,
    urlSource: found?.urlSource ?? null,
    textSample,
    length: normalized.length,
  }
}

// ── Paths ─────────────────────────────────────────────────────────────

function projectRoot(projectPath: string): string {
  return normalizePath(projectPath).replace(/\/+$/, "")
}

/** The path under the project when there is one (`raw/sources/a.md`), else the normalized path. */
function relativeSourcePath(pp: string, sourcePath: string): string {
  const sp = normalizePath(sourcePath).replace(/^(?:\.\/)+/, "")
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

/** Paths that were already reported as unusable, so each is reported once. */
const reported = new Set<string>()

function warnOnce(key: string, message: string, detail?: unknown): void {
  if (reported.has(key)) return
  reported.add(key)
  console.warn(message, detail instanceof Error ? detail.message : (detail ?? ""))
}

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

/**
 * The fingerprints on file. A missing file, a file that is not valid JSON or has no list, and entries
 * of the wrong shape count as empty. A file that cannot be read (an I/O error) throws: counting it as
 * empty would let the next write replace fingerprints that are still there.
 */
async function readFingerprints(pp: string): Promise<Fingerprint[]> {
  const path = `${pp}/${FINGERPRINT_FILE}`
  if (!(await fileExists(path))) return []
  const raw = await readFile(path)

  let list: unknown[]
  try {
    const parsed: unknown = JSON.parse(raw)
    const found = (parsed as { fingerprints?: unknown } | null)?.fingerprints
    if (!Array.isArray(found)) throw new Error("the file has no fingerprints list")
    list = found
  } catch (err) {
    warnOnce(path, `[source-fingerprint] ${FINGERPRINT_FILE} is not valid, so it counts as empty:`, err)
    return []
  }
  reported.delete(path)
  return list.filter(isFingerprint).map((entry) => {
    const url = typeof entry.url === "string" ? entry.url : null
    return {
      sourcePath: entry.sourcePath,
      url,
      // Entries from before the field existed count as body URLs: the weaker evidence.
      urlSource: url === null ? null : entry.urlSource === "frontmatter" ? "frontmatter" : "body",
      textSample: entry.textSample,
      length: entry.length,
      summaryPath: isSummaryPath(entry.summaryPath) ? entry.summaryPath : null,
    }
  })
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

interface Lookup {
  hit: DuplicateHit
  /** The fingerprint of the source the hit's summary page was written for. */
  original: Fingerprint
}

async function lookUp(pp: string, relativePath: string, candidate: Described): Promise<Lookup | null> {
  const ownSummary = summaryPathForSource(pp, relativePath)
  return withFingerprintLock(pp, async () => {
    const fingerprints = await readFingerprints(pp)
    // Text samples are normalized already, so their shingles need no further cleaning.
    const candidateSample = sampleOf(candidate.textSample)
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
      // A URL from the body is often a site logo or home page: it is only evidence. A frontmatter URL
      // on both sides names the page.
      const urlNamesPage = urlMatch && candidate.urlSource === "frontmatter" && existing.urlSource === "frontmatter"

      let hit: DuplicateHit | null = null
      if (urlNamesPage) {
        hit = { existing, reason: "url", score: 1 }
      } else {
        const { jaccard, containment } = compareSamples(candidateSample, sampleOf(existing.textSample))
        const score = Math.max(jaccard, containment)
        if (jaccard >= SIMILARITY_THRESHOLD || containment >= CONTAINMENT_THRESHOLD) {
          hit = { existing, reason: "text", score }
        } else if (urlMatch && score >= BODY_URL_MIN_SCORE) {
          hit = { existing, reason: "url", score }
        }
      }
      if (hit === null) continue

      let exists = summaryExists.get(summaryPath)
      if (exists === undefined) {
        exists = fileExists(`${pp}/${summaryPath}`)
        summaryExists.set(summaryPath, exists)
      }
      if (!(await exists)) {
        stale.add(existing)
        continue
      }
      if (urlNamesPage) urlHit = hit
      else if (textHit === null || hit.score > textHit.score) textHit = hit
    }

    if (stale.size > 0) {
      try {
        await writeFingerprints(pp, fingerprints.filter((fingerprint) => !stale.has(fingerprint)))
      } catch (err) {
        console.warn("[source-fingerprint] could not drop stale fingerprints:", err instanceof Error ? err.message : err)
      }
    }

    const hit = urlHit ?? textHit
    if (hit === null) return null
    // A copy that was skipped earlier is recorded against the page of the source it copied.
    const summaryPath = summaryPathOf(pp, hit.existing)
    const original =
      [hit.existing, ...fingerprints].find((fingerprint) => summaryPathForSource(pp, fingerprint.sourcePath) === summaryPath) ??
      hit.existing
    return { hit, original }
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
 * A frontmatter URL match wins over a text match. Throws when the file cannot be read.
 */
export async function findDuplicateSource(
  projectPath: string,
  sourcePath: string,
  sourceContent: string,
): Promise<DuplicateHit | null> {
  const pp = projectRoot(projectPath)
  return (await lookUp(pp, relativeSourcePath(pp, sourcePath), describeSource(sourceContent)))?.hit ?? null
}

/**
 * Remember a source that was ingested. `summaryPath` is the `wiki/sources/` page written for it. A
 * source that was already recorded under the same path is replaced. Throws when the file cannot be
 * read or written; ingest catches that, because a missing fingerprint must never fail an ingest.
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
    const found = await lookUp(pp, relativePath, candidate)
    if (found === null) return null

    const { hit, original } = found
    const summaryPath = summaryPathOf(pp, hit.existing)
    try {
      await store(pp, { sourcePath: relativePath, ...candidate, summaryPath })
    } catch (err) {
      console.warn("[source-fingerprint] could not record a duplicate source:", err instanceof Error ? err.message : err)
    }
    return {
      summaryPath,
      hit,
      original,
      review: duplicateReview(pp, normalizePath(sourcePath), relativePath, hit, original, summaryPath, candidate.length),
    }
  } catch (err) {
    console.warn("[source-fingerprint] duplicate check failed:", err instanceof Error ? err.message : err)
    return null
  }
}

/**
 * Review item for a copy with at least 20% more text than the original. Its description ends with
 * the two raw source paths on lines of their own, which `mech:replace-source` reads.
 */
function duplicateReview(
  pp: string,
  sourcePath: string,
  relativePath: string,
  hit: DuplicateHit,
  original: Fingerprint,
  summaryPath: string,
  newLength: number,
): NewReview | null {
  if (newLength <= original.length || newLength * LONGER_DENOMINATOR < original.length * LONGER_NUMERATOR) return null

  const newName = sourceIdentityForPath(pp, relativePath)
  const oldName = sourceIdentityForPath(pp, original.sourcePath)
  const similar = `${Math.round(hit.score * 100)}% similar text`
  const matched = hit.reason === "text" ? similar : hit.score === 1 ? "the same URL" : `the same URL and ${similar}`
  const more = original.length > 0 ? `${Math.round((newLength / original.length - 1) * 100)}% more text` : "more text"
  return {
    type: "duplicate-source",
    title: `Duplicate source: ${newName}`,
    description: [
      `${newName} repeats ${oldName} (${matched}) and has ${more}, so it was not ingested again. Use the newer text to replace the older source and ingest it again.`,
      `EXISTING: ${original.sourcePath}`,
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

// ── Other entry points on the summary page ────────────────────────────

const ALSO_FROM = "also_from"
const ALSO_FROM_KEY = /^also_from[ \t]*:(.*)$/
const ALSO_FROM_INLINE = /^(also_from[ \t]*:[ \t]*\[)(.*?)(\][ \t]*(?:#.*)?)$/
const BLOCK_ITEM = /^(\s*)-(?:\s+(.*))?$/
const PLAIN_YAML_PATH = /^[\p{L}\p{N}_][\p{L}\p{N}_./-]*$/u

type AlsoFromEdit = { ok: true; content: string; changed: boolean } | { ok: false; reason: string }

/** A value as YAML text: plain when that is safe, else double-quoted. */
function yamlText(value: string): string {
  return PLAIN_YAML_PATH.test(value) ? value : JSON.stringify(value)
}

function yamlValue(text: string): string {
  try {
    const value = yaml.load(text, { schema: yaml.JSON_SCHEMA })
    return value === null || value === undefined ? "" : String(value)
  } catch {
    return text.trim()
  }
}

/**
 * Add `entry` to the `also_from` list in the frontmatter of a page, one line at a time, so every other
 * byte stays. A missing key is added at the end of the frontmatter. A block list gets an item after
 * its last item; an inline list gets the entry before its closing bracket. A page without frontmatter,
 * or with an `also_from` that is not a list, is left alone.
 */
function addAlsoFrom(content: string, entry: string): AlsoFromEdit {
  const lines = content.split("\n") // a CRLF page keeps its "\r" on every line
  const crlf = lines[0].endsWith("\r")
  const eol = crlf ? "\r" : ""
  const text = (index: number): string => lines[index].replace(/\r$/, "")

  if (text(0).trimEnd() !== "---") return { ok: false, reason: "the page has no frontmatter" }
  let close = -1
  for (let i = 1; i < lines.length; i++) {
    if (text(i).trimEnd() === "---") {
      close = i
      break
    }
  }
  if (close === -1) return { ok: false, reason: "the frontmatter has no closing line" }

  const item = (indent: string): string => `${indent}- ${yamlText(entry)}${eol}`
  const keyAt = Array.from({ length: close - 1 }, (_, i) => i + 1).find((i) => ALSO_FROM_KEY.test(text(i)))
  if (keyAt === undefined) {
    lines.splice(close, 0, `${ALSO_FROM}:${eol}`, item("  "))
    return { ok: true, content: lines.join("\n"), changed: true }
  }

  const value = (ALSO_FROM_KEY.exec(text(keyAt))?.[1] ?? "").replace(/\s+#.*$/, "").trim()
  if (value === "") {
    let last = keyAt
    let indent = "  "
    const present: string[] = []
    for (let i = keyAt + 1; i < close; i++) {
      const match = BLOCK_ITEM.exec(text(i))
      if (!match) break
      last = i
      indent = match[1]
      present.push(yamlValue(match[2] ?? ""))
    }
    if (present.includes(entry)) return { ok: true, content, changed: false }
    lines.splice(last + 1, 0, item(indent))
    return { ok: true, content: lines.join("\n"), changed: true }
  }

  const inline = ALSO_FROM_INLINE.exec(text(keyAt))
  if (inline) {
    let present: unknown
    try {
      present = yaml.load(`[${inline[2]}]`, { schema: yaml.JSON_SCHEMA })
    } catch {
      return { ok: false, reason: "also_from is not a list this code can read" }
    }
    if (!Array.isArray(present)) return { ok: false, reason: "also_from is not a list this code can read" }
    if (present.map(String).includes(entry)) return { ok: true, content, changed: false }
    const inner = inline[2].trimEnd()
    lines[keyAt] = `${inline[1]}${inner === "" ? "" : `${inner}, `}${yamlText(entry)}${inline[3]}${eol}`
    return { ok: true, content: lines.join("\n"), changed: true }
  }
  return { ok: false, reason: "also_from is not a list" }
}

/**
 * Record on the first copy's summary page that `sourcePath` was skipped as a copy of it: add the
 * project-relative path to the `also_from` frontmatter list. True when the page changed. A page that
 * cannot take the entry is left as it is and reported once; this never throws. Call it where the
 * ingest commits its writes, because it changes a wiki page.
 */
export async function noteOtherEntryPoint(projectPath: string, summaryPath: string, sourcePath: string): Promise<boolean> {
  const pp = projectRoot(projectPath)
  const page = `${pp}/${summaryPath}`
  try {
    const edit = addAlsoFrom(await readFile(page), relativeSourcePath(pp, sourcePath))
    if (!edit.ok) {
      warnOnce(`${page}#${ALSO_FROM}`, `[source-fingerprint] ${summaryPath} cannot list another entry point:`, edit.reason)
      return false
    }
    if (!edit.changed) return false
    await writeFile(page, edit.content)
    return true
  } catch (err) {
    console.warn(`[source-fingerprint] could not list another entry point on ${summaryPath}:`, err instanceof Error ? err.message : err)
    return false
  }
}
