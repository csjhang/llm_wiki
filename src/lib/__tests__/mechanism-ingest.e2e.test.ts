/**
 * Mechanism ingest, end to end.
 *
 * Two sources of the sample wiki go through the real `autoIngest`: the handshake article of
 * hardware/async-circuits and the spiking network article of ai/architecture. The model is
 * mocked with canned analysis, generation, and merge answers, but everything else is real: the
 * temp project on disk, the prompts, the decision parser, the rule enforcement, the page writer
 * and its page merge, the domain index, and the source fingerprints.
 *
 * The two sources share one mechanism. The first ingest writes the mechanism page. The second
 * one updates it, which sends the page through the page merge.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import fs from "node:fs/promises"
import { createTempProject, realFs, readFileRaw, writeFileRaw } from "@/test-helpers/fs-temp"
import { materializeSampleWiki } from "@/test-helpers/sample-wiki"
import { useActivityStore } from "@/stores/activity-store"
import { useChatStore } from "@/stores/chat-store"
import { useReviewStore } from "@/stores/review-store"
import { useWikiStore } from "@/stores/wiki-store"

vi.mock("@/commands/fs", () => realFs)

/**
 * What the mocked model saw, in call order: the kind of call and the page or source it was about.
 * `mergeAnswer` replaces the answer to a page merge when a test sets it.
 */
const seen = vi.hoisted(() => ({
  calls: [] as Array<{ kind: "analysis" | "generation" | "merge" | "fusion" | "other"; subject: string; system: string; user: string }>,
  mergeAnswer: null as string | null,
  /** What the model answers when a new mechanism page asks for fusion candidates. Empty: no candidate. */
  fusionAnswer: "",
}))

vi.mock("@/lib/llm-client", () => ({
  streamChat: vi.fn(async (_cfg, messages, cb) => {
    const system = String(messages?.[0]?.content ?? "")
    const user = String(messages?.[1]?.content ?? "")
    const record = (kind: "analysis" | "generation" | "merge" | "fusion" | "other", subject: string): void => {
      seen.calls.push({ kind, subject, system, user })
    }

    if (system.startsWith("You find domains where a mechanism may also work")) {
      record("fusion", MERGED_MECHANISM_PAGE_SLUG)
      cb.onToken(seen.fusionAnswer)
      cb.onDone()
      return
    }

    if (system.startsWith("You are merging source-backed material")) {
      record("merge", MERGED_MECHANISM_PAGE_SLUG)
      cb.onToken(seen.mergeAnswer ?? MERGED_MECHANISM_PAGE)
      cb.onDone()
      return
    }

    const target = system.match(/source summary page at \*\*wiki\/sources\/([^*]+)\.md\*\*/)?.[1]
    if (target !== undefined) {
      record("generation", target)
      cb.onToken(GENERATIONS[target] ?? "")
      cb.onDone({ finishReason: "stop", truncated: false })
      return
    }

    if (system.startsWith("You are an expert research analyst")) {
      const file = user.match(/\*\*File:\*\* (\S+)/)?.[1] ?? ""
      record("analysis", file.replace(/\.md$/, ""))
      cb.onToken(ANALYSES[file.replace(/\.md$/, "")] ?? "## Analysis\nNothing to report.")
      cb.onDone()
      return
    }

    // Anything else is a call that this test does not expect.
    record("other", "")
    cb.onToken("")
    cb.onDone()
  }),
}))

vi.mock("@/lib/mineru", () => ({
  parseWithMineru: vi.fn(),
  parseWithMineruResult: vi.fn(),
}))

import { autoIngest } from "@/lib/ingest"
import { streamChat } from "@/lib/llm-client"
import type { Fingerprint } from "@/lib/mechanism-wiki/source-fingerprint"

const mockStreamChat = vi.mocked(streamChat)

const FINGERPRINTS = ".llm-wiki/source-fingerprints.json"
const HANDSHAKE = "async-handshake-circuits"
const SPIKING = "spiking-neural-networks"
const MECHANISM_PATH = "wiki/mechanisms/event-driven-computation.md"
const MERGED_MECHANISM_PAGE_SLUG = "event-driven-computation"

