/**
 * review-sync.test.ts - the app applies the `review://changed` event of the API server to its review store.
 *
 * The API routes that write `.llm-wiki/review.json` emit the event. Without the listener, the next auto-save of the
 * store writes the old state over the change of the API. These tests keep that from coming back.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createTempProject, readFileRaw, realFs } from "@/test-helpers/fs-temp"

const mocks = vi.hoisted(() => ({
  listen: vi.fn(),
}))

vi.mock("@tauri-apps/api/event", () => ({ listen: mocks.listen }))
vi.mock("@/commands/fs", () => realFs)

import { setupAutoSave } from "@/lib/auto-save"
import {
  applyReviewChange,
  handleReviewChanged,
  startReviewSync,
  type ReviewChangedPayload,
} from "@/lib/review-sync"
import { reviewIdFor, useReviewStore, type ReviewItem } from "@/stores/review-store"
import { useWikiStore } from "@/stores/wiki-store"

function item(overrides: Partial<ReviewItem> & Pick<ReviewItem, "type" | "title">): ReviewItem {
  return {
    id: reviewIdFor(overrides),
    description: "",
    options: [{ label: "Dismiss", action: "dismiss" }],
    resolved: false,
    createdAt: 1000,
    ...overrides,
  }
}

const existing = item({ type: "confirm", title: "Existing" })
const added = item({
  type: "mirror-edited",
  title: "Mirror card edited: wiki/mechanisms/attention.md",
  description: "The note is raw/sources/heptabase/attention-edit.md.",
  affectedPages: ["wiki/mechanisms/attention.md"],
  createdAt: 2000,
})

describe("applyReviewChange", () => {
  it("appends an added item that the store does not have", () => {
    const next = applyReviewChange([existing], { projectPath: "/p", added: [added] })
    expect(next).toEqual([existing, added])
  })

  it("merges an added item into the item with the same id and keeps its resolved state", () => {
    const resolvedBefore = { ...added, resolved: true, resolvedAction: "Dismiss", affectedPages: ["wiki/a.md"], createdAt: 5000 }
    const next = applyReviewChange([resolvedBefore], { projectPath: "/p", added: [added] })
    expect(next).toHaveLength(1)
    expect(next[0].resolved).toBe(true)
    expect(next[0].resolvedAction).toBe("Dismiss")
    expect(next[0].affectedPages).toEqual(["wiki/a.md", "wiki/mechanisms/attention.md"])
    expect(next[0].createdAt).toBe(2000)
  })

  it("resolves an item by id, with the action label", () => {
    const next = applyReviewChange([existing, added], {
      projectPath: "/p",
      resolved: [{ id: existing.id, action: "Skip" }],
    })
    expect(next[0]).toMatchObject({ resolved: true, resolvedAction: "Skip" })
    expect(next[1].resolved).toBe(false)
  })

  it("resolves an item that the API names with its stable id when the store holds an older id", () => {
    const legacy = { ...existing, id: "review-1" }
    const next = applyReviewChange([legacy], {
      projectPath: "/p",
      resolved: [{ id: reviewIdFor(legacy), action: null }],
    })
    expect(next[0].resolved).toBe(true)
    expect(next[0].resolvedAction).toBeUndefined()
  })

  it("reopens an item and drops its action", () => {
    const resolvedItem = { ...existing, resolved: true, resolvedAction: "Skip" }
    const next = applyReviewChange([resolvedItem], { projectPath: "/p", reopened: [existing.id] })
    expect(next[0].resolved).toBe(false)
    expect(next[0].resolvedAction).toBeUndefined()
  })

  it("removes deleted items and leaves the others", () => {
    const next = applyReviewChange([existing, added], { projectPath: "/p", deleted: [existing.id] })
    expect(next).toEqual([added])
  })

  it("does not change the input array", () => {
    const items = [existing]
    applyReviewChange(items, { projectPath: "/p", added: [added], deleted: [existing.id] })
    expect(items).toEqual([existing])
  })
})

describe("handleReviewChanged", () => {
  beforeEach(() => {
    useReviewStore.setState({ items: [existing] })
    useWikiStore.setState({ project: { id: "p1", name: "P", path: "C:\\wikis\\demo" } as never })
  })

  it("applies a payload for the open project, whatever the path style", () => {
    handleReviewChanged({ projectPath: "c:/wikis/demo/", added: [added] })
    expect(useReviewStore.getState().items.map((entry) => entry.id)).toEqual([existing.id, added.id])
  })

  it("changes nothing for another project", () => {
    handleReviewChanged({ projectPath: "C:/wikis/other", added: [added], deleted: [existing.id] })
    expect(useReviewStore.getState().items).toEqual([existing])
  })

  it("changes nothing when no project is open", () => {
    useWikiStore.setState({ project: null })
    handleReviewChanged({ projectPath: "C:/wikis/demo", added: [added] })
    expect(useReviewStore.getState().items).toEqual([existing])
  })

  it("ignores a payload that is not an object with a project path", () => {
    handleReviewChanged(null as never)
    handleReviewChanged({} as never)
    expect(useReviewStore.getState().items).toEqual([existing])
  })
})

describe("startReviewSync", () => {
  beforeEach(() => {
    mocks.listen.mockReset()
    useReviewStore.setState({ items: [existing] })
    useWikiStore.setState({ project: { id: "p1", name: "P", path: "/wikis/demo" } as never })
  })

  it("listens for review://changed and applies the payload", async () => {
    const unlisten = vi.fn()
    mocks.listen.mockResolvedValue(unlisten)

    const stop = await startReviewSync()

    expect(mocks.listen).toHaveBeenCalledTimes(1)
    expect(mocks.listen.mock.calls[0][0]).toBe("review://changed")
    const callback = mocks.listen.mock.calls[0][1] as (event: { payload: ReviewChangedPayload }) => void
    callback({ payload: { projectPath: "/wikis/demo", added: [added] } })
    expect(useReviewStore.getState().items).toHaveLength(2)

    stop()
    expect(unlisten).toHaveBeenCalledTimes(1)
  })
})

describe("an API change survives the next auto-save (S2)", () => {
  let tmp: { path: string; cleanup: () => Promise<void> }
  let registered = false

  beforeEach(async () => {
    tmp = await createTempProject("review-sync")
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
    if (!registered) {
      setupAutoSave()
      registered = true
    }
    useWikiStore.setState({ project: { id: "p1", name: "P", path: tmp.path } as never })
    useReviewStore.setState({ items: [existing] })
    // The set-up above schedules a save of its own. Only the save after the payload counts.
    vi.clearAllTimers()
  })

  afterEach(async () => {
    vi.useRealTimers()
    await tmp.cleanup()
  })

  /** Let the debounce of the auto-save run, then read what it wrote. Null when it wrote no file. */
  async function nextAutoSave(): Promise<ReviewItem[] | null> {
    await vi.advanceTimersByTimeAsync(1100)
    vi.useRealTimers()
    const file = `${tmp.path}/.llm-wiki/review.json`
    for (let attempt = 0; attempt < 15; attempt++) {
      try {
        return JSON.parse(await readFileRaw(file)) as ReviewItem[]
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 20))
      }
    }
    return null
  }

  it("writes the added item to review.json with the items that were in the store", async () => {
    handleReviewChanged({ projectPath: tmp.path, added: [added] })

    const written = await nextAutoSave()

    expect(written?.map((entry) => entry.id)).toEqual([existing.id, added.id])
    expect(written?.[1]).toMatchObject({ type: "mirror-edited", resolved: false })
  })

  it("does not write anything for a payload of another project", async () => {
    handleReviewChanged({ projectPath: `${tmp.path}-other`, added: [added] })

    const written = await nextAutoSave()

    expect(written).toBeNull()
    expect(useReviewStore.getState().items).toEqual([existing])
  })
})
