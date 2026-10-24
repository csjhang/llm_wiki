/**
 * Source fingerprints: URL normalization, text similarity, duplicate lookup, and the
 * `.llm-wiki/source-fingerprints.json` file. The file tests run on a real temp project.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createTempProject, readFileRaw, realFs, writeFileRaw } from "@/test-helpers/fs-temp"
import { sourceSummarySlugFromIdentity } from "@/lib/source-identity"

vi.mock("@/commands/fs", () => realFs)

import {
  checkDuplicateSource,
  findDuplicateSource,
  noteOtherEntryPoint,
  normalizeUrl,
  recordFingerprint,
  shingleContainment,
  shingleSimilarity,
  summaryPathForSource,
} from "./source-fingerprint"
import type { Fingerprint } from "./source-fingerprint"

const FINGERPRINTS = ".llm-wiki/source-fingerprints.json"

const ARTICLE = [
  "# How asynchronous handshakes work",
  "",
  "A **request** line goes high when the sender has data. The receiver raises an *acknowledge* line",
  "once it has latched the data, and the sender then lowers the request line again. Only after the",
  "acknowledge line falls does the next transfer begin, so no clock is needed to keep both sides in step.",
  "",
  "- Four-phase protocols return both lines to zero between transfers.",
  "- Two-phase protocols toggle each line once per transfer and save the return step.",
  "",
  "The cost of this approach is extra wires and a delay element that must be sized with care.",
].join("\n")

/** The same article as a web clip would store it: other whitespace, links, markup. */
const ARTICLE_CLIPPED = [
  "---",
  "title: Handshakes",
  "url: https://Example.com/Posts/Handshakes/?utm_source=feed&utm_medium=rss#intro",
  "---",
  "",
  "## How asynchronous   handshakes work",
  "",
  "A __request__ line goes high when the sender has [data](https://example.com/data?utm_campaign=x). The receiver raises an",
  "_acknowledge_ line once it has latched the data, and the sender then lowers the request line again.",
  "Only after the acknowledge line falls does the next transfer begin, so no clock is needed",
  "to keep both sides in step.",
  "",
  "* Four-phase protocols return both lines to zero between transfers.",
  "* Two-phase protocols toggle each line once per transfer and save the return step.",
  "",
  "",
  "The cost of this approach is extra wires and a delay element that must be sized with care.",
].join("\n")

const OTHER_TEXT = [
  "Sourdough starters need regular feeding with flour and water. Discard half before each feeding,",
  "keep the jar somewhere warm, and expect bubbles within eight hours. A mature starter doubles in",
  "size and smells pleasantly sour, and a spoonful floats in water once it is ready to bake with.",
].join(" ")

/**
 * A document longer than the 4,000-character sample. A longer copy of a document that fits in the
 * sample has fewer than 0.85 of the shingles in common, so only long documents can be both a text
 * match and 20% longer.
 */
const LONG_BASE = Array.from(
  { length: 100 },
  (_, i) => `Sentence ${i} explains how handshake timing depends on the delay element and the latch.`,
).join(" ")
const LONG_EXTENDED = `${LONG_BASE} ${Array.from({ length: 60 }, (_, i) => `Addendum ${i} covers the wiring cost of every extra request line.`).join(" ")}`

/** 1,900 characters: long enough for containment to count, short enough to fit in the sample. */
const MEDIUM_BASE = Array.from(
  { length: 30 },
  (_, i) => `Step ${i} of the four-phase handshake raises or lowers one wire.`,
).join(" ")
/** The same text with about 35% more at the end. Its Jaccard similarity to the base is under 0.85. */
const MEDIUM_EXTENDED = `${MEDIUM_BASE} ${Array.from(
  { length: 11 },
  (_, i) => `Extra ${i} explains why the delay element needs a safety margin.`,
).join(" ")}`

/** About 40% more text than ARTICLE: a Jaccard similarity between 0.5 and 0.85, and too short for containment. */
const ARTICLE_PLUS = `${ARTICLE}\n\nThe delay element must cover the slowest data path plus the setup time of the latch, and the margin shrinks as the supply voltage drops or the temperature rises.`

describe("normalizeUrl", () => {
  it("strips tracking params and fragments and lowercases the host but keeps path case", () => {
    expect(
      normalizeUrl("https://Example.COM/Posts/Handshakes/?utm_source=feed&UTM_medium=rss&fbclid=abc&gclid=1&id=7#intro"),
    ).toBe("https://example.com/Posts/Handshakes?id=7")
  })

  it("drops a trailing slash and an empty query", () => {
    expect(normalizeUrl("https://example.com/")).toBe("https://example.com")
    expect(normalizeUrl("https://example.com/a/b/?utm_source=x")).toBe("https://example.com/a/b")
    expect(normalizeUrl("https://example.com/a/b/")).toBe(normalizeUrl("https://example.com/a/b"))
  })

  it("keeps other query params and is idempotent", () => {
    const once = normalizeUrl("http://example.com/p?x=1&utm_term=t&y=two%20words")
    expect(once).toBe("http://example.com/p?x=1&y=two%20words")
    expect(normalizeUrl(once)).toBe(once)
  })

  it("returns text that is not a URL trimmed", () => {
    expect(normalizeUrl("  not a url  ")).toBe("not a url")
  })
})