// --- what the mocked model answers -------------------------------------

const ANALYSES: Record<string, string> = {
  [HANDSHAKE]: [
    "## Key Entities",
    "- Request and acknowledge wires: the pair of signals through which two neighboring stages agree on a transfer.",
    "",
    "## Main Concepts",
    "- Request/acknowledge handshake: each stage waits for its neighbor, so no clock is needed.",
    "- Event-driven switching: a part toggles only when data arrives for it, so a quiet circuit uses little power.",
    "",
    "## Connections to the existing wiki",
    "The wiki index lists no page about this mechanism yet.",
    "",
    "## Decisions",
    "DOMAIN: hardware/async-circuits",
    "MECHANISM: new:event-driven-computation | A part does work only when an event reaches it, so a quiet system does almost no work.",
  ].join("\n"),
  [SPIKING]: [
    "## Key Entities",
    "- Spiking neuron: keeps a membrane potential and fires when it crosses a threshold.",
    "",
    "## Main Concepts",
    "- Spike-driven computation: a neuron works only when a spike reaches it, so activity is sparse.",
    "",
    "## Connections to the existing wiki",
    "The mechanism index already has event-driven-computation, and this source shows it again in a second domain.",
    "",
    "## Decisions",
    "DOMAIN: ai/architecture",
    "MECHANISM: existing:event-driven-computation | A part does work only when an event reaches it, so a quiet system does almost no work.",
  ].join("\n"),
}

function sourcePage(slug: string, title: string, domain: string, related: string, summary: string): string {
  return [
    `---FILE: wiki/sources/${slug}.md---`,
    "---",
    "type: source",
    `title: "${title}"`,
    `domain: ${domain}`,
    "source_kind: article",
    "tags: []",
    `related: [${related}]`,
    `sources: ["${slug}.md"]`,
    "---",
    `# ${title}`,
    "",
    summary,
    "---END FILE---",
  ].join("\n")
}

const HANDSHAKE_GENERATION = [
  sourcePage(
    HANDSHAKE,
    "Asynchronous Handshake Circuits",
    "hardware/async-circuits",
    "request-acknowledge-handshake",
    "Chips without a global clock let each stage tell its neighbor when data is ready, and they switch only when data arrives.",
  ),
  [
    "---FILE: wiki/concepts/request-acknowledge-handshake.md---",
    "---",
    "type: concept",
    'title: "Request/acknowledge handshake"',
    "domain: hardware/async-circuits",
    "tags: [async]",
    "related: [event-driven-computation]",
    `sources: ["${HANDSHAKE}.md"]`,
    "---",
    "# Request/acknowledge handshake",
    "",
    "A sender raises request, the receiver raises acknowledge, and both lower their wire again before the next item.",
    "---END FILE---",
  ].join("\n"),
  // The model adds a `domain` to the mechanism page, which the rules take away again.
  [
    `---FILE: ${MECHANISM_PATH}---`,
    "---",
    "type: mechanism",
    'title: "Event-driven computation"',
    "domain: hardware/async-circuits",
    "lenses: [hardware]",
    "instances: [request-acknowledge-handshake]",
    "tags: [event-driven]",
    "related: []",
    `sources: ["${HANDSHAKE}.md"]`,
    "---",
    "# Event-driven computation",
    "",
    "A part does work only when an event reaches it.",
    "",
    "## Parts",
    "",
    "- Event: a change of state that needs a reaction.",
    "- Sender: the part that notices the change and signals it.",
    "- Receiver: the part that works when the signal arrives.",
    "",
    "## Flows",
    "",
    "- The sender signals an event to the receiver.",
    "- The receiver works and confirms. Without events nothing moves.",
    "",
    "## Constraints and trade-offs",
    "",
    "- A quiet system costs little, at the price of timing that depends on arrival.",
    "",
    "## Why it works",
    "",
    "Most of the time nothing changes, so work that waits for a change skips the unchanged time.",
    "",
    "## Failure conditions",
    "",
    "- Events that arrive too densely cost more than a steady schedule would.",
    "",
    "## Known instances",
    "",
    "- [[request-acknowledge-handshake]] (hardware/async-circuits): request/acknowledge",
    "---END FILE---",
  ].join("\n"),
].join("\n")

