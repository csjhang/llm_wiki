import { describe, expect, it, vi } from "vitest"
import type { ActivityItem } from "@/stores/activity-store"
import { CANCELLED_DETAIL, canCancelSkillRun, cancelSkillRun, type CancelDeps } from "./cancel-skill"

function item(overrides: Partial<ActivityItem> = {}): ActivityItem {
  return {
    id: "activity-1",
    type: "skill",
    title: "同步 Heptabase",
    status: "running",
    detail: "/wiki-sync --yes",
    filesWritten: [],
    createdAt: 1,
    projectPath: "/home/user/example-wiki",
    streamId: "stream-1",
    ...overrides,
  }
}

function deps(items: ActivityItem[], kill = vi.fn(async () => {})): CancelDeps & { updates: Array<[string, unknown]>; kill: typeof kill } {
  const updates: Array<[string, unknown]> = []
  return {
    updates,
    kill,
    activity: {
      items,
      updateItem: (id, changes) => {
        updates.push([id, changes])
        const found = items.find((candidate) => candidate.id === id)
        // The real store keeps a cancelled item cancelled; the test only needs the first change.
        if (found) Object.assign(found, changes)
      },
    },
  }
}

describe("canCancelSkillRun", () => {
  it("is true for a running skill item with a stream id", () => {
    expect(canCancelSkillRun(item())).toBe(true)
  })

  it("is false for a finished run, for a cancelled run, and for a run with no stream id", () => {
    for (const status of ["done", "warning", "error", "cancelled"] as const) {
      expect(canCancelSkillRun(item({ status })), status).toBe(false)
    }
    expect(canCancelSkillRun(item({ streamId: undefined }))).toBe(false)
    expect(canCancelSkillRun(item({ streamId: "" }))).toBe(false)
  })

  it("is false for an item that is not a skill run, because the ingest queue has its own cancel", () => {
    for (const type of ["ingest", "lint", "query"] as const) {
      expect(canCancelSkillRun(item({ type })), type).toBe(false)
    }
  })
})

describe("cancelSkillRun", () => {
  it("stops the process of the run and marks the item cancelled", async () => {
    const d = deps([item()])

    const asked = await cancelSkillRun("activity-1", d)

    expect(asked).toBe(true)
    expect(d.kill).toHaveBeenCalledTimes(1)
    expect(d.kill).toHaveBeenCalledWith("stream-1")
    expect(d.updates).toEqual([["activity-1", { status: "cancelled", detail: CANCELLED_DETAIL }]])
  })

  it("says in plain words that the run was cancelled", () => {
    expect(CANCELLED_DETAIL).toMatch(/^Cancelled\./)
    expect(CANCELLED_DETAIL).toMatch(/stopped/)
  })

  it("marks the item before it waits for the process, so the button is free at once", async () => {
    const order: string[] = []
    const d = deps([item()], vi.fn(async () => { order.push("kill") }))
    const update = d.activity.updateItem
    d.activity.updateItem = (id, changes) => {
      order.push(`update ${changes.status ?? "detail"}`)
      update(id, changes)
    }

    await cancelSkillRun("activity-1", d)

    expect(order).toEqual(["update cancelled", "kill"])
  })

  it("reads the item when it is called: a run that ended meanwhile is left alone", async () => {
    const d = deps([item({ status: "done", detail: "The result." })])

    const asked = await cancelSkillRun("activity-1", d)

    expect(asked).toBe(false)
    expect(d.kill).not.toHaveBeenCalled()
    expect(d.updates).toEqual([])
  })

  it("does nothing for an unknown item", async () => {
    const d = deps([])

    expect(await cancelSkillRun("activity-9", d)).toBe(false)
    expect(d.kill).not.toHaveBeenCalled()
  })

  it("stays cancelled and names the problem when the process cannot be stopped", async () => {
    const d = deps([item()], vi.fn(async () => { throw "ipc failed" }))

    const asked = await cancelSkillRun("activity-1", d)

    expect(asked).toBe(true)
    expect(d.updates[0]).toEqual(["activity-1", { status: "cancelled", detail: CANCELLED_DETAIL }])
    const [id, changes] = d.updates[1] as [string, { status?: string; detail: string }]
    expect(id).toBe("activity-1")
    expect(changes.status).toBeUndefined()
    expect(changes.detail).toContain(CANCELLED_DETAIL)
    expect(changes.detail).toContain("ipc failed")
    expect(changes.detail).toMatch(/may still run/)
  })
})