describe("shingleSimilarity", () => {
  it("similar texts score >= 0.85 (same article, different whitespace and markdown)", () => {
    expect(shingleSimilarity(ARTICLE, ARTICLE_CLIPPED)).toBeGreaterThanOrEqual(0.85)
  })

  it("scores identical text 1", () => {
    expect(shingleSimilarity(ARTICLE, ARTICLE)).toBe(1)
  })

  it("different texts score < 0.3", () => {
    expect(shingleSimilarity(ARTICLE, OTHER_TEXT)).toBeLessThan(0.3)
  })

  it("scores empty text 0, and short identical text 1", () => {
    expect(shingleSimilarity("", "")).toBe(0)
    expect(shingleSimilarity(ARTICLE, "")).toBe(0)
    expect(shingleSimilarity("Short note", "short   NOTE!")).toBe(1)
  })

  it("compares text without spaces by characters", () => {
    const a = "非同步握手協定讓兩個沒有共用時脈的電路可以交換資料，發送端先拉高請求線，接收端鎖存資料後再拉高確認線。"
    const b = "非同步握手協定讓兩個沒有共用時脈的電路可以交換資料， 發送端先拉高請求線， 接收端鎖存資料後再拉高確認線。"
    const c = "酸種麵團需要定期餵食麵粉與水，每次餵食前先倒掉一半，放在溫暖的地方，八小時內就會冒出氣泡。"
    expect(shingleSimilarity(a, b)).toBeGreaterThanOrEqual(0.85)
    expect(shingleSimilarity(a, c)).toBeLessThan(0.3)
  })
})

describe("shingleContainment", () => {
  it("is the share of the shorter text's shingles found in the longer text", () => {
    expect(shingleContainment(MEDIUM_BASE, MEDIUM_EXTENDED)).toBe(1)
    expect(shingleContainment(MEDIUM_EXTENDED, MEDIUM_BASE)).toBeLessThan(1)
    expect(shingleContainment(OTHER_TEXT, MEDIUM_EXTENDED)).toBeLessThan(0.1)
  })

  it("scores empty text 0", () => {
    expect(shingleContainment("", MEDIUM_BASE)).toBe(0)
    expect(shingleContainment(MEDIUM_BASE, "")).toBe(0)
  })

  it("is high where Jaccard is low for a text and its longer copy", () => {
    expect(shingleSimilarity(MEDIUM_BASE, MEDIUM_EXTENDED)).toBeLessThan(0.85)
  })
})