const SPIKING_GENERATION = [
  sourcePage(
    SPIKING,
    "Spiking Neural Networks",
    "ai/architecture",
    "spike-driven-neuron",
    "Neurons that pass short spikes compute only when a spike arrives, so activity is sparse and energy use is low.",
  ),
  // The model forgets the `domain` of this page, which the rules add.
  [
    "---FILE: wiki/concepts/spike-driven-neuron.md---",
    "---",
    "type: concept",
    'title: "Spike-driven neuron"',
    "tags: [snn]",
    "related: [event-driven-computation]",
    `sources: ["${SPIKING}.md"]`,
    "---",
    "# Spike-driven neuron",
    "",
    "A neuron keeps a membrane potential, fires when it crosses a threshold, and works only when a spike reaches it.",
    "---END FILE---",
  ].join("\n"),
  // Only the new instance line: the page merge joins it to the page that exists.
  [
    `---FILE: ${MECHANISM_PATH}---`,
    "---",
    "type: mechanism",
    'title: "Event-driven computation"',
    "lenses: [ai]",
    "instances: [spike-driven-neuron]",
    "tags: [event-driven]",
    "related: []",
    `sources: ["${SPIKING}.md"]`,
    "---",
    "# Event-driven computation",
    "",
    "A part does work only when an event reaches it.",
    "",
    "## Parts",
    "",
    "- Event: a change of state that needs a reaction.",
    "- Sender: the part that notices the change and signals it.",
    "- Receiver: the part that works when the signal arrives.",
    "",
    "## Flows",
    "",
    "- The sender signals an event to the receiver.",
    "- The receiver works only on a signal, so sparse input means sparse work.",
    "",
    "## Constraints and trade-offs",
    "",
    "- Sparse activity saves work, at the price of a method that is hard to train.",
    "",
    "## Why it works",
    "",
    "Most of the time nothing changes, so work that waits for a change skips the unchanged time.",
    "",
    "## Failure conditions",
    "",
    "- Inputs that change all the time leave no sparse activity to save.",
    "",
    "## Known instances",
    "",
    "- [[spike-driven-neuron]] (ai/architecture): spike",
    "---END FILE---",
  ].join("\n"),
].join("\n")

const GENERATIONS: Record<string, string> = {
  [HANDSHAKE]: HANDSHAKE_GENERATION,
  [SPIKING]: SPIKING_GENERATION,
}

/** What the model answers when the page merge asks it to join the two versions of the mechanism page. */
const MERGED_MECHANISM_PAGE = [
  "---",
  "type: mechanism",
  'title: "Event-driven computation"',
  "lenses: [hardware, ai]",
  "instances: [request-acknowledge-handshake, spike-driven-neuron]",
  "tags: [event-driven]",
  "related: []",
  `sources: ["${HANDSHAKE}.md", "${SPIKING}.md"]`,
  "---",
  "# Event-driven computation",
  "",
  "A part does work only when an event reaches it.",
  "",
  "## Parts",
  "",
  "- Event: a change of state that needs a reaction.",
  "- Sender: the part that notices the change and signals it.",
  "- Receiver: the part that works when the signal arrives.",
  "",
  "## Flows",
  "",
  "- The sender signals an event to the receiver.",
  "- The receiver works and confirms. Without events nothing moves.",
  "- The receiver works only on a signal, so sparse input means sparse work.",
  "",
  "## Constraints and trade-offs",
  "",
  "- A quiet system costs little, at the price of timing that depends on arrival.",
  "- Sparse activity saves work, at the price of a method that is hard to train.",
  "",
  "## Why it works",
  "",
  "Most of the time nothing changes, so work that waits for a change skips the unchanged time.",
  "",
  "## Failure conditions",
  "",
  "- Events that arrive too densely cost more than a steady schedule would.",
  "- Inputs that change all the time leave no sparse activity to save.",
  "",
  "## Known instances",
  "",
  "- [[request-acknowledge-handshake]] (hardware/async-circuits): request/acknowledge",
  "- [[spike-driven-neuron]] (ai/architecture): spike",
  "",
].join("\n")

