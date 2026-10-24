/**
 * Where the chat ingest reads the schema and the purpose of a project.
 *
 * A project keeps `schema.md` and `purpose.md` in its root, and `autoIngest` reads them there.
 * The chat ingest (`startIngest` for the analysis chat, `executeIngestWrites` for the write step)
 * must read the same files. A project that only has `wiki/schema.md` and `wiki/purpose.md`
 * keeps working through the fallback.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createTempProject, realFs, writeFileRaw } from "@/test-helpers/fs-temp"
import { useChatStore } from "@/stores/chat-store"
import { useWikiStore } from "@/stores/wiki-store"

vi.mock("@/commands/fs", () => realFs)

vi.mock("./llm-client", () => ({
  streamChat: vi.fn(async (_cfg, _messages, cb) => {
    cb.onToken("Nothing to write.")
    cb.onDone({ finishReason: "stop", truncated: false })
  }),
}))

vi.mock("./mineru", () => ({
  parseWithMineru: vi.fn(),
  parseWithMineruResult: vi.fn(),
}))

import { executeIngestWrites, startIngest } from "./ingest"
import { streamChat } from "./llm-client"

const mockStreamChat = vi.mocked(streamChat)

const ROOT_SCHEMA = "# Schema\n\nROOT-SCHEMA-MARKER\n"
const ROOT_PURPOSE = "# Purpose\n\nROOT-PURPOSE-MARKER\n"
const WIKI_SCHEMA = "# Schema\n\nWIKI-SCHEMA-MARKER\n"
const WIKI_PURPOSE = "# Purpose\n\nWIKI-PURPOSE-MARKER\n"
const SOURCE = "raw/sources/note.md"

describe("chat ingest reads the schema and the purpose", () => {
  let tmp: { path: string; cleanup: () => Promise<void> }
  let project: string

  beforeEach(async () => {
    mockStreamChat.mockClear()
    tmp = await createTempProject("start-schema-path")
    project = tmp.path
    await writeFileRaw(`${project}/${SOURCE}`, "# A note\n\nWork happens only when an event arrives.\n")
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
    await tmp.cleanup()
  })

  /** The system prompt of the only streamChat call of `startIngest`. */
  async function startPrompt(): Promise<string> {
    await startIngest(project, `${project}/${SOURCE}`, { ...useWikiStore.getState().llmConfig })
    expect(mockStreamChat).toHaveBeenCalledTimes(1)
    return String(mockStreamChat.mock.calls[0][1][0].content)
  }

  /** The system prompt and the last user message of the only streamChat call of `executeIngestWrites`. */
  async function writePrompts(): Promise<{ system: string; last: string }> {
    useChatStore.getState().createConversation()
    useChatStore.setState({ ingestSource: `${project}/${SOURCE}` })
    await executeIngestWrites(project, { ...useWikiStore.getState().llmConfig })
    expect(mockStreamChat).toHaveBeenCalledTimes(1)
    const messages = mockStreamChat.mock.calls[0][1]
    return { system: String(messages[0].content), last: String(messages[messages.length - 1].content) }
  }

  it("startIngest reads root schema and purpose", async () => {
    await writeFileRaw(`${project}/schema.md`, ROOT_SCHEMA)
    await writeFileRaw(`${project}/purpose.md`, ROOT_PURPOSE)

    const system = await startPrompt()

    expect(system).toContain(`## Wiki Schema\n${ROOT_SCHEMA}`)
    expect(system).toContain(`## Wiki Purpose\n${ROOT_PURPOSE}`)
  })

  it("startIngest falls back to wiki/ copies", async () => {
    await writeFileRaw(`${project}/wiki/schema.md`, WIKI_SCHEMA)
    await writeFileRaw(`${project}/wiki/purpose.md`, WIKI_PURPOSE)

    const system = await startPrompt()

    expect(system).toContain(`## Wiki Schema\n${WIKI_SCHEMA}`)
    expect(system).toContain(`## Wiki Purpose\n${WIKI_PURPOSE}`)
  })

  it("startIngest prefers the root copy over the wiki/ copy, file by file", async () => {
    await writeFileRaw(`${project}/schema.md`, ROOT_SCHEMA)
    await writeFileRaw(`${project}/wiki/schema.md`, WIKI_SCHEMA)
    await writeFileRaw(`${project}/wiki/purpose.md`, WIKI_PURPOSE)

    const system = await startPrompt()

    expect(system).toContain("ROOT-SCHEMA-MARKER")
    expect(system).not.toContain("WIKI-SCHEMA-MARKER")
    expect(system).toContain("WIKI-PURPOSE-MARKER")
  })

  it("startIngest sends no schema or purpose section when the project has neither", async () => {
    const system = await startPrompt()

    expect(system).not.toContain("## Wiki Schema")
    expect(system).not.toContain("## Wiki Purpose")
  })

  it("executeIngestWrites reads the root schema", async () => {
    await writeFileRaw(`${project}/schema.md`, ROOT_SCHEMA)

    const { system, last } = await writePrompts()

    expect(system).toContain(`## Wiki Schema\n${ROOT_SCHEMA}`)
    expect(last).toContain(`## Wiki Schema\n${ROOT_SCHEMA}`)
  })

  it("executeIngestWrites falls back to the wiki/ schema", async () => {
    await writeFileRaw(`${project}/wiki/schema.md`, WIKI_SCHEMA)

    const { system, last } = await writePrompts()

    expect(system).toContain(`## Wiki Schema\n${WIKI_SCHEMA}`)
    expect(last).toContain(`## Wiki Schema\n${WIKI_SCHEMA}`)
  })
})
