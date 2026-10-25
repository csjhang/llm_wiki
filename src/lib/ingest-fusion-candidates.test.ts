/**
 * Fusion candidates in ingest.
 *
 * A reading wiki that writes a new mechanism page asks the model for fusion candidates and sends them to
 * review. The model is a fake with canned answers; the temp project, the prompts, the rules, the page writer,
 * and the review store are real. Candidate generation is an extra: it starts after the commit, does not hold
 * the ingest, and no failure of it may fail the ingest. Tests wait for it with `pendingFusionProposals()`.
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

/** What the fake model saw, and how it answers the call for candidates. */
const model = vi.hoisted(() => ({
  /** Every call, in order: its kind and its system prompt. */
  calls: [] as Array<{ kind: "analysis" | "generation" | "fusion" | "other"; system: string }>,
  /**
   * The answer to the call for candidates. An `Error` makes the stream report it; "throw" makes the call
   * reject; `hang` makes the call wait for ever.
   */
  fusionAnswer: "" as string | Error | "throw",
  hang: false,
  /** The signal that each call for candidates got. */
  signals: [] as Array<AbortSignal | undefined>,
  /** Called when the call for candidates arrives, to look at the project at that moment. */
  onFusion: null as null | (() => Promise<void>),
}))

vi.mock("./llm-client", () => ({
  streamChat: vi.fn(async (_config, messages, callbacks, signal) => {
    const system = String(messages?.[0]?.content ?? "")
    const record = (kind: "analysis" | "generation" | "fusion" | "other"): void => {
      model.calls.push({ kind, system })
    }

    if (system.startsWith("You find domains where a mechanism may also work")) {
      record("fusion")
      model.signals.push(signal)
      await model.onFusion?.()
      if (model.hang) await new Promise<never>(() => {})
      if (model.fusionAnswer === "throw") throw new Error("the connection broke")
      if (model.fusionAnswer instanceof Error) {
        callbacks.onError(model.fusionAnswer)
        return
      }
      callbacks.onToken(model.fusionAnswer)
      callbacks.onDone()
      return
    }

    const target = system.match(/source summary page at \*\*wiki\/sources\/([^*]+)\.md\*\*/)?.[1]
    if (target !== undefined) {
      record("generation")
      callbacks.onToken(GENERATIONS[target] ?? "")
      callbacks.onDone({ finishReason: "stop", truncated: false })
      return
    }

    if (system.startsWith("You are an expert research analyst")) {
      record("analysis")
      callbacks.onToken(ANALYSIS)
      callbacks.onDone()
      return
    }

    record("other")
    callbacks.onToken("")
    callbacks.onDone()
  }),
}))

vi.mock("./mineru", () => ({
  parseWithMineru: vi.fn(),
  parseWithMineruResult: vi.fn(),
}))

import { autoIngest, pendingFusionProposals } from "./ingest"

const MECHANISM_PATH = "wiki/mechanisms/event-driven-computation.md"
const FIRST = "first-source"
const SECOND = "second-source"

const ANALYSIS = [
  "## Key Entities",
  "- Request and acknowledge wires.",
  "",
  "## Decisions",
  "DOMAIN: hardware/async-circuits",
  "MECHANISM: new:event-driven-computation | A part does work only when an event reaches it.",
].join("\n")

function sourcePage(slug: string, domain: string): string {
  return [
    `---FILE: wiki/sources/${slug}.md---`,
    "---",
    "type: source",
    `title: "${slug}"`,
    `domain: ${domain}`,
    "source_kind: article",
    "tags: []",
    "related: []",
    `sources: ["${slug}.md"]`,
    "---",
    `# ${slug}`,
    "",
    "A short summary.",
    "---END FILE---",
  ].join("\n")
}