// --- the test ----------------------------------------------------------

describe("mechanism ingest, end to end", () => {
  let tmp: { path: string; cleanup: () => Promise<void> }
  let project: string

  beforeEach(async () => {
    mockStreamChat.mockClear()
    seen.calls.length = 0
    seen.mergeAnswer = null
    seen.fusionAnswer = ""
    vi.spyOn(console, "warn").mockImplementation(() => {})
    tmp = await createTempProject("mechanism-e2e")
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
    await materializeSampleWiki(project)
    await writeFileRaw(`${project}/wiki/index.md`, "# Wiki Index\n")
    await writeFileRaw(`${project}/wiki/overview.md`, "# Overview\n")
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    await tmp.cleanup()
  })

  function ingest(slug: string): Promise<string[]> {
    return autoIngest(project, `${project}/raw/sources/${slug}.md`, { ...useWikiStore.getState().llmConfig })
  }

  async function page(relativePath: string): Promise<string> {
    return readFileRaw(`${project}/${relativePath}`)
  }

  /** The `domain:` line of a page, or null. */
  async function domainOf(relativePath: string): Promise<string | null> {
    return /^domain:[ \t]*(.+)$/m.exec(await page(relativePath))?.[1].trim() ?? null
  }

  async function storedFingerprints(): Promise<Fingerprint[]> {
    const parsed = JSON.parse(await page(FINGERPRINTS)) as { fingerprints: Fingerprint[] }
    return parsed.fingerprints
  }

  /** The whitespace-changed copy of a sample source: another file name, other spacing, same words. */
  async function writeWhitespaceCopy(slug: string, copySlug: string): Promise<void> {
    const original = await page(`raw/sources/${slug}.md`)
    const copy = original.replace(/ /g, "  ").replace(/\n/g, "\n\n")
    expect(copy).not.toBe(original)
    await writeFileRaw(`${project}/raw/sources/${copySlug}.md`, copy)
  }

  it("ingests two sources of two domains into one mechanism, with the domain index", async () => {
    // --- source 1: hardware/async-circuits, a new mechanism
    seen.fusionAnswer = [
      "CANDIDATE: hardware/async-circuits | structural | The domain of the source has an instance already.",
      "CANDIDATE: business/franchising | surface | A franchisee acts only when the brand sends a request.",
    ].join("\n")
    const first = await ingest(HANDSHAKE)

    expect(first).toEqual(expect.arrayContaining([
      `wiki/sources/${HANDSHAKE}.md`,
      "wiki/concepts/request-acknowledge-handshake.md",
      MECHANISM_PATH,
      "wiki/index.md",
    ]))
    // The new mechanism page asks the model for fusion candidates, after the files are written.
    expect(seen.calls.map((call) => call.kind)).toEqual(["analysis", "generation", "fusion"])
    expect(seen.calls[2].user).toBe("List the fusion candidates now.")
    expect(seen.calls[2].system).toContain("A part does work only when an event reaches it.")
    // The prompts carry the mechanism sections.
    expect(seen.calls[0].system).toContain("## Decisions")
    expect(seen.calls[1].system).toContain(
      "write wiki/mechanisms/event-driven-computation.md as a new mechanism page",
    )
    // The rules: a mechanism page has no domain, and every other page has one.
    expect(await page(MECHANISM_PATH)).not.toMatch(/^domain:/m)
    expect(await domainOf(`wiki/sources/${HANDSHAKE}.md`)).toBe("hardware/async-circuits")
    expect(await domainOf("wiki/concepts/request-acknowledge-handshake.md")).toBe("hardware/async-circuits")
    expect(await page(MECHANISM_PATH)).toContain("- [[request-acknowledge-handshake]] (hardware/async-circuits)")
    expect((await storedFingerprints()).map((f) => f.sourcePath)).toEqual([`raw/sources/${HANDSHAKE}.md`])

    // --- source 2: ai/architecture, the same mechanism again
    seen.calls.length = 0
    const second = await ingest(SPIKING)

    expect(second).toEqual(expect.arrayContaining([
      `wiki/sources/${SPIKING}.md`,
      "wiki/concepts/spike-driven-neuron.md",
      MECHANISM_PATH,
      "wiki/index.md",
    ]))
    expect(seen.calls.map((call) => call.kind)).toEqual(["analysis", "generation", "merge"])
    // The second analysis sees the mechanism of the first ingest in its index.
    expect(seen.calls[0].system).toContain("[[event-driven-computation]]")
    expect(seen.calls[1].system).toContain("update wiki/mechanisms/event-driven-computation.md")
    // The mechanism page that exists and the new one go through the page merge.
    const merge = seen.calls[2]
    const [existingPart, additionalPart] = merge.user.split("## Additional material")
    expect(existingPart).toContain("[[request-acknowledge-handshake]]")
    expect(existingPart).not.toContain("[[spike-driven-neuron]]")
    expect(additionalPart).toContain("[[spike-driven-neuron]]")

    // --- the mechanism page
    const mechanism = await page(MECHANISM_PATH)
    expect(mechanism).toContain("- [[request-acknowledge-handshake]] (hardware/async-circuits): request/acknowledge")
    expect(mechanism).toContain("- [[spike-driven-neuron]] (ai/architecture): spike")
    expect(mechanism).toMatch(/^instances: \[request-acknowledge-handshake, spike-driven-neuron\]$/m)
    expect(mechanism).toMatch(/^lenses: \[hardware, ai\]$/m)
    expect(mechanism).not.toMatch(/^domain:/m)
    // The merge keeps the sources of both ingests.
    expect(mechanism).toContain(`${HANDSHAKE}.md`)
    expect(mechanism).toContain(`${SPIKING}.md`)

    // --- each source page has its own domain; a page without one got it from the rules
    expect(await domainOf(`wiki/sources/${HANDSHAKE}.md`)).toBe("hardware/async-circuits")
    expect(await domainOf(`wiki/sources/${SPIKING}.md`)).toBe("ai/architecture")
    expect(await domainOf("wiki/concepts/spike-driven-neuron.md")).toBe("ai/architecture")

    // --- the root index: the domain tree with counts
    const root = await page("wiki/index.md")
    expect(root).toContain("- [hardware/async-circuits](indexes/hardware--async-circuits.md) — 2 pages")
    expect(root).toContain("- [ai/architecture](indexes/ai--architecture.md) — 2 pages")
    expect(root).toContain("- [business/franchising](indexes/business--franchising.md) — 0 pages")
    expect(root).toContain("- [Mechanisms](indexes/_mechanisms.md) — 1 pages")
    expect(root).toContain("- Unassigned — 0 pages")

    // --- the domain indexes and the mechanism index
    const hardware = await page("wiki/indexes/hardware--async-circuits.md")
    expect(hardware).toContain(`- [[${HANDSHAKE}]] — Asynchronous Handshake Circuits`)
    expect(hardware).toContain("- [[request-acknowledge-handshake]] — Request/acknowledge handshake")
    expect(hardware).not.toContain(SPIKING)
    const ai = await page("wiki/indexes/ai--architecture.md")
    expect(ai).toContain(`- [[${SPIKING}]] — Spiking Neural Networks`)
    expect(ai).toContain("- [[spike-driven-neuron]] — Spike-driven neuron")
    expect(ai).not.toContain(HANDSHAKE)
    const mechanisms = await page("wiki/indexes/_mechanisms.md")
    expect(mechanisms).toContain("- [[event-driven-computation]] — Event-driven computation")

    // --- two sources, two fingerprints; only the new mechanism went to review, with one fusion item.
    // The second source added an instance to a mechanism that existed, so it asked for no candidate.
    const fusion = useReviewStore.getState().items
    expect(fusion.map((item) => [item.type, item.title, item.affectedPages])).toEqual([
      ["fusion-candidate", "Fusion candidates: Event-driven computation", [MECHANISM_PATH]],
    ])
    expect(fusion[0].description.split("\n")).toEqual([
      "Domains where Event-driven computation may also work:",
      "CANDIDATE: business/franchising | surface | A franchisee acts only when the brand sends a request.",
    ])
    expect((await storedFingerprints()).map((f) => f.sourcePath)).toEqual([
      `raw/sources/${HANDSHAKE}.md`,
      `raw/sources/${SPIKING}.md`,
    ])
    expect(seen.calls.filter((call) => call.kind === "other")).toEqual([])
    // No decision problem, no rejected merge, no failed write.
    expect(console.warn).not.toHaveBeenCalled()
  })

  it("skips a whitespace-changed copy of an ingested source under a new file name", async () => {
    await ingest(HANDSHAKE)
    await ingest(SPIKING)
    const indexBefore = await page("wiki/index.md")
    const mechanismBefore = await page(MECHANISM_PATH)
    const copySlug = "async-handshake-circuits-copy"
    await writeWhitespaceCopy(HANDSHAKE, copySlug)
    mockStreamChat.mockClear()
    seen.calls.length = 0

    const written = await ingest(copySlug)

    // The model is not called, and the result is the summary page of the first copy.
    expect(mockStreamChat).not.toHaveBeenCalled()
    expect(written).toEqual([`wiki/sources/${HANDSHAKE}.md`])
    await expect(fs.access(`${project}/wiki/sources/${copySlug}.md`)).rejects.toThrow()
    // The first summary page lists the new entry point, and nothing else of the wiki changed.
    expect(await page(`wiki/sources/${HANDSHAKE}.md`)).toMatch(
      new RegExp(`^also_from:\\n {2}- raw/sources/${copySlug}\\.md$`, "m"),
    )
    expect(await page("wiki/index.md")).toBe(indexBefore)
    expect(await page(MECHANISM_PATH)).toBe(mechanismBefore)
    // About the same length: no review. The copy is remembered against the first summary page.
    expect(useReviewStore.getState().items).toEqual([])
    const fingerprint = (await storedFingerprints()).find((f) => f.sourcePath === `raw/sources/${copySlug}.md`)
    expect(fingerprint?.summaryPath).toBe(`wiki/sources/${HANDSHAKE}.md`)
  })

  it("keeps the instances of the first domain when the page merge falls back", async () => {
    await ingest(HANDSHAKE)
    // A merge answer without frontmatter is rejected, so the page is the new one plus the unioned lists.
    seen.mergeAnswer = "A plain answer without any frontmatter at all."

    await ingest(SPIKING)

    const mechanism = await page(MECHANISM_PATH)
    expect(seen.calls.filter((call) => call.kind === "merge")).toHaveLength(1)
    expect(mechanism).toMatch(/^instances: \["request-acknowledge-handshake", "spike-driven-neuron"\]$/m)
    expect(mechanism).toMatch(/^lenses: \["hardware", "ai"\]$/m)
    expect(mechanism).toContain(`"${HANDSHAKE}.md"`)
    expect(mechanism).toContain(`"${SPIKING}.md"`)
    expect(mechanism).not.toMatch(/^domain:/m)
  })

  it("keeps also_from of the source page when the first source is ingested again", async () => {
    await ingest(HANDSHAKE)
    const copySlug = "async-handshake-circuits-copy"
    await writeWhitespaceCopy(HANDSHAKE, copySlug)
    await ingest(copySlug)
    const alsoFrom = new RegExp(`^also_from:\\n {2}- raw/sources/${copySlug}\\.md$`, "m")
    expect(await page(`wiki/sources/${HANDSHAKE}.md`)).toMatch(alsoFrom)

    // The first source is corrected and goes through the pipeline again: its summary page is rewritten.
    const original = await page(`raw/sources/${HANDSHAKE}.md`)
    await writeFileRaw(`${project}/raw/sources/${HANDSHAKE}.md`, `${original}\nOne more sentence about the handshake.\n`)
    seen.calls.length = 0
    await ingest(HANDSHAKE)

    expect(seen.calls.map((call) => call.kind)).toContain("generation")
    const summary = await page(`wiki/sources/${HANDSHAKE}.md`)
    expect(summary).toMatch(/^also_from: \["raw\/sources\/async-handshake-circuits-copy\.md"\]$/m)
  })
})
