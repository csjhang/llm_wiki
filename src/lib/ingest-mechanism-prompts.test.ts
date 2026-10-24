/**
 * Ingest prompts of mechanism wikis and plain wikis.
 *
 * A project with `domains.yaml` is a mechanism wiki and gets the domain and
 * mechanism sections in its analysis, chunk analysis, and generation prompts.
 * A project without it must see the same prompts as upstream.
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

    if (systemPrompt.startsWith("You are analyzing a long source document")) {
      cb.onToken("## Chunk Analysis\nA chunk.\n\n## Updated Global Digest\nA digest.")
      cb.onDone()
      return
    }

    const target = systemPrompt.match(/source summary page at \*\*(wiki\/sources\/[^*]+)\*\*/)?.[1]
    if (!target) {
      // Analysis, and anything else that is not generation.
      cb.onToken("## Analysis\nA short analysis.")
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
} from "./ingest"
import { streamChat } from "./llm-client"
import { buildAnalysisAddendum, buildGenerationAddendum, prepareMechanismPrompts } from "./mechanism-wiki/prompts"
import { loadMechanismContext } from "./mechanism-wiki/context"
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

  async function ingest(project: string, options: { maxContextSize?: number } = {}): Promise<void> {
    const llmConfig = { ...useWikiStore.getState().llmConfig }
    if (options.maxContextSize !== undefined) llmConfig.maxContextSize = options.maxContextSize
    await autoIngest(project, `${project}/${SOURCE_PATH}`, llmConfig)
  }

  /** The upstream prompts for the project as it is now. Call this before `ingest`, which rewrites the index. */
  async function expectedPrompts(project: string, sourceText: string): Promise<{
    analysis: string
    generation: string
  }> {
    const schema = await fs.readFile(`${project}/schema.md`, "utf8")
    const purpose = await fs.readFile(`${project}/purpose.md`, "utf8")
    const index = await fs.readFile(`${project}/wiki/index.md`, "utf8")
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
    const ctx = await loadMechanismContext(project)
    if (!ctx) throw new Error("expected a mechanism context")
    const expected = await expectedPrompts(project, SOURCE_TEXT)
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
    const ctx = await loadMechanismContext(project)
    if (!ctx) throw new Error("expected a mechanism context")
    const expected = await expectedPrompts(project, SOURCE_TEXT)
    await ingest(project)

    const generation = capturedCalls().find(isGeneration)
    expect(generation?.system).toBe(
      `${expected.generation}\n\n${buildGenerationAddendum(ctx, emptyDecisions(null), "English")}`,
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
    const ctx = await loadMechanismContext(project)
    if (!ctx) throw new Error("expected a mechanism context")
    const schema = await fs.readFile(`${project}/schema.md`, "utf8")
    const purpose = await fs.readFile(`${project}/purpose.md`, "utf8")
    await ingest(project, { maxContextSize: 20_000 })

    const chunks = capturedCalls().filter(isChunk)
    expect(chunks.length).toBeGreaterThan(1)
    expect(chunks[0].system).toBe(
      `${buildChunkAnalysisSystemPrompt(purpose, schema, INDEX, longSource)}\n\n${buildAnalysisAddendum(ctx, null, { chunked: true })}`,
    )
  })

  it("counts the mechanism addenda as stable context when it sizes the source budget", async () => {
    const maxContextSize = 100_000
    const project = await mechanismProject()
    const ctx = await loadMechanismContext(project)
    if (!ctx) throw new Error("expected a mechanism context")
    const read = (name: string) => fs.readFile(`${project}/${name}`, "utf8")
    const [schema, purpose, index, overview] = await Promise.all([
      read("schema.md"),
      read("purpose.md"),
      read("wiki/index.md"),
      read("wiki/overview.md"),
    ])
    const plainStable = schema.length + purpose.length + index.length + overview.length
    const reserved = prepareMechanismPrompts(ctx, index, "", "English").reservedChars
    const budgetWithout = computeIngestSourceBudget(maxContextSize, plainStable)
    const budgetWith = computeIngestSourceBudget(maxContextSize, plainStable + reserved)
    // The addenda must make a difference for this test to mean anything.
    expect(budgetWith).toBeLessThan(budgetWithout)

    // A source that fits the plain budget but not the budget with the addenda.
    const size = Math.floor((budgetWith + budgetWithout) / 2)
    const paragraph = `${"A".repeat(1_999)}\n\n`
    const source = paragraph.repeat(Math.ceil(size / paragraph.length)).slice(0, size)
    await writeFileRaw(`${project}/${SOURCE_PATH}`, source)
    await ingest(project, { maxContextSize })

    expect(capturedCalls().filter(isChunk).length).toBeGreaterThan(1)
  })
})