describe("source fingerprints on disk", () => {
  let tmp: { path: string; cleanup: () => Promise<void> }
  let project: string

  beforeEach(async () => {
    tmp = await createTempProject("fingerprints")
    project = tmp.path
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    await tmp.cleanup()
  })

  /** Writes the source summary page that a successful ingest of `sourcePath` leaves behind. */
  async function writeSummary(sourcePath: string): Promise<string> {
    const summary = summaryPathForSource(project, sourcePath)
    await writeFileRaw(`${project}/${summary}`, "---\ntype: source\n---\n# Summary\n")
    return summary
  }

  async function stored(): Promise<Fingerprint[]> {
    const parsed = JSON.parse(await readFileRaw(`${project}/${FINGERPRINTS}`)) as { fingerprints: Fingerprint[] }
    return parsed.fingerprints
  }

  it("frontmatter URL alone is a duplicate", async () => {
    const summary = await writeSummary("raw/sources/a.md")
    await recordFingerprint(project, "raw/sources/a.md", `---\nurl: https://example.com/post\n---\n\n${OTHER_TEXT}`)

    const hit = await findDuplicateSource(
      project,
      "raw/sources/b.md",
      `---\nsource: "https://EXAMPLE.com/post/?utm_source=x#top"\n---\n${ARTICLE}`,
    )

    expect(hit?.reason).toBe("url")
    expect(hit?.score).toBe(1)
    expect(hit?.existing.sourcePath).toBe("raw/sources/a.md")
    expect(hit?.existing.url).toBe("https://example.com/post")
    expect(hit?.existing.urlSource).toBe("frontmatter")
    expect(summaryPathForSource(project, hit?.existing.sourcePath ?? "")).toBe(summary)
  })

  it("body URL alone is not a duplicate", async () => {
    await writeSummary("raw/sources/a.md")
    await recordFingerprint(project, "raw/sources/a.md", `Clipped from https://example.com/\n\n${OTHER_TEXT}`)

    expect(await findDuplicateSource(project, "raw/sources/b.md", `Clipped from https://example.com\n\n${ARTICLE}`)).toBeNull()
    // The fingerprint stays: its summary page exists.
    expect(await stored()).toHaveLength(1)
  })

  it("body URL plus similar text is a duplicate", async () => {
    await writeSummary("raw/sources/a.md")
    await recordFingerprint(project, "raw/sources/a.md", `Clipped from https://example.com/post\n\n${ARTICLE}`)

    const hit = await findDuplicateSource(
      project,
      "raw/sources/b.md",
      `Clipped from https://example.com/post?utm_source=x\n\n${ARTICLE_PLUS}`,
    )

    expect(shingleSimilarity(ARTICLE, ARTICLE_PLUS)).toBeLessThan(0.85)
    expect(shingleSimilarity(ARTICLE, ARTICLE_PLUS)).toBeGreaterThanOrEqual(0.5)
    expect(hit?.reason).toBe("url")
    expect(hit?.score).toBeGreaterThanOrEqual(0.5)
    expect(hit?.score).toBeLessThan(0.85)
    expect(hit?.existing.urlSource).toBe("body")
  })

  it("body URL with text under 0.5 similarity is not a duplicate", async () => {
    await writeSummary("raw/sources/a.md")
    await recordFingerprint(project, "raw/sources/a.md", `Clipped from https://example.com/post\n\n${ARTICLE}`)
    const unrelated = `Clipped from https://example.com/post\n\n${OTHER_TEXT}`
    expect(await findDuplicateSource(project, "raw/sources/b.md", unrelated)).toBeNull()
  })

  it("a URL from the body of either copy needs text evidence", async () => {
    await writeSummary("raw/sources/a.md")
    await writeSummary("raw/sources/c.md")
    await recordFingerprint(project, "raw/sources/a.md", `---\nurl: https://example.com/post\n---\n${OTHER_TEXT}`)
    await recordFingerprint(project, "raw/sources/c.md", `See https://example.com/other\n${OTHER_TEXT} and more words follow here`)

    // Frontmatter URL on the stored copy, body URL on the new one.
    expect(await findDuplicateSource(project, "raw/sources/b.md", `Read https://example.com/post\n${ARTICLE}`)).toBeNull()
    // Body URL on the stored copy, frontmatter URL on the new one.
    expect(
      await findDuplicateSource(project, "raw/sources/d.md", `---\nurl: https://example.com/other\n---\n${ARTICLE}`),
    ).toBeNull()
  })

  it("an entry recorded without urlSource counts as a body URL", async () => {
    await writeSummary("raw/sources/a.md")
    await writeFileRaw(
      `${project}/${FINGERPRINTS}`,
      JSON.stringify({
        fingerprints: [
          { sourcePath: "raw/sources/a.md", url: "https://example.com/post", textSample: "unrelated words only here today", length: 31, summaryPath: null },
        ],
      }),
    )

    expect(
      await findDuplicateSource(project, "raw/sources/b.md", `---\nurl: https://example.com/post\n---\n${ARTICLE}`),
    ).toBeNull()
    await recordFingerprint(project, "raw/sources/c.md", ARTICLE)
    expect((await stored())[0].urlSource).toBe("body")
  })

  it("reads the url from the first 20 lines when there is no frontmatter", async () => {
    await writeSummary("raw/sources/a.md")
    await recordFingerprint(project, "raw/sources/a.md", `# Title\n\nOriginal: https://example.com/post.\n\n${OTHER_TEXT}`)
    const fingerprints = await stored()
    expect(fingerprints[0].url).toBe("https://example.com/post")
    expect(fingerprints[0].urlSource).toBe("body")

    const lateText = `${"filler\n".repeat(25)}https://example.com/other\n${OTHER_TEXT}`
    await recordFingerprint(project, "raw/sources/late.md", lateText)
    const late = (await stored()).find((f) => f.sourcePath === "raw/sources/late.md")
    expect(late?.url).toBeNull()
    expect(late?.urlSource).toBeNull()
    await recordFingerprint(project, "raw/sources/fm.md", `---\nurl: https://example.com/fm\n---\n${OTHER_TEXT}`)
    expect((await stored()).find((f) => f.sourcePath === "raw/sources/fm.md")?.urlSource).toBe("frontmatter")
  })

  it("finds a text hit", async () => {
    await writeSummary("raw/sources/a.md")
    await recordFingerprint(project, "raw/sources/a.md", ARTICLE)

    const hit = await findDuplicateSource(project, "raw/sources/heptabase/b.md", ARTICLE_CLIPPED)

    expect(hit?.reason).toBe("text")
    expect(hit?.score).toBeGreaterThanOrEqual(0.85)
    expect(hit?.existing.sourcePath).toBe("raw/sources/a.md")
  })

  it("finds a text hit for a longer copy of the same text by containment", async () => {
    await writeSummary("raw/sources/a.md")
    await recordFingerprint(project, "raw/sources/a.md", MEDIUM_BASE)

    const hit = await findDuplicateSource(project, "raw/sources/b.md", MEDIUM_EXTENDED)

    expect(hit?.reason).toBe("text")
    expect(hit?.score).toBeGreaterThanOrEqual(0.9)
  })

  it("a short note quoted inside a long article is not a duplicate when the note is under 1,000 characters", async () => {
    await writeSummary("raw/sources/a.md")
    await recordFingerprint(project, "raw/sources/a.md", LONG_BASE)
    const note = LONG_BASE.slice(500, 1000)

    expect(note.length).toBeLessThan(1000)
    expect(await findDuplicateSource(project, "raw/sources/note.md", note)).toBeNull()
  })

  it("a quote of 1,000 characters or more taken from a long article is a duplicate", async () => {
    await writeSummary("raw/sources/a.md")
    await recordFingerprint(project, "raw/sources/a.md", LONG_BASE)
    const excerpt = LONG_BASE.slice(500, 2000)

    const hit = await findDuplicateSource(project, "raw/sources/excerpt.md", excerpt)

    expect(hit?.reason).toBe("text")
    expect(hit?.existing.sourcePath).toBe("raw/sources/a.md")
  })

  it("finds no hit for a different text", async () => {
    await writeSummary("raw/sources/a.md")
    await recordFingerprint(project, "raw/sources/a.md", ARTICLE)

    expect(await findDuplicateSource(project, "raw/sources/b.md", OTHER_TEXT)).toBeNull()
  })

  it("same path is not a duplicate", async () => {
    await writeSummary("raw/sources/a.md")
    await recordFingerprint(project, "raw/sources/a.md", ARTICLE)

    expect(await findDuplicateSource(project, "raw/sources/a.md", ARTICLE)).toBeNull()
    expect(await findDuplicateSource(project, `${project}/raw/sources/a.md`, ARTICLE)).toBeNull()
  })

  it("a copy that points at this source's own summary page is not a duplicate", async () => {
    // b.md was skipped as a copy of a.md and recorded with a.md's summary page.
    const summary = await writeSummary("raw/sources/a.md")
    await recordFingerprint(project, "raw/sources/a.md", ARTICLE, summary)
    await recordFingerprint(project, "raw/sources/b.md", ARTICLE, summary)

    // a.md is edited and ingested again: b.md's fingerprint must not stop it.
    expect(await findDuplicateSource(project, "raw/sources/a.md", `${ARTICLE}\n\nA new closing paragraph.`)).toBeNull()
  })

  it("stale fingerprint is dropped and the source is ingested", async () => {
    // a.md was ingested and then undone: its summary page is gone.
    await recordFingerprint(project, "raw/sources/a.md", ARTICLE)
    await writeSummary("raw/sources/live.md")
    await recordFingerprint(project, "raw/sources/live.md", OTHER_TEXT)

    expect(await findDuplicateSource(project, "raw/sources/b.md", ARTICLE)).toBeNull()

    const remaining = await stored()
    expect(remaining.map((f) => f.sourcePath)).toEqual(["raw/sources/live.md"])
  })

  it("uses the recorded summary page, and checks that page for existence", async () => {
    const summary = "wiki/sources/custom-summary.md"
    await recordFingerprint(project, "raw/sources/a.md", ARTICLE, summary)
    // The page at the path computed from the source path does not count.
    await writeSummary("raw/sources/a.md")
    expect(await findDuplicateSource(project, "raw/sources/b.md", ARTICLE)).toBeNull()

    await recordFingerprint(project, "raw/sources/a.md", ARTICLE, summary)
    await writeFileRaw(`${project}/${summary}`, "# Summary\n")
    const hit = await findDuplicateSource(project, "raw/sources/b.md", ARTICLE)
    expect(hit?.existing.summaryPath).toBe(summary)
  })

  it("records a relative source path and the summary page", async () => {
    await recordFingerprint(project, `${project}/raw/sources/a.md`, `url: https://example.com/x\n${ARTICLE}`)
    const [fingerprint] = await stored()
    expect(fingerprint).toMatchObject({
      sourcePath: "raw/sources/a.md",
      url: "https://example.com/x",
      urlSource: "body",
      summaryPath: null,
    })
    expect(fingerprint.length).toBeGreaterThan(100)
    expect(fingerprint.textSample.length).toBeLessThanOrEqual(4000)
    expect(fingerprint.textSample).toContain("asynchronous handshakes")
  })

  it("keeps one fingerprint per source path", async () => {
    await recordFingerprint(project, "raw/sources/a.md", OTHER_TEXT)
    await recordFingerprint(project, "raw/sources/a.md", ARTICLE, "wiki/sources/a.md")
    const fingerprints = await stored()
    expect(fingerprints).toHaveLength(1)
    expect(fingerprints[0].summaryPath).toBe("wiki/sources/a.md")
    expect(fingerprints[0].textSample).toContain("handshakes")
  })

  it("limits the text sample to 4000 characters and measures the whole text", async () => {
    const long = Array.from({ length: 2000 }, (_, i) => `word${i}`).join(" ")
    await recordFingerprint(project, "raw/sources/long.md", long)
    const [fingerprint] = await stored()
    expect(fingerprint.textSample).toHaveLength(4000)
    expect(fingerprint.length).toBe(long.length)
  })

  it("two concurrent recordFingerprint calls keep both entries", async () => {
    await Promise.all([
      recordFingerprint(project, "raw/sources/a.md", ARTICLE),
      recordFingerprint(project, "raw/sources/b.md", OTHER_TEXT),
      recordFingerprint(project, "raw/sources/c.md", `${OTHER_TEXT} and more`),
    ])
    const paths = (await stored()).map((f) => f.sourcePath).sort()
    expect(paths).toEqual(["raw/sources/a.md", "raw/sources/b.md", "raw/sources/c.md"])
  })

  it("treats a missing file as empty without a warning", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    expect(await findDuplicateSource(project, "raw/sources/a.md", ARTICLE)).toBeNull()
    expect(warn).not.toHaveBeenCalled()
  })

  it("treats a corrupt file as empty, warns once, and a record replaces it", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    await writeFileRaw(`${project}/${FINGERPRINTS}`, "{ not json")

    expect(await findDuplicateSource(project, "raw/sources/a.md", ARTICLE)).toBeNull()
    expect(await findDuplicateSource(project, "raw/sources/a.md", ARTICLE)).toBeNull()
    expect(warn).toHaveBeenCalledTimes(1)

    await recordFingerprint(project, "raw/sources/a.md", ARTICLE)
    expect((await stored()).map((f) => f.sourcePath)).toEqual(["raw/sources/a.md"])
  })

  it("does not believe a recorded summary page outside wiki/sources", async () => {
    const summary = await writeSummary("raw/sources/a.md")
    await writeFileRaw(
      `${project}/${FINGERPRINTS}`,
      JSON.stringify({
        fingerprints: [
          { sourcePath: "raw/sources/a.md", url: null, textSample: "x", length: 1, summaryPath: "raw/sources/a.md" },
        ],
      }),
    )
    await recordFingerprint(project, "raw/sources/b.md", ARTICLE, summary)
    const [first] = await stored()
    expect(first.summaryPath).toBeNull()
  })

  it("a read error does not overwrite the fingerprint file", async () => {
    await writeSummary("raw/sources/a.md")
    await recordFingerprint(project, "raw/sources/a.md", ARTICLE)
    const file = `${project}/${FINGERPRINTS}`
    const before = await readFileRaw(file)
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const read = realFs.readFile.bind(realFs)
    vi.spyOn(realFs, "readFile").mockImplementation(async (path: string) => {
      if (path === file) throw new Error("EIO: input/output error")
      return read(path)
    })

    await expect(recordFingerprint(project, "raw/sources/b.md", OTHER_TEXT)).rejects.toThrow("EIO")
    await expect(findDuplicateSource(project, "raw/sources/c.md", ARTICLE)).rejects.toThrow("EIO")
    expect(await checkDuplicateSource(project, `${project}/raw/sources/d.md`, ARTICLE)).toBeNull()
    expect(warn).toHaveBeenCalled()

    vi.restoreAllMocks()
    expect(await readFileRaw(file)).toBe(before)
  })

  it("normalizes backslashes, a ./ prefix, and a project prefix in another case in the source path", async () => {
    await recordFingerprint(project, "raw\\sources\\win.md", ARTICLE)
    await recordFingerprint(project, "./raw/sources/dot.md", OTHER_TEXT)
    await recordFingerprint(project, `${project.toUpperCase()}/raw/sources/upper.md`, `${OTHER_TEXT} and then some more words`)
    await recordFingerprint(project, `${project.replace(/\//g, "\\")}\\raw\\sources\\abs.md`, `${OTHER_TEXT} and one more thing`)

    expect((await stored()).map((f) => f.sourcePath)).toEqual([
      "raw/sources/win.md",
      "raw/sources/dot.md",
      "raw/sources/upper.md",
      "raw/sources/abs.md",
    ])

    // The same file spelled another way is the same path, so it is not a duplicate of itself.
    await writeSummary("raw/sources/win.md")
    expect(await findDuplicateSource(project, "./raw/sources/win.md", ARTICLE)).toBeNull()
    expect(await findDuplicateSource(project, `${project.toUpperCase()}/raw/sources/win.md`, ARTICLE)).toBeNull()
    expect(await findDuplicateSource(project, `${project.replace(/\//g, "\\")}\\raw\\sources\\win.md`, ARTICLE)).toBeNull()
  })

  it("ignores entries of the wrong shape", async () => {
    await writeSummary("raw/sources/a.md")
    await writeFileRaw(
      `${project}/${FINGERPRINTS}`,
      JSON.stringify({ fingerprints: [null, 5, { sourcePath: 3 }, { sourcePath: "raw/sources/a.md", url: null, textSample: "x", length: 1 }] }),
    )
    // Does not throw, and the one well-formed entry is kept when the file is rewritten.
    await recordFingerprint(project, "raw/sources/b.md", ARTICLE)
    expect((await stored()).map((f) => f.sourcePath)).toEqual(["raw/sources/a.md", "raw/sources/b.md"])
  })
})

