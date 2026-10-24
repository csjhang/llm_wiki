/**
 * Ingest prompts of mechanism wikis and plain wikis.
 *
 * A project with `domains.yaml` is a mechanism wiki and gets the domain and
 * mechanism sections in its analysis, chunk analysis, and generation prompts.
 * A project without it must see the same prompts as upstream. The same file
 * checks what ingest writes from the generation: a mechanism wiki gets its
 * rules enforced on the pages, and a plain wiki gets its blocks unchanged.
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

/**
 * What the mocked model answers for the analysis, for the digest of a chunk, and in the generation
 * after the source summary (`generation`) and in a repair of a truncated block (`repair`). Tests change it.
 */
const DEFAULT_ANALYSIS = "## Analysis\nA short analysis."
const DEFAULT_DIGEST = "A digest."
const llm = vi.hoisted(() => ({ analysis: "", digest: "", generation: "", repair: "" }))

vi.mock("./llm-client", () => ({
  streamChat: vi.fn(async (_cfg, messages, cb) => {
    const systemPrompt = String(messages?.[0]?.content ?? "")

    if (systemPrompt.startsWith("You are analyzing a long source document")) {
      cb.onToken(`## Chunk Analysis\nA chunk.\n\n## Updated Global Digest\n${llm.digest}`)
      cb.onDone()
      return
    }

    if (systemPrompt.startsWith("You are repairing truncated wiki FILE blocks")) {
      cb.onToken(llm.repair)
      cb.onDone({ finishReason: "stop", truncated: false })
      return
    }

    const target = systemPrompt.match(/source summary page at \*\*(wiki\/sources\/[^*]+)\*\*/)?.[1]
    if (!target) {
      // Analysis, and anything else that is not generation.
      cb.onToken(llm.analysis)
      cb.onDone()
      return
    }
    cb.onToken([
      `---FILE: ${target}---`,
      "---",
      'title: "Source"',
      "---",
      "",
      "# Source",
      "---END FILE---",
      ...(llm.generation === "" ? [] : [llm.generation]),
    ].join("\n"))
    cb.onDone({ finishReason: "stop", truncated: false })
  }),
}))

vi.mock("./mineru", () => ({
  parseWithMineru: vi.fn(),
  parseWithMineruResult: vi.fn(),
}))

import {
  autoIngest,
  buildAnalysisPrompt,
  buildChunkAnalysisSystemPrompt,
  buildGenerationPrompt,
  computeIngestSourceBudget,
  updateBoundedRecentIndexSection,
} from "./ingest"
import { streamChat } from "./llm-client"
import { buildAnalysisAddendum, buildGenerationAddendum, prepareMechanismPrompts } from "./mechanism-wiki/prompts"
import { loadMechanismContext } from "./mechanism-wiki/context"
import type { MechanismContext } from "./mechanism-wiki/context"
import { parseAnalysisDecisions } from "./mechanism-wiki/decisions"
import { buildScopedIndexText, rebuildDomainIndex } from "./mechanism-wiki/domain-index"
import { emptyDecisions } from "./mechanism-wiki/types"
import { sourceSummarySlugFromIdentity } from "./source-identity"

const mockStreamChat = vi.mocked(streamChat)

const PURPOSE = "# Purpose\n\nTrack how things work.\n"
const INDEX = "# Index\n\n- [[existing-page]]\n"
const OVERVIEW = "# Overview\n"
const PLAIN_SCHEMA = "# Schema\n\n## Page Types\n| goal | wiki/goals/ | Outcomes |\n"
const SOURCE_PATH = "raw/sources/note.md"
const SOURCE_TEXT = "# A note\n\nWork happens only when an event arrives.\n"

interface Captured {
  system: string
  user: string
}

/** System and user prompts of every streamChat call, in call order. */
function capturedCalls(): Captured[] {
  return mockStreamChat.mock.calls.map(([, messages]) => ({
    system: String(messages?.[0]?.content ?? ""),
    user: String(messages?.[1]?.content ?? ""),
  }))
}

function isGeneration(call: Captured): boolean {
  return call.system.includes("Based on the analysis provided, generate wiki files")
}

function isChunk(call: Captured): boolean {
  return call.system.startsWith("You are analyzing a long source document")
}

function isAnalysis(call: Captured): boolean {
  return call.system.startsWith("You are an expert research analyst")
}

