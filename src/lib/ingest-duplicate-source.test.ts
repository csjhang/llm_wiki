/**
 * Duplicate sources in ingest.
 *
 * A mechanism wiki (a project with `domains.yaml`) skips a source that repeats one it already
 * ingested, even when the copy came through another entry point. A plain wiki ingests every
 * source as upstream does.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import fs from "node:fs/promises"
import { createTempProject, realFs, writeFileRaw } from "@/test-helpers/fs-temp"
import { materializeSampleWiki } from "@/test-helpers/sample-wiki"
import { useActivityStore } from "@/stores/activity-store"
import { useChatStore } from "@/stores/chat-store"
import { useReviewStore } from "@/stores/review-store"
import { useWikiStore } from "@/stores/wiki-store"

vi.mock("@/commands/fs", () => realFs)

vi.mock("./llm-client", () => ({
  streamChat: vi.fn(async (_cfg, messages, cb) => {
    const systemPrompt = String(messages?.[0]?.content ?? "")
    const target = systemPrompt.match(/source summary page at \*\*(wiki\/sources\/[^*]+)\*\*/)?.[1]
    if (!target) {
      cb.onToken("## Analysis\nA short analysis.")
      cb.onDone()
      return
    }
    cb.onToken(
      [`---FILE: ${target}---`, "---", 'title: "Source"', "---", "", "# Source", "---END FILE---"].join("\n"),
    )
    cb.onDone({ finishReason: "stop", truncated: false })
  }),
}))

vi.mock("./mineru", () => ({
  parseWithMineru: vi.fn(),
  parseWithMineruResult: vi.fn(),
}))

import { autoIngest } from "./ingest"
import { streamChat } from "./llm-client"
import { sourceSummarySlugFromIdentity } from "./source-identity"
import type { Fingerprint } from "./mechanism-wiki/source-fingerprint"

const mockStreamChat = vi.mocked(streamChat)

const FINGERPRINTS = ".llm-wiki/source-fingerprints.json"
const PURPOSE = "# Purpose\n\nTrack how things work.\n"
const INDEX = "# Index\n\n- [[existing-page]]\n"
const OVERVIEW = "# Overview\n"
const PLAIN_SCHEMA = "# Schema\n\n## Page Types\n| goal | wiki/goals/ | Outcomes |\n"

const ARTICLE = [
  "# How asynchronous handshakes work",
  "",
  "A **request** line goes high when the sender has data. The receiver raises an *acknowledge* line",
  "once it has latched the data, and the sender then lowers the request line again. Only after the",
  "acknowledge line falls does the next transfer begin, so no clock is needed to keep both sides in step.",
  "",
  "- Four-phase protocols return both lines to zero between transfers.",
  "- Two-phase protocols toggle each line once per transfer and save the return step.",
].join("\n")

/** The same article from another entry point: other whitespace and markup, a tracking URL. */
const ARTICLE_COPY = [
  "---",
  "url: https://example.com/handshakes?utm_source=feed",
  "---",
  "## How asynchronous   handshakes work",
  "",
  "A __request__ line goes high when the sender has data. The receiver raises an _acknowledge_ line once",
  "it has latched the data, and the sender then lowers the request line again. Only after the acknowledge",
  "line falls does the next transfer begin, so no clock is needed to keep both sides in step.",
  "",
  "* Four-phase protocols return both lines to zero between transfers.",
  "* Two-phase protocols toggle each line once per transfer and save the return step.",
].join("\n")

const MEDIUM_BASE = Array.from(
  { length: 30 },
  (_, i) => `Step ${i} of the four-phase handshake raises or lowers one wire.`,
).join(" ")
const MEDIUM_EXTENDED = `${MEDIUM_BASE} ${Array.from(
  { length: 11 },
  (_, i) => `Extra ${i} explains why the delay element needs a safety margin.`,
).join(" ")}`

const OTHER_TEXT =
  "Sourdough starters need regular feeding with flour and water. Discard half before each feeding, keep the jar somewhere warm, and expect bubbles within eight hours."

function summaryOf(identity: string): string {
  return `wiki/sources/${sourceSummarySlugFromIdentity(identity)}.md`
}

