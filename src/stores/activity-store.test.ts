import { beforeEach, describe, expect, it } from "vitest"
import { useActivityStore } from "./activity-store"

function addSkillItem(streamId?: string): string {
  return useActivityStore.getState().addItem({
    type: "skill",
    title: "健檢",
    status: "running",
    detail: "/wiki-lint",
    filesWritten: [],
    projectPath: "/home/user/example-wiki",
    streamId,
  })
}

function itemOf(id: string) {
  const item = useActivityStore.getState().items.find((candidate) => candidate.id === id)
  if (!item) throw new Error(`no item ${id}`)
  return item
}

beforeEach(() => {
  useActivityStore.setState({ items: [] })
})

describe("activity store: a stopped skill run", () => {
  it("keeps the stream id that the item was added with", () => {
    const id = addSkillItem("stream-1")

    expect(itemOf(id).streamId).toBe("stream-1")
  })

  it("keeps an item with no stream id as it is", () => {
    const id = addSkillItem()

    expect(itemOf(id).streamId).toBeUndefined()
  })

  it("lets a running item become cancelled", () => {
    const id = addSkillItem("stream-1")

    useActivityStore.getState().updateItem(id, { status: "cancelled", detail: "Cancelled." })

    expect(itemOf(id)).toMatchObject({ status: "cancelled", detail: "Cancelled." })
  })

  it("does not let a cancelled item leave cancelled: the exit of the killed process arrives later", () => {
    const id = addSkillItem("stream-1")
    useActivityStore.getState().updateItem(id, { status: "cancelled", detail: "Cancelled." })

    useActivityStore.getState().updateItem(id, { status: "running", detail: "late progress" })
    useActivityStore.getState().updateItem(id, { status: "error", detail: "Claude Code was stopped before it finished." })
    useActivityStore.getState().updateItem(id, { status: "done", detail: "result" })

    expect(itemOf(id)).toMatchObject({ status: "cancelled", detail: "Cancelled." })
  })

  it("lets a cancelled item change its text, so a failed kill can be named", () => {
    const id = addSkillItem("stream-1")
    useActivityStore.getState().updateItem(id, { status: "cancelled", detail: "Cancelled." })

    useActivityStore.getState().updateItem(id, { detail: "Cancelled. It may still run." })

    expect(itemOf(id)).toMatchObject({ status: "cancelled", detail: "Cancelled. It may still run." })
  })

  it("lets every other item change as before", () => {
    const id = addSkillItem("stream-1")
    const other = addSkillItem("stream-2")
    useActivityStore.getState().updateItem(id, { status: "cancelled", detail: "Cancelled." })

    useActivityStore.getState().updateItem(other, { status: "done", detail: "result" })

    expect(itemOf(other)).toMatchObject({ status: "done", detail: "result" })
  })

  it("clears a cancelled item with the finished ones, and keeps a running one", () => {
    const stopped = addSkillItem("stream-1")
    const running = addSkillItem("stream-2")
    useActivityStore.getState().updateItem(stopped, { status: "cancelled", detail: "Cancelled." })

    useActivityStore.getState().clearDone()

    expect(useActivityStore.getState().items.map((item) => item.id)).toEqual([running])
  })
})