function mechanismPage(instanceLine: string): string {
  return [
    `---FILE: ${MECHANISM_PATH}---`,
    "---",
    "type: mechanism",
    'title: "Event-driven computation"',
    "lenses: [hardware]",
    "instances: [request-acknowledge-handshake]",
    "tags: []",
    "related: []",
    `sources: ["${FIRST}.md"]`,
    "---",
    "# Event-driven computation",
    "",
    "A part does work only when an event reaches it.",
    "",
    "## Parts",
    "",
    "- Event: a change of state that needs a reaction.",
    "",
    "## Flows",
    "",
    "- The sender signals an event to the receiver.",
    "",
    "## Constraints and trade-offs",
    "",
    "- A quiet system costs little, at the price of timing that depends on arrival.",
    "",
    "## Why it works",
    "",
    "Most of the time nothing changes.",
    "",
    "## Failure conditions",
    "",
    "- Events that arrive too densely cost more than a steady schedule would.",
    "",
    "## Known instances",
    "",
    instanceLine,
    "---END FILE---",
  ].join("\n")
}

const GENERATIONS: Record<string, string> = {
  // The first source writes the mechanism page. The second source only adds an instance line to it.
  [FIRST]: [
    sourcePage(FIRST, "hardware/async-circuits"),
    mechanismPage("- [[request-acknowledge-handshake]] (hardware/async-circuits): request/acknowledge"),
  ].join("\n"),
  [SECOND]: [
    sourcePage(SECOND, "hardware/async-circuits"),
    mechanismPage("- [[request-acknowledge-handshake]] (hardware/async-circuits): request/acknowledge"),
  ].join("\n"),
}

function candidateLine(domain: string, strength: string, reason: string): string {
  return `CANDIDATE: ${domain} | ${strength} | ${reason}`
}