describe("checkDuplicateSource", () => {
  let tmp: { path: string; cleanup: () => Promise<void> }
  let project: string

  beforeEach(async () => {
    tmp = await createTempProject("fingerprints-check")
    project = tmp.path
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    await tmp.cleanup()
  })

  async function seed(sourcePath: string, content: string): Promise<string> {
    const summary = summaryPathForSource(project, sourcePath)
    await writeFileRaw(`${project}/${summary}`, "# Summary\n")
    await recordFingerprint(project, sourcePath, content, summary)
    return summary
  }

  async function stored(): Promise<Fingerprint[]> {
    return (JSON.parse(await readFileRaw(`${project}/${FINGERPRINTS}`)) as { fingerprints: Fingerprint[] }).fingerprints
  }

  it("returns null when the source is not a duplicate", async () => {
    await seed("raw/sources/a.md", ARTICLE)
    expect(await checkDuplicateSource(project, `${project}/raw/sources/b.md`, OTHER_TEXT)).toBeNull()
    expect((await stored()).map((f) => f.sourcePath)).toEqual(["raw/sources/a.md"])
  })

  it("on a hit returns the existing summary page and records the new path against it", async () => {
    const summary = await seed("raw/sources/a.md", ARTICLE)

    const result = await checkDuplicateSource(project, `${project}/raw/sources/web/b.md`, ARTICLE_CLIPPED)

    expect(result?.summaryPath).toBe(summary)
    expect(result?.review).toBeNull() // about the same length
    const recorded = (await stored()).find((f) => f.sourcePath === "raw/sources/web/b.md")
    expect(recorded?.summaryPath).toBe(summary)
    // A third copy matches the second one too, and still points at the first summary page.
    const third = await checkDuplicateSource(project, `${project}/raw/sources/c.md`, ARTICLE)
    expect(third?.summaryPath).toBe(summary)
  })

  it("computes the summary page of an old fingerprint that has none", async () => {
    const summary = summaryPathForSource(project, "raw/sources/a.md")
    await writeFileRaw(`${project}/${summary}`, "# Summary\n")
    await recordFingerprint(project, "raw/sources/a.md", ARTICLE) // summaryPath null

    const result = await checkDuplicateSource(project, `${project}/raw/sources/b.md`, ARTICLE)

    expect(result?.summaryPath).toBe(summary)
    expect(summary).toBe(`wiki/sources/${sourceSummarySlugFromIdentity("a.md")}.md`)
    expect((await stored()).find((f) => f.sourcePath === "raw/sources/b.md")?.summaryPath).toBe(summary)
  })

  it("adds a duplicate-source review when the new text is at least 20% longer", async () => {
    const summary = await seed("raw/sources/a.md", LONG_BASE)

    const result = await checkDuplicateSource(project, `${project}/raw/sources/web/b.md`, LONG_EXTENDED)

    expect(result?.hit.reason).toBe("text")
    expect(result?.summaryPath).toBe(summary)
    const review = result?.review
    expect(review?.type).toBe("duplicate-source")
    expect(review?.title).toContain("web/b.md")
    expect(review?.sourcePath).toBe(`${project}/raw/sources/web/b.md`)
    expect(review?.affectedPages).toEqual([summary])
    expect(review?.options).toEqual([
      { label: "Use the newer text", action: "mech:replace-source" },
      { label: "Skip", action: "Skip" },
    ])
    const lines = (review?.description ?? "").split("\n")
    expect(lines).toHaveLength(3)
    expect(lines[0]).not.toMatch(/^(EXISTING|NEWER):/)
    expect(lines[0].length).toBeGreaterThan(10)
    expect(lines[1]).toBe("EXISTING: raw/sources/a.md")
    expect(lines[2]).toBe("NEWER: raw/sources/web/b.md")
  })

  it("a 30% longer copy of the same text is a duplicate and gets a duplicate-source review", async () => {
    const summary = await seed("raw/sources/a.md", MEDIUM_BASE)

    const result = await checkDuplicateSource(project, `${project}/raw/sources/web/b.md`, MEDIUM_EXTENDED)

    expect(MEDIUM_EXTENDED.length / MEDIUM_BASE.length).toBeGreaterThanOrEqual(1.3)
    expect(result?.hit.reason).toBe("text")
    expect(result?.summaryPath).toBe(summary)
    expect(result?.review?.type).toBe("duplicate-source")
    expect(result?.review?.description).toContain("EXISTING: raw/sources/a.md")
    expect(result?.review?.description).toContain("NEWER: raw/sources/web/b.md")
  })

  it("names the original source as EXISTING when the match is a copy recorded against it", async () => {
    const summary = await seed("raw/sources/a.md", MEDIUM_BASE)
    // b.md was skipped as a copy of a.md; it carries a frontmatter URL that a.md does not.
    await recordFingerprint(project, "raw/sources/b.md", `---\nurl: https://example.com/z\n---\n${MEDIUM_BASE}`, summary)

    const result = await checkDuplicateSource(
      project,
      `${project}/raw/sources/c.md`,
      `---\nurl: https://example.com/z\n---\n${MEDIUM_EXTENDED}`,
    )

    expect(result?.hit.existing.sourcePath).toBe("raw/sources/b.md")
    expect(result?.original.sourcePath).toBe("raw/sources/a.md")
    expect(result?.summaryPath).toBe(summary)
    const lines = (result?.review?.description ?? "").split("\n")
    expect(lines).toContain("EXISTING: raw/sources/a.md")
    expect(lines).toContain("NEWER: raw/sources/c.md")
    expect(lines.join("\n")).not.toContain("raw/sources/b.md")
  })

  it("adds a review for a frontmatter url match whose text is much longer", async () => {
    await seed("raw/sources/a.md", `---\nurl: https://example.com/post\n---\n${OTHER_TEXT}`)
    const longer = `---\nurl: https://example.com/post/?utm_source=x\n---\n${ARTICLE}\n\n${ARTICLE}`

    const result = await checkDuplicateSource(project, `${project}/raw/sources/b.md`, longer)

    expect(result?.hit.reason).toBe("url")
    expect(result?.review?.type).toBe("duplicate-source")
  })

  it("adds no review when the new text is shorter or less than 20% longer", async () => {
    await seed("raw/sources/a.md", LONG_BASE)
    const slightlyLonger = `${LONG_BASE} ${LONG_BASE.slice(0, 600)}`
    const shorter = LONG_BASE.slice(0, 5000)
    const first = await checkDuplicateSource(project, `${project}/raw/sources/b.md`, slightlyLonger)
    const second = await checkDuplicateSource(project, `${project}/raw/sources/c.md`, shorter)
    expect(first?.hit.reason).toBe("text")
    expect(first?.review).toBeNull()
    expect(second?.hit.reason).toBe("text")
    expect(second?.review).toBeNull()
  })

  it("drops a stale fingerprint instead of reporting a hit", async () => {
    await seed("raw/sources/a.md", ARTICLE)
    await realFs.deleteFile(`${project}/${summaryPathForSource(project, "raw/sources/a.md")}`)

    expect(await checkDuplicateSource(project, `${project}/raw/sources/b.md`, ARTICLE)).toBeNull()
    expect(await stored()).toEqual([])
  })

  it("still reports the hit when the new fingerprint cannot be written", async () => {
    const summary = await seed("raw/sources/a.md", ARTICLE)
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    vi.spyOn(realFs, "writeFile").mockRejectedValue(new Error("disk full"))

    const result = await checkDuplicateSource(project, `${project}/raw/sources/b.md`, ARTICLE)

    expect(result?.summaryPath).toBe(summary)
    expect(warn).toHaveBeenCalled()
  })

  it("does not throw when the fingerprint file cannot be read or written", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    // A directory where the file should be: reads and writes both fail.
    await writeFileRaw(`${project}/${FINGERPRINTS}/placeholder`, "x")

    expect(await checkDuplicateSource(project, `${project}/raw/sources/b.md`, ARTICLE)).toBeNull()
    expect(warn).toHaveBeenCalled()
  })
})