describe("ingest prompts and the mechanism context", () => {
  let tmp: { path: string; cleanup: () => Promise<void> } | undefined

  beforeEach(async () => {
    mockStreamChat.mockClear()
    // The hook warns about decision problems; keep test output clean.
    vi.spyOn(console, "warn").mockImplementation(() => {})
    llm.analysis = DEFAULT_ANALYSIS
    llm.digest = DEFAULT_DIGEST
    llm.generation = ""
    llm.repair = ""
    tmp = await createTempProject("mechanism-prompts")
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
      project: { id: "p", name: "p", path: tmp.path },
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
    vi.mocked(console.warn).mockRestore()
    await tmp?.cleanup()
    tmp = undefined
  })

  /** A project with no `domains.yaml`. */
  async function plainProject(sourceText = SOURCE_TEXT): Promise<string> {
    if (!tmp) throw new Error("missing temp project")
    await writeFileRaw(`${tmp.path}/purpose.md`, PURPOSE)
    await writeFileRaw(`${tmp.path}/schema.md`, PLAIN_SCHEMA)
    await writeFileRaw(`${tmp.path}/wiki/index.md`, INDEX)
    await writeFileRaw(`${tmp.path}/wiki/overview.md`, OVERVIEW)
    await writeFileRaw(`${tmp.path}/${SOURCE_PATH}`, sourceText)
    return tmp.path
  }

  /** The sample mechanism wiki, with a source added. */
  async function mechanismProject(sourceText = SOURCE_TEXT, wikiYaml?: string): Promise<string> {
    if (!tmp) throw new Error("missing temp project")
    await materializeSampleWiki(tmp.path)
    await writeFileRaw(`${tmp.path}/wiki/index.md`, INDEX)
    await writeFileRaw(`${tmp.path}/wiki/overview.md`, OVERVIEW)
    await writeFileRaw(`${tmp.path}/${SOURCE_PATH}`, sourceText)
    if (wikiYaml !== undefined) await writeFileRaw(`${tmp.path}/wiki.yaml`, wikiYaml)
    return tmp.path
  }

  /** The mechanism context of a project, and the index text that a mechanism wiki sends for a source without a domain hint. */
  async function mechanismIndex(project: string): Promise<{ ctx: MechanismContext; index: string }> {
    const ctx = await loadMechanismContext(project)
    if (!ctx) throw new Error("expected a mechanism context")
    return { ctx, index: await buildScopedIndexText(project, ctx, null) }
  }

  async function ingest(project: string, options: { maxContextSize?: number } = {}): Promise<void> {
    const llmConfig = { ...useWikiStore.getState().llmConfig }
    if (options.maxContextSize !== undefined) llmConfig.maxContextSize = options.maxContextSize
    await autoIngest(project, `${project}/${SOURCE_PATH}`, llmConfig)
  }

  /**
   * The upstream prompts for the project as it is now. Call this before `ingest`, which rewrites the index.
   * `indexText` is the index that the prompts carry: the file `wiki/index.md` unless a mechanism wiki says otherwise.
   */
  async function expectedPrompts(project: string, sourceText: string, indexText?: string): Promise<{
    analysis: string
    generation: string
  }> {
    const schema = await fs.readFile(`${project}/schema.md`, "utf8")
    const purpose = await fs.readFile(`${project}/purpose.md`, "utf8")
    const index = indexText ?? await fs.readFile(`${project}/wiki/index.md`, "utf8")
    const overview = await fs.readFile(`${project}/wiki/overview.md`, "utf8")
    const slug = sourceSummarySlugFromIdentity("note.md")
    return {
      analysis: buildAnalysisPrompt(purpose, index, sourceText, schema),
      generation: buildGenerationPrompt(
        schema,
        purpose,
        index,
        "note.md",
        overview,
        sourceText,
        `wiki/sources/${slug}.md`,
      ),
    }
  }

  it("upstream prompts unchanged", async () => {
    const project = await plainProject()
    const expected = await expectedPrompts(project, SOURCE_TEXT)
    await ingest(project)

    const calls = capturedCalls()
    const [first, second] = calls
    expect(isAnalysis(first)).toBe(true)
    expect(first.system).toBe(expected.analysis)
    expect(isGeneration(second)).toBe(true)
    expect(second.system).toBe(expected.generation)
    for (const call of calls) {
      expect(call.system).not.toContain("Mechanism Wiki")
      expect(call.system).not.toContain("## Decisions")
    }
  })

  it("lists only the upstream types in a plain wiki", async () => {
    const project = await plainProject()
    await ingest(project)

    const generation = capturedCalls().find(isGeneration)
    expect(generation?.system).toContain(
      "one of the known types (source | entity | concept | comparison | query | synthesis | thesis | methodology | finding)",
    )
    expect(generation?.system).not.toContain("hypothesis")
  })

  it("upstream chunk analysis prompt unchanged", async () => {
    const longSource = ["# One", "A".repeat(9000), "## Two", "B".repeat(9000), "## Three", "C".repeat(9000)].join("\n\n")
    const project = await plainProject(longSource)
    const schema = await fs.readFile(`${project}/schema.md`, "utf8")
    await ingest(project, { maxContextSize: 20_000 })

    const chunks = capturedCalls().filter(isChunk)
    expect(chunks.length).toBeGreaterThan(1)
    expect(chunks[0].system).toBe(buildChunkAnalysisSystemPrompt(PURPOSE, schema, INDEX, longSource))
  })

  it("appends the analysis addendum in a mechanism wiki", async () => {
    const project = await mechanismProject()
    const { ctx, index } = await mechanismIndex(project)
    const expected = await expectedPrompts(project, SOURCE_TEXT, index)
    await ingest(project)

    const calls = capturedCalls()
    // The same two calls in the same order as in a plain wiki.
    expect(isAnalysis(calls[0])).toBe(true)
    expect(isGeneration(calls[1])).toBe(true)
    const analysis = calls[0]
    expect(analysis?.system).toBe(`${expected.analysis}\n\n${buildAnalysisAddendum(ctx, null)}`)
    expect(analysis?.system).toContain("## Decisions")
    expect(analysis?.system).toContain("hardware/async-circuits")
  })

  it("appends the generation addendum in a mechanism wiki", async () => {
    const project = await mechanismProject()
    const { ctx, index } = await mechanismIndex(project)
    const expected = await expectedPrompts(project, SOURCE_TEXT, index)
    await ingest(project)

    const generation = capturedCalls().find(isGeneration)
    // The default analysis has no Decisions section, so the decisions are the empty ones plus that problem.
    const decisions = parseAnalysisDecisions(DEFAULT_ANALYSIS, ctx, null, new Set())
    expect(decisions).toEqual({ ...emptyDecisions(null), problems: [expect.stringMatching(/no Decisions section/i)] })
    expect(generation?.system).toBe(
      `${expected.generation}\n\n${buildGenerationAddendum(ctx, decisions, "English")}`,
    )
    expect(generation?.system).toMatch(/`mechanism` and `hypothesis` are also known types/)
    expect(generation?.system).not.toContain("known types (source | entity | concept | comparison | query | synthesis | thesis | methodology | finding | mechanism")
  })

  it("uses the frontmatter domain as the lens hint and as the chosen domain", async () => {
    const source = "---\ndomain: ai/architecture\n---\n\n# A note\n\nA network of spikes.\n"
    const project = await mechanismProject(source)
    await ingest(project)

    const ctx = await loadMechanismContext(project)
    if (!ctx) throw new Error("expected a mechanism context")
    const calls = capturedCalls()
    const analysis = calls.find(isAnalysis)
    expect(analysis?.system).toContain(ctx.lenses.ai.promptText)
    expect(analysis?.system).not.toContain(ctx.lenses.hardware.promptText)
    const generation = calls.find(isGeneration)
    expect(generation?.system).toContain("domain: ai/architecture")
  })

  it("puts the decisions of the analysis in the generation prompt", async () => {
    llm.analysis = [
      "## Analysis",
      "Work happens only when an event arrives.",
      "",
      "## Decisions",
      "DOMAIN: ai/architecture",
      "MECHANISM: existing:event-driven-computing | Work happens only when an event arrives",
      "MECHANISM: new:backpressure | A slow consumer slows the producer",
    ].join("\n")
    const project = await mechanismProject()
    await writeFileRaw(`${project}/wiki/mechanisms/event-driven-computing.md`, "---\ntype: mechanism\n---\n\n# Event-driven computing\n")
    const { ctx, index } = await mechanismIndex(project)
    const expected = await expectedPrompts(project, SOURCE_TEXT, index)
    await ingest(project)

    const generation = capturedCalls().find(isGeneration)
    expect(generation?.system).toBe(
      `${expected.generation}\n\n${buildGenerationAddendum(
        ctx,
        {
          domain: "ai/architecture",
          proposedDomain: null,
          mechanisms: [
            { kind: "existing", slug: "event-driven-computing", summary: "Work happens only when an event arrives" },
            { kind: "new", slug: "backpressure", summary: "A slow consumer slows the producer" },
          ],
          problems: [],
        },
        "English",
      )}`,
    )
    expect(generation?.system).toContain("domain: ai/architecture")
    expect(generation?.system).toContain("update wiki/mechanisms/event-driven-computing.md")
    expect(generation?.system).toContain("write wiki/mechanisms/backpressure.md as a new mechanism page")
    expect(generation?.system).not.toContain("were invalid and were dropped")
  })

  it("writes an existing mechanism that is not in the library as a new one", async () => {
    llm.analysis = "## Decisions\nDOMAIN: ai/architecture\nMECHANISM: existing:ghost-mechanism | Not in the library\n"
    const project = await mechanismProject()
    await ingest(project)

    const generation = capturedCalls().find(isGeneration)
    expect(generation?.system).toContain("write wiki/mechanisms/ghost-mechanism.md as a new mechanism page")
    expect(generation?.system).not.toContain("update wiki/mechanisms/ghost-mechanism.md")
  })

  it("keeps the valid lines and says that the others were dropped", async () => {
    llm.analysis = [
      "## Decisions",
      "DOMAIN: ai/architecture",
      "MECHANISM: new:Not Kebab Case | Bad slug",
      "MECHANISM: new:backpressure | A slow consumer slows the producer",
    ].join("\n")
    const project = await mechanismProject()
    await ingest(project)

    const generation = capturedCalls().find(isGeneration)
    expect(generation?.system).toContain("wiki/mechanisms/backpressure.md")
    expect(generation?.system).not.toContain("Not Kebab Case")
    expect(generation?.system).toContain(
      "Some analysis decision lines were invalid and were dropped. Write or update mechanism pages only for the lines listed here.",
    )
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining("[ingest:mechanism] decision problems"),
      expect.anything(),
    )
  })

  it("tells the generation prompt about a proposed domain", async () => {
    llm.analysis = "## Decisions\nNEW-DOMAIN: cognition/attention | ai | How attention works\n"
    const project = await mechanismProject()
    await ingest(project)

    const generation = capturedCalls().find(isGeneration)
    expect(generation?.system).toContain("domain: cognition/attention")
    expect(generation?.system).toContain("proposes the new domain `cognition/attention`")
  })

  it("reads the decisions from the head of the digest of a long source", async () => {
    llm.digest = [
      "### Decisions",
      "DOMAIN: ai/architecture",
      "MECHANISM: new:backpressure | A slow consumer slows the producer",
      "",
      "### Summary",
      "A long document.",
    ].join("\n")
    const longSource = ["# One", "A".repeat(9000), "## Two", "B".repeat(9000), "## Three", "C".repeat(9000)].join("\n\n")
    const project = await mechanismProject(longSource)
    await ingest(project, { maxContextSize: 20_000 })

    const calls = capturedCalls()
    expect(calls.filter(isChunk).length).toBeGreaterThan(1)
    const generation = calls.find(isGeneration)
    expect(generation?.system).toContain("domain: ai/architecture")
    expect(generation?.system).toContain("write wiki/mechanisms/backpressure.md as a new mechanism page")
  })

  it("tells a work wiki not to write mechanism files", async () => {
    const workYaml = "version: 1\nid: work\nrole: work\nmechanism_library: ../reading\n"
    const project = await mechanismProject(SOURCE_TEXT, workYaml)
    await ingest(project)

    const generation = capturedCalls().find(isGeneration)
    expect(generation?.system).toContain("do not write wiki/mechanisms/ files")
    expect(generation?.system).toContain("REVIEW block of type new-mechanism")
  })

  it("adds the chunk addendum to long-source analysis in a mechanism wiki", async () => {
    const longSource = ["# One", "A".repeat(9000), "## Two", "B".repeat(9000), "## Three", "C".repeat(9000)].join("\n\n")
    const project = await mechanismProject(longSource)
    const { ctx, index } = await mechanismIndex(project)
    const schema = await fs.readFile(`${project}/schema.md`, "utf8")
    const purpose = await fs.readFile(`${project}/purpose.md`, "utf8")
    await ingest(project, { maxContextSize: 20_000 })

    const chunks = capturedCalls().filter(isChunk)
    expect(chunks.length).toBeGreaterThan(1)
    expect(chunks[0].system).toBe(
      `${buildChunkAnalysisSystemPrompt(purpose, schema, index, longSource)}\n\n${buildAnalysisAddendum(ctx, null, { chunked: true })}`,
    )
  })

  /** Stable context length of a mechanism wiki, the way ingest counts it, for an index text of `indexLength` characters. */
  async function mechanismStableLength(project: string, ctx: MechanismContext, indexLength: number): Promise<number> {
    const read = (name: string) => fs.readFile(`${project}/${name}`, "utf8")
    const [schema, purpose, overview] = await Promise.all([read("schema.md"), read("purpose.md"), read("wiki/overview.md")])
    const reserved = (await prepareMechanismPrompts(ctx, "", "English")).reservedChars
    return schema.length + purpose.length + indexLength + overview.length + reserved
  }

  /** A source of `size` characters in paragraphs, so that the chunker can cut it. */
  function sourceOfSize(size: number): string {
    const paragraph = `${"A".repeat(1_999)}\n\n`
    return paragraph.repeat(Math.ceil(size / paragraph.length)).slice(0, size)
  }

  it("counts the mechanism addenda as stable context when it sizes the source budget", async () => {
    const maxContextSize = 100_000
    const project = await mechanismProject()
    const { ctx, index } = await mechanismIndex(project)
    const withAddenda = await mechanismStableLength(project, ctx, index.length)
    const reserved = (await prepareMechanismPrompts(ctx, "", "English")).reservedChars
    const plainStable = withAddenda - reserved
    const budgetWithout = computeIngestSourceBudget(maxContextSize, plainStable)
    const budgetWith = computeIngestSourceBudget(maxContextSize, withAddenda)
    // The addenda must make a difference for this test to mean anything.
    expect(budgetWith).toBeLessThan(budgetWithout)

    // A source that fits the plain budget but not the budget with the addenda.
    await writeFileRaw(`${project}/${SOURCE_PATH}`, sourceOfSize(Math.floor((budgetWith + budgetWithout) / 2)))
    await ingest(project, { maxContextSize })

    expect(capturedCalls().filter(isChunk).length).toBeGreaterThan(1)
  })

  it("counts the scoped index that it sends, not the length of wiki/index.md, when it sizes the source budget", async () => {
    const maxContextSize = 200_000
    const project = await mechanismProject()
    // A long file on disk that the prompts do not carry: they carry the scoped index.
    const stale = `# Index\n\n${"- [[stale-page]] — a line of an index that nobody reads any more\n".repeat(900)}`
    await writeFileRaw(`${project}/wiki/index.md`, stale)
    const { ctx, index } = await mechanismIndex(project)
    expect(stale.length).toBeGreaterThan(index.length + 30_000)
    const budgetScoped = computeIngestSourceBudget(maxContextSize, await mechanismStableLength(project, ctx, index.length))
    const budgetStale = computeIngestSourceBudget(maxContextSize, await mechanismStableLength(project, ctx, stale.length))
    expect(budgetScoped).toBeGreaterThan(budgetStale)

    // A source that fits the budget of the scoped index but not the budget of the long file.
    await writeFileRaw(`${project}/${SOURCE_PATH}`, sourceOfSize(Math.floor((budgetScoped + budgetStale) / 2)))
    await ingest(project, { maxContextSize })

    expect(capturedCalls().filter(isChunk)).toHaveLength(0)
  })

  it("carries the scoped index in the prompts of a mechanism wiki", async () => {
    const source = "---\ndomain: ai/architecture\n---\n\n# A note\n\nA network of spikes.\n"
    const project = await mechanismProject(source)
    await writeFileRaw(
      `${project}/wiki/concepts/spikes.md`,
      "---\ntype: concept\ntitle: Spikes\ndomain: ai/architecture\n---\n\n# Spikes\n",
    )
    await writeFileRaw(
      `${project}/wiki/concepts/handshake.md`,
      "---\ntype: concept\ntitle: Handshake\ndomain: hardware/async-circuits\n---\n\n# Handshake\n",
    )
    await writeFileRaw(
      `${project}/wiki/mechanisms/event-driven-computing.md`,
      "---\ntype: mechanism\ntitle: Event-driven computing\n---\n\n# Event-driven computing\n",
    )
    await ingest(project)

    for (const call of capturedCalls().filter((candidate) => isAnalysis(candidate) || isGeneration(candidate))) {
      expect(call.system).toContain("# Wiki Index")
      expect(call.system).toContain("- [ai/architecture](indexes/ai--architecture.md) — 1 pages")
      expect(call.system).toContain("- [[event-driven-computing]] — Event-driven computing")
      // The hinted domain is listed. The pages of the other domains are not.
      expect(call.system).toContain("# ai/architecture\n\n## Concept\n\n- [[spikes]] — Spikes")
      expect(call.system).not.toContain("[[handshake]]")
      // The old index text is gone.
      expect(call.system).not.toContain("existing-page")
    }
  })

  // --- what ingest writes from the generation -----------------------------

  /** A concept page the way a model writes it when it forgets the domain. */
  const CONCEPT_WITHOUT_DOMAIN = [
    "---FILE: wiki/concepts/attention.md---",
    "---",
    "type: concept",
    "title: Attention",
    "tags: []",
    'sources: ["note.md"]',
    "---",
    "# Attention",
    "",
    "Attention weighs the parts of an input.",
    "---END FILE---",
  ].join("\n")

  const MECHANISM_PAGE = [
    "---FILE: wiki/mechanisms/backpressure.md---",
    "---",
    "type: mechanism",
    "title: Backpressure",
    "domain: ai/architecture",
    "tags: []",
    "---",
    "# Backpressure",
    "",
    "A slow consumer slows the producer.",
    "---END FILE---",
  ].join("\n")

  const NEW_MECHANISM_REVIEW = [
    "---REVIEW: new-mechanism | Flow control---",
    "A receiver limits how fast a sender may send.",
    "PAGES: wiki/concepts/attention.md",
    "---END REVIEW---",
  ].join("\n")

  const WORK_YAML = "version: 1\nid: work\nrole: work\nmechanism_library: ../reading\n"

  function reviewSummary(): Array<[string, string]> {
    return useReviewStore.getState().items.map((item) => [item.type, item.title])
  }

  it("writes a generated concept page with the decided domain", async () => {
    llm.analysis = "## Decisions\nDOMAIN: ai/architecture\n"
    llm.generation = CONCEPT_WITHOUT_DOMAIN
    const project = await mechanismProject()
    await ingest(project)

    const page = await fs.readFile(`${project}/wiki/concepts/attention.md`, "utf8")
    expect(page).toMatch(/^domain: ai\/architecture$/m)
    expect(page).toContain("Attention weighs the parts of an input.")
  })

  it("writes the proposed domain on the pages and queues a new-domain review", async () => {
    llm.analysis = "## Decisions\nNEW-DOMAIN: cognition/attention | ai | How attention works\n"
    llm.generation = CONCEPT_WITHOUT_DOMAIN
    const project = await mechanismProject()
    await ingest(project)

    const page = await fs.readFile(`${project}/wiki/concepts/attention.md`, "utf8")
    expect(page).toMatch(/^domain: cognition\/attention$/m)
    expect(reviewSummary()).toEqual([["new-domain", "New domain: cognition/attention"]])
    const [review] = useReviewStore.getState().items
    expect(review.options.map((option) => option.action)).toEqual(["mech:approve-domain", "Skip"])
    expect(review.description).toContain("PROPOSAL: cognition/attention | ai | How attention works")
  })

  it("keeps a mechanism page of a reading wiki without domain and with lenses", async () => {
    llm.analysis = "## Decisions\nDOMAIN: ai/architecture\n"
    llm.generation = MECHANISM_PAGE
    const project = await mechanismProject()
    await ingest(project)

    const page = await fs.readFile(`${project}/wiki/mechanisms/backpressure.md`, "utf8")
    expect(page).not.toMatch(/^domain:/m)
    expect(page).toMatch(/^lenses: \[ai\]$/m)
    expect(page).toMatch(/^instances: \[\]$/m)
  })

  it("sends the mechanism pages of a work wiki to review instead of writing them", async () => {
    llm.analysis = "## Decisions\nDOMAIN: ai/architecture\n"
    llm.generation = [CONCEPT_WITHOUT_DOMAIN, MECHANISM_PAGE, NEW_MECHANISM_REVIEW].join("\n\n")
    const project = await mechanismProject(SOURCE_TEXT, WORK_YAML)
    await ingest(project)

    await expect(fs.access(`${project}/wiki/mechanisms/backpressure.md`)).rejects.toThrow()
    expect(await fs.readFile(`${project}/wiki/concepts/attention.md`, "utf8")).toMatch(/^domain: ai\/architecture$/m)
    expect(reviewSummary().sort()).toEqual([
      ["new-mechanism", "Backpressure"],
      ["new-mechanism", "Flow control"],
    ])
    for (const review of useReviewStore.getState().items) {
      expect(review.options.map((option) => option.action)).toEqual(["mech:propose-mechanism", "Skip"])
    }
  })

  it("applies the rules to a page that the truncation repair writes", async () => {
    llm.analysis = "## Decisions\nDOMAIN: ai/architecture\n"
    llm.generation = CONCEPT_WITHOUT_DOMAIN.replace("\n---END FILE---", "")
    llm.repair = CONCEPT_WITHOUT_DOMAIN
    const project = await mechanismProject()
    await ingest(project)

    expect(mockStreamChat.mock.calls.some(([, messages]) =>
      String(messages?.[0]?.content ?? "").startsWith("You are repairing truncated wiki FILE blocks"),
    )).toBe(true)
    const page = await fs.readFile(`${project}/wiki/concepts/attention.md`, "utf8")
    expect(page).toMatch(/^domain: ai\/architecture$/m)
  })

  it("queues the new-domain review once when a repair pass runs", async () => {
    llm.analysis = "## Decisions\nNEW-DOMAIN: cognition/attention | ai | How attention works\n"
    llm.generation = CONCEPT_WITHOUT_DOMAIN.replace("\n---END FILE---", "")
    llm.repair = CONCEPT_WITHOUT_DOMAIN
    const project = await mechanismProject()
    // The store merges items with the same id; count what ingest hands to it instead.
    const realAddItems = useReviewStore.getState().addItems
    const addItems = vi.fn(realAddItems)
    useReviewStore.setState({ addItems })
    try {
      await ingest(project)
    } finally {
      useReviewStore.setState({ addItems: realAddItems })
    }

    expect(mockStreamChat.mock.calls.some(([, messages]) =>
      String(messages?.[0]?.content ?? "").startsWith("You are repairing truncated wiki FILE blocks"),
    )).toBe(true)
    const queued = addItems.mock.calls.flatMap(([items]) => items)
    expect(queued.filter((item) => item.type === "new-domain")).toHaveLength(1)
    expect(await fs.readFile(`${project}/wiki/concepts/attention.md`, "utf8")).toMatch(/^domain: cognition\/attention$/m)
  })

  it("sends a type: mechanism page of a work wiki to review wherever the model put it", async () => {
    llm.analysis = "## Decisions\nDOMAIN: ai/architecture\n"
    llm.generation = MECHANISM_PAGE.replace("wiki/mechanisms/backpressure.md", "wiki/concepts/backpressure.md")
    const project = await mechanismProject(SOURCE_TEXT, WORK_YAML)
    await ingest(project)

    await expect(fs.access(`${project}/wiki/concepts/backpressure.md`)).rejects.toThrow()
    await expect(fs.access(`${project}/wiki/mechanisms/backpressure.md`)).rejects.toThrow()
    expect(reviewSummary()).toEqual([["new-mechanism", "Backpressure"]])
  })

  it("writes the FILE blocks of a plain wiki unchanged", async () => {
    llm.generation = [CONCEPT_WITHOUT_DOMAIN, MECHANISM_PAGE, NEW_MECHANISM_REVIEW].join("\n\n")
    const project = await plainProject()
    await ingest(project)

    expect(await fs.readFile(`${project}/wiki/concepts/attention.md`, "utf8")).not.toMatch(/^domain:/m)
    // Upstream writes a page under wiki/mechanisms/ like any other, with its own domain line.
    expect(await fs.readFile(`${project}/wiki/mechanisms/backpressure.md`, "utf8")).toMatch(/^domain: ai\/architecture$/m)
    // Upstream reads a REVIEW block of an unknown type as a confirm item.
    expect(reviewSummary()).toEqual([["confirm", "Flow control"]])
  })

  // --- the index that ingest writes -----------------------------------------

  /** Run an ingest with the tracking callback that the queue passes. Gives what it reported and what it returned. */
  async function ingestTracked(project: string): Promise<{ reported: string[]; returned: string[] }> {
    const reported: string[] = []
    const returned = await autoIngest(
      project,
      `${project}/${SOURCE_PATH}`,
      { ...useWikiStore.getState().llmConfig },
      undefined,
      undefined,
      (relativePath) => reported.push(relativePath),
    )
    return { reported, returned }
  }

  it("non-mechanism project keeps old index", async () => {
    const project = await plainProject()
    const { reported } = await ingestTracked(project)

    const slug = sourceSummarySlugFromIdentity("note.md")
    expect(await fs.readFile(`${project}/wiki/index.md`, "utf8")).toBe(
      updateBoundedRecentIndexSection(INDEX, [`- [[sources/${slug}]] — Source`]),
    )
    expect(reported).toContain("wiki/index.md")
    await expect(fs.access(`${project}/wiki/indexes`)).rejects.toThrow()
    expect(reported.some((path) => path.startsWith("wiki/indexes/"))).toBe(false)
  })

  it("builds the domain-first index in a mechanism wiki", async () => {
    llm.analysis = "## Decisions\nDOMAIN: ai/architecture\n"
    llm.generation = CONCEPT_WITHOUT_DOMAIN
    const project = await mechanismProject()
    await ingest(project)

    const slug = sourceSummarySlugFromIdentity("note.md")
    expect(await fs.readFile(`${project}/wiki/index.md`, "utf8")).toBe(
      [
        "# Wiki Index",
        "",
        "- [ai/architecture](indexes/ai--architecture.md) — 2 pages",
        "- [business/franchising](indexes/business--franchising.md) — 0 pages",
        "- [hardware/async-circuits](indexes/hardware--async-circuits.md) — 0 pages",
        "- [Mechanisms](indexes/_mechanisms.md) — 0 pages",
        "- Unassigned — 0 pages",
        "",
      ].join("\n"),
    )
    expect(await fs.readFile(`${project}/wiki/indexes/ai--architecture.md`, "utf8")).toBe(
      [
        "# ai/architecture",
        "",
        "## Source",
        "",
        `- [[${slug}]] — Source`,
        "",
        "## Concept",
        "",
        "- [[attention]] — Attention",
        "",
      ].join("\n"),
    )
    // The upstream "Recently Updated" list is not used in a mechanism wiki.
    expect(await fs.readFile(`${project}/wiki/index.md`, "utf8")).not.toContain("Recently Updated")
  })

  it("index writes are reported as written files", async () => {
    llm.analysis = "## Decisions\nDOMAIN: ai/architecture\n"
    llm.generation = CONCEPT_WITHOUT_DOMAIN
    const project = await mechanismProject()
    const { reported, returned } = await ingestTracked(project)

    const indexFiles = [
      "wiki/index.md",
      "wiki/indexes/_mechanisms.md",
      "wiki/indexes/ai--architecture.md",
      "wiki/indexes/business--franchising.md",
      "wiki/indexes/hardware--async-circuits.md",
    ]
    for (const file of indexFiles) {
      expect(reported).toContain(file)
      expect(returned).toContain(file)
      // Each file is reported once.
      expect(reported.filter((path) => path === file)).toHaveLength(1)
    }
  })

  it("reports only the index files that changed", async () => {
    llm.analysis = "## Decisions\nDOMAIN: ai/architecture\n"
    llm.generation = CONCEPT_WITHOUT_DOMAIN
    const project = await mechanismProject()
    // The index of the domains that this ingest does not touch is there already.
    const ctx = await loadMechanismContext(project)
    if (!ctx) throw new Error("expected a mechanism context")
    await rebuildDomainIndex(project, ctx)
    const { reported } = await ingestTracked(project)

    expect(reported).toContain("wiki/index.md")
    expect(reported).toContain("wiki/indexes/ai--architecture.md")
    expect(reported).not.toContain("wiki/indexes/business--franchising.md")
    expect(reported).not.toContain("wiki/indexes/hardware--async-circuits.md")
    expect(reported).not.toContain("wiki/indexes/_mechanisms.md")
  })

  it("keeps the index files out of the overview and out of the model's reach", async () => {
    llm.analysis = "## Decisions\nDOMAIN: ai/architecture\n"
    llm.generation = [
      CONCEPT_WITHOUT_DOMAIN,
      ["---FILE: wiki/indexes/ai--architecture.md---", "# Model index", "---END FILE---"].join("\n"),
    ].join("\n\n")
    const project = await mechanismProject()
    await ingest(project)

    expect(await fs.readFile(`${project}/wiki/overview.md`, "utf8")).not.toContain("indexes/")
    expect(await fs.readFile(`${project}/wiki/indexes/ai--architecture.md`, "utf8")).not.toContain("Model index")
  })

  it("lists the pages of a proposed domain as unassigned until the domain is listed", async () => {
    // A page that arrives without a domain is unassigned until its domain is listed.
    llm.analysis = "## Decisions\nNEW-DOMAIN: cognition/attention | ai | How attention works\n"
    llm.generation = CONCEPT_WITHOUT_DOMAIN
    const project = await mechanismProject()
    await ingest(project)

    const root = await fs.readFile(`${project}/wiki/index.md`, "utf8")
    expect(root).toContain("- Unassigned — 2 pages\n  - [[attention]]\n")
    await expect(fs.access(`${project}/wiki/indexes/cognition--attention.md`)).rejects.toThrow()
  })
})