describe("ingest and fusion candidates", () => {
  let tmp: { path: string; cleanup: () => Promise<void> }
  let project: string

  beforeEach(async () => {
    model.calls.length = 0
    model.fusionAnswer = ""
    model.hang = false
    model.signals.length = 0
    model.onFusion = null
    vi.spyOn(console, "warn").mockImplementation(() => {})
    tmp = await createTempProject("ingest-fusion")
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
    for (const slug of [FIRST, SECOND]) {
      await writeFileRaw(`${project}/raw/sources/${slug}.md`, `# ${slug}\n\nText of ${slug}, with words of its own.\n`)
    }
  })

  afterEach(async () => {
    vi.useRealTimers()
    vi.restoreAllMocks()
    await tmp.cleanup()
  })

  /** The ingest, as the queue calls it. The candidate step is not waited for. */
  function ingestOnly(
    slug: string,
    commit?: <T>(operation: () => Promise<T>) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<string[]> {
    return autoIngest(
      project,
      `${project}/raw/sources/${slug}.md`,
      { ...useWikiStore.getState().llmConfig },
      signal,
      undefined,
      undefined,
      commit === undefined ? undefined : { runCommit: commit },
    )
  }

  /** The ingest, then the candidate step that it started. */
  async function ingest(slug: string, commit?: <T>(operation: () => Promise<T>) => Promise<T>): Promise<string[]> {
    const written = await ingestOnly(slug, commit)
    await Promise.all(pendingFusionProposals())
    return written
  }

  const fusionCalls = () => model.calls.filter((call) => call.kind === "fusion")

  /**
   * Wait until the call for candidates has arrived. It polls with `setImmediate`, which the fake timers of a
   * test leave alone, so the clock of the test does not move while it waits.
   */
  async function untilFusionCall(): Promise<void> {
    // A real-time limit, because the reads before the call take as long as the machine needs.
    const limit = Date.now() + 4_000
    while (fusionCalls().length === 0 && Date.now() < limit) {
      await new Promise<void>((resolve) => setImmediate(resolve))
    }
    expect(fusionCalls()).toHaveLength(1)
  }

  it("sends one fusion-candidate review after an ingest that writes a new mechanism page", async () => {
    model.fusionAnswer = [
      candidateLine("hardware/async-circuits", "structural", "The source domain already has an instance."),
      candidateLine("business/franchising", "surface", "A franchisee acts when the brand sends a request."),
      candidateLine("ai/architecture", "structural", "A neuron works when a spike reaches it."),
    ].join("\n")

    const written = await ingest(FIRST)

    expect(written).toContain(MECHANISM_PATH)
    expect(fusionCalls()).toHaveLength(1)
    // The model sees the page that the ingest wrote, and the domain of the source counts as having an instance.
    expect(fusionCalls()[0].system).toContain("A part does work only when an event reaches it.")
    expect(fusionCalls()[0].system).toMatch(/already has an instance of this mechanism[^\n]*hardware\/async-circuits/)
    const items = useReviewStore.getState().items
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({
      type: "fusion-candidate",
      title: "Fusion candidates: Event-driven computation (event-driven-computation)",
      affectedPages: [MECHANISM_PATH],
      options: [
        { label: "Start fusion", action: "mech:start-fusion" },
        { label: "Skip", action: "mech:dismiss-fusion" },
      ],
    })
    expect(items[0].description.split("\n")).toEqual([
      "Domains where Event-driven computation may also work:",
      candidateLine("business/franchising", "surface", "A franchisee acts when the brand sends a request."),
      candidateLine("ai/architecture", "structural", "A neuron works when a spike reaches it."),
    ])
  })

  it("asks only after the commit of the ingest has finished, when the page is on disk", async () => {
    const events: string[] = []
    model.fusionAnswer = candidateLine("business/franchising", "surface", "A franchisee acts on a request.")
    model.onFusion = async () => {
      events.push("fusion")
      // The page is written by now.
      await fs.access(`${project}/${MECHANISM_PATH}`)
    }

    await ingest(FIRST, async (operation) => {
      events.push("commit:start")
      try {
        return await operation()
      } finally {
        events.push("commit:end")
      }
    })

    expect(events).toEqual(["commit:start", "commit:end", "fusion"])
    expect(useReviewStore.getState().items).toHaveLength(1)
  })

  it("sends no review when the model names no usable candidate", async () => {
    model.fusionAnswer = "NONE"

    const written = await ingest(FIRST)

    expect(written).toContain(MECHANISM_PATH)
    expect(fusionCalls()).toHaveLength(1)
    expect(useReviewStore.getState().items).toEqual([])
  })

  /** What a good ingest of the first source returns, with or without candidates. */
  const EXPECTED_PATHS = [`wiki/sources/${FIRST}.md`, MECHANISM_PATH, "wiki/index.md"]

  function expectIngestIntact(written: string[]): void {
    expect(written).toEqual(expect.arrayContaining(EXPECTED_PATHS))
    expect(fusionCalls()).toHaveLength(1)
    expect(useReviewStore.getState().items).toEqual([])
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining("[ingest:mechanism] Could not propose fusion candidates"),
      expect.anything(),
    )
    expect(useActivityStore.getState().items.find((item) => item.title === `${FIRST}.md`)?.status).toBe("done")
  }

  it("ingest still succeeds when candidate generation fails", async () => {
    model.fusionAnswer = new Error("provider down")

    expectIngestIntact(await ingest(FIRST))
  })

  it("ingest still succeeds when the call for candidates throws", async () => {
    model.fusionAnswer = "throw"

    expectIngestIntact(await ingest(FIRST))
  })

  it("sends no candidate for a new instance of a mechanism that already has its page", async () => {
    model.fusionAnswer = candidateLine("business/franchising", "surface", "A franchisee acts on a request.")
    await ingest(FIRST)
    expect(fusionCalls()).toHaveLength(1)
    useReviewStore.setState({ items: [] })
    model.calls.length = 0

    const written = await ingest(SECOND)

    expect(written).toContain(MECHANISM_PATH)
    expect(fusionCalls()).toEqual([])
    expect(useReviewStore.getState().items).toEqual([])
  })

  it("asks again for a new mechanism page of a later ingest", async () => {
    model.fusionAnswer = candidateLine("business/franchising", "surface", "A franchisee acts on a request.")
    await ingest(FIRST)
    // The user removed the page; the next ingest writes it as a new page.
    await fs.rm(`${project}/${MECHANISM_PATH}`)
    useReviewStore.setState({ items: [] })
    model.calls.length = 0

    await ingest(SECOND)

    expect(fusionCalls()).toHaveLength(1)
    expect(useReviewStore.getState().items).toHaveLength(1)
  })

  it("asks nothing in a wiki that is not a mechanism wiki", async () => {
    await fs.rm(`${project}/domains.yaml`)

    const written = await ingest(FIRST)

    expect(written).toContain(`wiki/sources/${FIRST}.md`)
    expect(fusionCalls()).toEqual([])
    expect(useReviewStore.getState().items).toEqual([])
  })

  it("asks nothing in a work wiki, which keeps no mechanism page", async () => {
    await writeFileRaw(`${project}/wiki.yaml`, "version: 1\nid: work\nrole: work\nmechanism_library: ../reading\n")

    await ingest(FIRST)

    await expect(fs.access(`${project}/${MECHANISM_PATH}`)).rejects.toThrow()
    expect(fusionCalls()).toEqual([])
    expect(useReviewStore.getState().items.filter((item) => item.type === "fusion-candidate")).toEqual([])
  })

  it("asks nothing when the ingest writes no mechanism page", async () => {
    // The model writes no page for this source, so the ingest keeps only its own summary page.
    await writeFileRaw(`${project}/raw/sources/plain-source.md`, "# Plain\n\nText of the plain source.\n")

    const written = await ingest("plain-source")

    expect(written).toContain("wiki/sources/plain-source.md")
    expect(written).not.toContain(MECHANISM_PATH)
    expect(fusionCalls()).toEqual([])
    expect(useReviewStore.getState().items).toEqual([])
  })

  describe("without holding the ingest", () => {
    const TIMEOUT_MS = 120_000

    beforeEach(() => {
      // Only the timers: the files of the temp project are read and written for real.
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
    })

    afterEach(async () => {
      // A step that is still waiting for a model that never answers ends at its timeout.
      await vi.advanceTimersByTimeAsync(TIMEOUT_MS)
      await Promise.all(pendingFusionProposals())
    })

    it("returns the result of the ingest while a model call that never answers is still waiting", async () => {
      model.hang = true

      const written = await ingestOnly(FIRST)

      expect(written).toEqual(expect.arrayContaining([`wiki/sources/${FIRST}.md`, MECHANISM_PATH]))
      expect(pendingFusionProposals()).toHaveLength(1)
      expect(useReviewStore.getState().items).toEqual([])
      expect(useActivityStore.getState().items.find((item) => item.title === `${FIRST}.md`)?.status).toBe("done")
    })

    it("ends the step with a logged timeout after 120 seconds, and its signal is aborted then", async () => {
      model.hang = true
      await ingestOnly(FIRST)
      await untilFusionCall()

      await vi.advanceTimersByTimeAsync(TIMEOUT_MS - 1)
      expect(pendingFusionProposals()).toHaveLength(1)
      expect(model.signals[0]?.aborted).toBe(false)

      await vi.advanceTimersByTimeAsync(1)
      await Promise.all(pendingFusionProposals())

      expect(model.signals[0]?.aborted).toBe(true)
      expect(pendingFusionProposals()).toHaveLength(0)
      expect(useReviewStore.getState().items).toEqual([])
      expect(console.warn).toHaveBeenCalledWith(
        expect.stringContaining("[ingest:mechanism] Fusion candidates for wiki/mechanisms/event-driven-computation.md timed out after 120 s"),
      )
    })

    it("does not stop the step when the task of the ingest is cancelled after the ingest returned", async () => {
      model.hang = true
      const cancel = new AbortController()
      await ingestOnly(FIRST, undefined, cancel.signal)
      await untilFusionCall()

      cancel.abort()
      await vi.advanceTimersByTimeAsync(1_000)

      // Its own signal: the cancel of the task does not reach it, and the ingest result is not touched.
      expect(model.signals[0]).not.toBe(cancel.signal)
      expect(model.signals[0]?.aborted).toBe(false)
      expect(pendingFusionProposals()).toHaveLength(1)
    })

    it("does not ask the model when the ingest was cancelled before the step started", async () => {
      model.fusionAnswer = candidateLine("business/franchising", "surface", "A franchisee acts on a request.")
      const cancel = new AbortController()

      // The cancel arrives as the commit ends, after the last check of the ingest.
      const written = await ingestOnly(FIRST, async (operation) => {
        const result = await operation()
        cancel.abort()
        return result
      }, cancel.signal)
      await Promise.all(pendingFusionProposals())

      expect(written).toContain(MECHANISM_PATH)
      expect(fusionCalls()).toEqual([])
      expect(useReviewStore.getState().items).toEqual([])
    })

    it("lists no step once it has finished", async () => {
      model.fusionAnswer = "NONE"

      await ingest(FIRST)

      expect(pendingFusionProposals()).toEqual([])
    })
  })
})