describe("ingest and duplicate sources", () => {
  let tmp: { path: string; cleanup: () => Promise<void> }
  let project: string

  beforeEach(async () => {
    mockStreamChat.mockClear()
    vi.spyOn(console, "warn").mockImplementation(() => {})
    tmp = await createTempProject("ingest-duplicate")
    project = tmp.path
    useReviewStore.setState({ items: [] })
    useActivityStore.setState({ items: [] })
    useChatStore.setState({
      conversations: [],
      messages: [],
      activeConversationId: null,
      mode: "chat",
      ingestSource: null,
      isStreaming: false,
      streamingContent: "",
    })
    useWikiStore.setState({
      project: { id: "p", name: "p", path: project },
      fileTree: [],
      outputLanguage: "auto",
      multimodalConfig: {
        enabled: false,
        useMainLlm: true,
        provider: "openai",
        apiKey: "",
        model: "",
        ollamaUrl: "",
        customEndpoint: "",
        concurrency: 1,
      },
      embeddingConfig: { enabled: false, endpoint: "", apiKey: "", model: "" },
      mineruConfig: { enabled: false, backend: "cloud", token: "", modelVersion: "vlm" },
    })
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    await tmp.cleanup()
  })

  async function mechanismWiki(): Promise<void> {
    await materializeSampleWiki(project)
    await writeFileRaw(`${project}/wiki/index.md`, INDEX)
    await writeFileRaw(`${project}/wiki/overview.md`, OVERVIEW)
  }

  async function plainWiki(): Promise<void> {
    await writeFileRaw(`${project}/purpose.md`, PURPOSE)
    await writeFileRaw(`${project}/schema.md`, PLAIN_SCHEMA)
    await writeFileRaw(`${project}/wiki/index.md`, INDEX)
    await writeFileRaw(`${project}/wiki/overview.md`, OVERVIEW)
  }

  async function ingest(relativePath: string, content: string): Promise<string[]> {
    await writeFileRaw(`${project}/${relativePath}`, content)
    return autoIngest(project, `${project}/${relativePath}`, { ...useWikiStore.getState().llmConfig })
  }

  async function storedFingerprints(): Promise<Fingerprint[]> {
    const parsed = JSON.parse(await fs.readFile(`${project}/${FINGERPRINTS}`, "utf8")) as { fingerprints: Fingerprint[] }
    return parsed.fingerprints
  }

  it("records a fingerprint after a successful ingest", async () => {
    await mechanismWiki()
    const written = await ingest("raw/sources/a.md", ARTICLE)

    expect(written).toContain(summaryOf("a.md"))
    const [fingerprint] = await storedFingerprints()
    expect(fingerprint).toMatchObject({ sourcePath: "raw/sources/a.md", summaryPath: summaryOf("a.md") })
  })

  it("ingest skips duplicate and returns existing summary", async () => {
    await mechanismWiki()
    await ingest("raw/sources/a.md", ARTICLE)
    mockStreamChat.mockClear()

    const written = await ingest("raw/sources/web/b.md", ARTICLE_COPY)

    expect(mockStreamChat).not.toHaveBeenCalled()
    expect(written).toEqual([summaryOf("a.md")])
    expect(written.some((path) => path.startsWith("raw/"))).toBe(false)
    // The copy writes no summary page of its own.
    await expect(fs.access(`${project}/${summaryOf("web/b.md")}`)).rejects.toThrow()
    // The copy is remembered against the first summary page, so a third copy matches too.
    const copy = (await storedFingerprints()).find((f) => f.sourcePath === "raw/sources/web/b.md")
    expect(copy?.summaryPath).toBe(summaryOf("a.md"))
    // The first copy's summary page lists the new entry point.
    expect(await fs.readFile(`${project}/${summaryOf("a.md")}`, "utf8")).toContain(
      'also_from:\n  - raw/sources/web/b.md\n---\n',
    )
    // About the same length: no review.
    expect(useReviewStore.getState().items).toEqual([])
    const activity = useActivityStore.getState().items.find((item) => item.title === "b.md")
    expect(activity?.status).toBe("done")
    expect(activity?.filesWritten).toEqual([summaryOf("a.md")])
  })

  it("sends a duplicate-source review when the copy is at least 20% longer", async () => {
    await mechanismWiki()
    await ingest("raw/sources/a.md", `---\nurl: https://example.com/handshakes\n---\n${ARTICLE}`)
    mockStreamChat.mockClear()
    const longer = `---\nurl: https://Example.com/handshakes/?utm_source=feed\n---\n${ARTICLE}\n\n${ARTICLE.toUpperCase()}\n\nMore on delay elements.`

    const written = await ingest("raw/sources/web/b.md", longer)

    expect(mockStreamChat).not.toHaveBeenCalled()
    expect(written).toEqual([summaryOf("a.md")])
    const reviews = useReviewStore.getState().items.filter((item) => item.type === "duplicate-source")
    expect(reviews).toHaveLength(1)
    const review = reviews[0]
    expect(review.title).toContain("web/b.md")
    expect(review.affectedPages).toEqual([summaryOf("a.md")])
    expect(review.options.map((option) => option.action)).toEqual(["mech:replace-source", "Skip"])
    const lines = review.description.split("\n")
    expect(lines).toContain("EXISTING: raw/sources/a.md")
    expect(lines).toContain("NEWER: raw/sources/web/b.md")
  })

  it("a 30% longer copy of the same text is a duplicate and gets a duplicate-source review", async () => {
    await mechanismWiki()
    await ingest("raw/sources/a.md", MEDIUM_BASE)
    mockStreamChat.mockClear()

    const written = await ingest("raw/sources/web/b.md", MEDIUM_EXTENDED)

    expect(mockStreamChat).not.toHaveBeenCalled()
    expect(written).toEqual([summaryOf("a.md")])
    const reviews = useReviewStore.getState().items.filter((item) => item.type === "duplicate-source")
    expect(reviews).toHaveLength(1)
    expect(reviews[0].description.split("\n")).toContain("EXISTING: raw/sources/a.md")
  })

  it("a second hit from the same entry point does not list it twice", async () => {
    await mechanismWiki()
    await ingest("raw/sources/a.md", ARTICLE)
    await ingest("raw/sources/web/b.md", ARTICLE_COPY)
    await ingest("raw/sources/web/b.md", ARTICLE_COPY)
    await ingest("raw/sources/c.md", ARTICLE_COPY)

    const page = await fs.readFile(`${project}/${summaryOf("a.md")}`, "utf8")
    expect(page).toMatch(
      /^---\ntitle: "Source"\ncreated: [\d-]+\nupdated: [\d-]+\nsources: \["a\.md"\]\nalso_from:\n {2}- raw\/sources\/web\/b\.md\n {2}- raw\/sources\/c\.md\n---\n\n# Source$/,
    )
  })

  it("stale fingerprint is dropped and the source is ingested", async () => {
    await mechanismWiki()
    await ingest("raw/sources/a.md", ARTICLE)
    // The user undoes the first ingest: its summary page is gone.
    await fs.rm(`${project}/${summaryOf("a.md")}`)
    mockStreamChat.mockClear()

    const written = await ingest("raw/sources/web/b.md", ARTICLE_COPY)

    expect(mockStreamChat).toHaveBeenCalled()
    expect(written).toContain(summaryOf("web/b.md"))
    const paths = (await storedFingerprints()).map((f) => f.sourcePath)
    expect(paths).toEqual(["raw/sources/web/b.md"])
  })

  it("ingests a different source normally and records it", async () => {
    await mechanismWiki()
    await ingest("raw/sources/a.md", ARTICLE)
    mockStreamChat.mockClear()

    const written = await ingest("raw/sources/other.md", OTHER_TEXT)

    expect(mockStreamChat).toHaveBeenCalled()
    expect(written).toContain(summaryOf("other.md"))
    expect((await storedFingerprints()).map((f) => f.sourcePath)).toEqual(["raw/sources/a.md", "raw/sources/other.md"])
  })

  it("re-ingests an edited source at the same path", async () => {
    await mechanismWiki()
    await ingest("raw/sources/a.md", ARTICLE)
    mockStreamChat.mockClear()

    const written = await ingest("raw/sources/a.md", `${ARTICLE}\n\nA new closing paragraph about delay elements.`)

    expect(mockStreamChat).toHaveBeenCalled()
    expect(written).toContain(summaryOf("a.md"))
  })

  it("a plain wiki ingests a duplicate and writes no fingerprints", async () => {
    await plainWiki()
    await ingest("raw/sources/a.md", ARTICLE)
    mockStreamChat.mockClear()

    const written = await ingest("raw/sources/web/b.md", ARTICLE_COPY)

    expect(mockStreamChat).toHaveBeenCalled()
    expect(written).toContain(summaryOf("web/b.md"))
    await expect(fs.access(`${project}/${FINGERPRINTS}`)).rejects.toThrow()
    expect(useReviewStore.getState().items.filter((item) => item.type === "duplicate-source")).toEqual([])
  })

  it("a fingerprint failure does not fail the ingest", async () => {
    await mechanismWiki()
    // A directory where the fingerprint file belongs: it cannot be read or written.
    await writeFileRaw(`${project}/${FINGERPRINTS}/placeholder`, "x")

    const written = await ingest("raw/sources/a.md", ARTICLE)

    expect(written).toContain(summaryOf("a.md"))
    expect(console.warn).toHaveBeenCalled()
  })
})
