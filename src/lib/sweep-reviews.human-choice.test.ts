/**
 * The review sweep leaves the items that need a human choice alone.
 *
 * `fusion-candidate`, `mirror-edited`, `new-domain`, `new-mechanism`, `duplicate-source`, and `research-result`
 * items ask the user to decide. Their pages exist, so a judge that sees the page list could call them done.
 * The judge here would resolve every item it is shown; the test checks which items it is shown.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createTempProject, realFs, writeFileRaw } from "@/test-helpers/fs-temp"
import type { ReviewItem } from "@/stores/review-store"

vi.mock("@/commands/fs", () => realFs)

/** The prompts that the judge received. */
const judge = vi.hoisted(() => ({ prompts: [] as string[] }))

vi.mock("./llm-client", () => ({
  streamChat: vi.fn(async (_config, messages, callbacks) => {
    const prompt = String(messages?.[0]?.content ?? "")
    judge.prompts.push(prompt)
    const ids = [...prompt.matchAll(/id=(\S+)/g)].map((match) => match[1])
    callbacks.onToken(JSON.stringify({ resolved: ids }))
    callbacks.onDone()
  }),
}))

import { HUMAN_CHOICE_REVIEW_TYPES, sweepResolvedReviews } from "./sweep-reviews"
import { useActivityStore } from "@/stores/activity-store"
import { useReviewStore } from "@/stores/review-store"
import { useWikiStore } from "@/stores/wiki-store"

const MECHANISM_PAGE = "wiki/mechanisms/example-loop.md"

function item(patch: Partial<ReviewItem> & Pick<ReviewItem, "id" | "type">): ReviewItem {
  return { title: patch.id, description: "", options: [], resolved: false, createdAt: 0, ...patch }
}

describe("sweepResolvedReviews and the items that need a human choice", () => {
  let tmp: { path: string; cleanup: () => Promise<void> }

  beforeEach(async () => {
    judge.prompts.length = 0
    tmp = await createTempProject("sweep-human-choice")
    await writeFileRaw(`${tmp.path}/${MECHANISM_PAGE}`, '---\ntype: mechanism\ntitle: "Example loop"\n---\n# Example loop\n')
    useActivityStore.setState({ items: [] })
    useWikiStore.setState({
      project: { name: "test", path: tmp.path, createdAt: 0, purposeText: "", fileTree: [] } as unknown as ReturnType<
        typeof useWikiStore.getState
      >["project"],
    })
    useWikiStore.getState().setLlmConfig({
      provider: "openai",
      apiKey: "test-key",
      model: "gpt-4",
      ollamaUrl: "",
      customEndpoint: "",
      maxContextSize: 128000,
    })
  })

  afterEach(async () => {
    await tmp.cleanup()
  })

  it("lists the six types that need a human choice", () => {
    expect([...HUMAN_CHOICE_REVIEW_TYPES].sort()).toEqual([
      "duplicate-source",
      "fusion-candidate",
      "mirror-edited",
      "new-domain",
      "new-mechanism",
      "research-result",
    ])
  })

  it("never shows them to the judge and never resolves them", async () => {
    const humanItems = [...HUMAN_CHOICE_REVIEW_TYPES].map((type) =>
      item({ id: `review-${type}`, type, affectedPages: [MECHANISM_PAGE] }),
    )
    // Control: the judge fake does resolve an item that it is shown.
    useReviewStore.setState({ items: [...humanItems, item({ id: "review-control", type: "suggestion" })] })

    await sweepResolvedReviews(tmp.path)

    const items = useReviewStore.getState().items
    for (const type of HUMAN_CHOICE_REVIEW_TYPES) {
      expect(items.find((candidate) => candidate.id === `review-${type}`)?.resolved).toBe(false)
    }
    expect(items.find((candidate) => candidate.id === "review-control")).toMatchObject({
      resolved: true,
      resolvedAction: "llm-judged",
    })
    expect(judge.prompts).toHaveLength(1)
    expect(judge.prompts[0]).toContain("id=review-control")
    for (const type of HUMAN_CHOICE_REVIEW_TYPES) expect(judge.prompts[0]).not.toContain(`review-${type}`)
  })

  it("does no work when only those items are pending", async () => {
    useReviewStore.setState({
      items: [
        item({ id: "review-fusion", type: "fusion-candidate", affectedPages: [MECHANISM_PAGE] }),
        item({ id: "review-mirror", type: "mirror-edited" }),
      ],
    })

    expect(await sweepResolvedReviews(tmp.path)).toBe(0)

    expect(judge.prompts).toEqual([])
    expect(useReviewStore.getState().items.every((candidate) => !candidate.resolved)).toBe(true)
    expect(useActivityStore.getState().items).toEqual([])
  })
})