describe("noteOtherEntryPoint", () => {
  let tmp: { path: string; cleanup: () => Promise<void> }
  let project: string
  const PAGE = "wiki/sources/a.md"
  const NEW_PATH = "raw/sources/web/b.md"

  beforeEach(async () => {
    tmp = await createTempProject("fingerprints-also-from")
    project = tmp.path
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    await tmp.cleanup()
  })

  async function page(content: string): Promise<void> {
    await writeFileRaw(`${project}/${PAGE}`, content)
  }
  async function current(): Promise<string> {
    return readFileRaw(`${project}/${PAGE}`)
  }

  it("a duplicate hit lists the new entry point on the existing summary page", async () => {
    await page('---\ntitle: "Source"\ntype: source\n---\n\n# Source\n')

    expect(await noteOtherEntryPoint(project, PAGE, `${project}/${NEW_PATH}`)).toBe(true)

    expect(await current()).toBe(
      '---\ntitle: "Source"\ntype: source\nalso_from:\n  - raw/sources/web/b.md\n---\n\n# Source\n',
    )
  })

  it("does not add the same entry point twice", async () => {
    await page("---\ntitle: Source\n---\n\n# Source\n")
    expect(await noteOtherEntryPoint(project, PAGE, NEW_PATH)).toBe(true)
    const once = await current()

    expect(await noteOtherEntryPoint(project, PAGE, NEW_PATH)).toBe(false)
    expect(await noteOtherEntryPoint(project, PAGE, `${project}/${NEW_PATH}`)).toBe(false)

    expect(await current()).toBe(once)
    expect(once.match(/web\/b\.md/g)).toHaveLength(1)
  })

  it("adds to an existing block list after its last item and keeps every other byte", async () => {
    await page("---\ntitle: Source\nalso_from:\n    - raw/sources/x.md\n    - raw/sources/y.md\nrelated: [a]\n---\nBody\n")

    expect(await noteOtherEntryPoint(project, PAGE, NEW_PATH)).toBe(true)

    expect(await current()).toBe(
      "---\ntitle: Source\nalso_from:\n    - raw/sources/x.md\n    - raw/sources/y.md\n    - raw/sources/web/b.md\nrelated: [a]\n---\nBody\n",
    )
  })

  it("recognizes a quoted item that is already there", async () => {
    await page('---\nalso_from:\n  - "raw/sources/web/b.md"  # first copy\n---\n')
    expect(await noteOtherEntryPoint(project, PAGE, NEW_PATH)).toBe(false)
  })

  it("fills an empty key", async () => {
    await page("---\nalso_from:\ntitle: Source\n---\n")
    expect(await noteOtherEntryPoint(project, PAGE, NEW_PATH)).toBe(true)
    expect(await current()).toBe("---\nalso_from:\n  - raw/sources/web/b.md\ntitle: Source\n---\n")
  })

  it("adds to an inline list", async () => {
    await page('---\nalso_from: ["raw/sources/x.md"]  # copies\ntitle: Source\n---\n')
    expect(await noteOtherEntryPoint(project, PAGE, NEW_PATH)).toBe(true)
    expect(await current()).toBe('---\nalso_from: ["raw/sources/x.md", raw/sources/web/b.md]  # copies\ntitle: Source\n---\n')

    await page("---\nalso_from: []\n---\n")
    expect(await noteOtherEntryPoint(project, PAGE, NEW_PATH)).toBe(true)
    expect(await current()).toBe("---\nalso_from: [raw/sources/web/b.md]\n---\n")
    expect(await noteOtherEntryPoint(project, PAGE, NEW_PATH)).toBe(false)
  })

  it("quotes a path that is not a plain YAML word", async () => {
    await page("---\ntitle: Source\n---\n")
    expect(await noteOtherEntryPoint(project, PAGE, "raw/sources/my note: draft #2.md")).toBe(true)
    expect(await current()).toBe('---\ntitle: Source\nalso_from:\n  - "raw/sources/my note: draft #2.md"\n---\n')
  })

  it("keeps CRLF line endings", async () => {
    await page("---\r\ntitle: Source\r\n---\r\n\r\n# Source\r\n")
    expect(await noteOtherEntryPoint(project, PAGE, NEW_PATH)).toBe(true)
    expect(await current()).toBe(
      "---\r\ntitle: Source\r\nalso_from:\r\n  - raw/sources/web/b.md\r\n---\r\n\r\n# Source\r\n",
    )
  })

  it("does nothing for a page without frontmatter and says so once", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    await page("# Source\n\nNo frontmatter here.\n")

    expect(await noteOtherEntryPoint(project, PAGE, NEW_PATH)).toBe(false)
    expect(await noteOtherEntryPoint(project, PAGE, "raw/sources/web/c.md")).toBe(false)

    expect(await current()).toBe("# Source\n\nNo frontmatter here.\n")
    expect(warn).toHaveBeenCalledTimes(1)
  })

  it("leaves a page alone when also_from is not a list", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    await page("---\nalso_from: raw/sources/x.md\n---\n")
    expect(await noteOtherEntryPoint(project, PAGE, NEW_PATH)).toBe(false)
    expect(await current()).toBe("---\nalso_from: raw/sources/x.md\n---\n")
    expect(warn).toHaveBeenCalledTimes(1)
  })

  it("does not throw when the page is missing", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    expect(await noteOtherEntryPoint(project, "wiki/sources/missing.md", NEW_PATH)).toBe(false)
    expect(warn).toHaveBeenCalled()
  })
})
