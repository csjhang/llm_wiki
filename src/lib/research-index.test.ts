/**
 * Indexing a research page for search. Deep research calls it after it writes a page to
 * `wiki/queries/`, and `mech:accept-research` calls it after it moves a staged page there.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { useWikiStore } from "@/stores/wiki-store"

const embedding = vi.hoisted(() => ({ embedPage: vi.fn(async (..._args: unknown[]) => true) }))

vi.mock("@/lib/embedding", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/embedding")>()),
  embedPage: embedding.embedPage,
}))

import { indexResearchPage } from "./research-index"

const ENABLED = { enabled: true, endpoint: "http://127.0.0.1:1/v1/embeddings", apiKey: "", model: "test-embed" }

beforeEach(() => {
  embedding.embedPage.mockClear()
})

afterEach(() => {
  useWikiStore.setState({ embeddingConfig: { enabled: false, endpoint: "", apiKey: "", model: "" } })
  vi.restoreAllMocks()
})

describe("indexResearchPage", () => {
  it("embeds the page under its wiki page id when embedding is on", async () => {
    useWikiStore.setState({ embeddingConfig: ENABLED })

    await indexResearchPage("/projects/wiki", "/projects/wiki/wiki/queries/research-a.md", "Research: a", "Body.\n")

    expect(embedding.embedPage).toHaveBeenCalledWith("/projects/wiki", "queries/research-a", "Research: a", "Body.\n", ENABLED)
  })

  it("does nothing when embedding is off or has no model", async () => {
    await indexResearchPage("/projects/wiki", "/projects/wiki/wiki/queries/a.md", "A", "Body.\n")
    useWikiStore.setState({ embeddingConfig: { ...ENABLED, model: "" } })
    await indexResearchPage("/projects/wiki", "/projects/wiki/wiki/queries/a.md", "A", "Body.\n")

    expect(embedding.embedPage).not.toHaveBeenCalled()
  })

  it("warns and returns when embedding fails", async () => {
    useWikiStore.setState({ embeddingConfig: ENABLED })
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    embedding.embedPage.mockRejectedValueOnce(new Error("service is down"))

    await expect(
      indexResearchPage("/projects/wiki", "/projects/wiki/wiki/queries/a.md", "A", "Body.\n"),
    ).resolves.toBeUndefined()

    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0][0])).toContain("failed to index generated query page")
  })
})
