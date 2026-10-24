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
  normalizeUrl,
  recordFingerprint,
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

  it("finds a url hit when the text differs", async () => {
    const summary = await writeSummary("raw/sources/a.md")
    await recordFingerprint(project, "raw/sources/a.md", `url: https://example.com/post\n\n${OTHER_TEXT}`)

    const hit = await findDuplicateSource(
      project,
      "raw/sources/b.md",
      `---\nsource: "https://EXAMPLE.com/post/?utm_source=x#top"\n---\n${ARTICLE}`,
    )

    expect(hit?.reason).toBe("url")
    expect(hit?.score).toBe(1)
    expect(hit?.existing.sourcePath).toBe("raw/sources/a.md")
    expect(hit?.existing.url).toBe("https://example.com/post")
    expect(summaryPathForSource(project, hit?.existing.sourcePath ?? "")).toBe(summary)
  })

  it("reads the url from the first 20 lines when there is no frontmatter", async () => {
    await writeSummary("raw/sources/a.md")
    await recordFingerprint(project, "raw/sources/a.md", `# Title\n\nOriginal: https://example.com/post.\n\n${OTHER_TEXT}`)
    const fingerprints = await stored()
    expect(fingerprints[0].url).toBe("https://example.com/post")

    const late = `${"filler\n".repeat(25)}https://example.com/other\n${OTHER_TEXT}`
    await recordFingerprint(project, "raw/sources/late.md", late)
    expect((await stored()).find((f) => f.sourcePath === "raw/sources/late.md")?.url).toBeNull()
  })

  it("finds a text hit", async () => {
    await writeSummary("raw/sources/a.md")
    await recordFingerprint(project, "raw/sources/a.md", ARTICLE)

    const hit = await findDuplicateSource(project, "raw/sources/heptabase/b.md", ARTICLE_CLIPPED)

    expect(hit?.reason).toBe("text")
    expect(hit?.score).toBeGreaterThanOrEqual(0.85)
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

  it("adds a review for a url match whose text is much longer", async () => {
    await seed("raw/sources/a.md", `url: https://example.com/post\n\n${OTHER_TEXT}`)
    const longer = `url: https://example.com/post/?utm_source=x\n\n${ARTICLE}\n\n${ARTICLE}`

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
