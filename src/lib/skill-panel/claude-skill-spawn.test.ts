import { beforeEach, describe, expect, it, vi } from "vitest"
import type { SkillRunHandlers } from "./run-skill"

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  listen: vi.fn(),
  listeners: new Map<string, (event: { payload: unknown }) => void>(),
  unlistened: [] as string[],
}))

vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }))
vi.mock("@tauri-apps/api/event", () => ({ listen: mocks.listen }))

import { detectClaudeCode, spawnClaudeSkill } from "./claude-skill-spawn"

function handlers(): SkillRunHandlers & { lines: string[]; exits: Array<{ code: number | null; stderr: string }> } {
  const lines: string[] = []
  const exits: Array<{ code: number | null; stderr: string }> = []
  return { lines, exits, onLine: (line) => lines.push(line), onExit: (exit) => exits.push(exit) }
}

beforeEach(() => {
  mocks.invoke.mockReset()
  mocks.listen.mockReset()
  mocks.listeners.clear()
  mocks.unlistened.length = 0
  mocks.listen.mockImplementation(async (topic: string, callback: (event: { payload: unknown }) => void) => {
    mocks.listeners.set(topic, callback)
    return () => {
      mocks.unlistened.push(topic)
    }
  })
  mocks.invoke.mockResolvedValue(undefined)
})

describe("spawnClaudeSkill", () => {
  it("listens first, then starts claude_cli_run_skill in the project with the command", async () => {
    const order: string[] = []
    mocks.listen.mockImplementation(async (topic: string, callback: (event: { payload: unknown }) => void) => {
      order.push(`listen ${topic.endsWith(":done") ? "done" : "data"}`)
      mocks.listeners.set(topic, callback)
      return () => {}
    })
    mocks.invoke.mockImplementation(async (name: string) => {
      order.push(`invoke ${name}`)
    })

    await spawnClaudeSkill("/home/user/example-wiki", "/wiki-lint", handlers())

    expect(order).toEqual(["listen data", "listen done", "invoke claude_cli_run_skill"])
    const [name, payload] = mocks.invoke.mock.calls[0]
    expect(name).toBe("claude_cli_run_skill")
    expect(payload).toMatchObject({ command: "/wiki-lint", workingDirectory: "/home/user/example-wiki" })
    // The two topics carry the stream id that the call got.
    const streamId = (payload as { streamId: string }).streamId
    expect(streamId).toMatch(/^[0-9a-f-]{36}$/)
    expect([...mocks.listeners.keys()].sort()).toEqual([`claude-cli:${streamId}`, `claude-cli:${streamId}:done`])
  })

  it("passes each stdout line, then the exit, and stops listening at the exit", async () => {
    const h = handlers()
    await spawnClaudeSkill("/home/user/example-wiki", "/wiki-lint", h)
    const [data, done] = [...mocks.listeners.entries()].sort(([a], [b]) => a.length - b.length).map(([, cb]) => cb)

    data({ payload: '{"type":"assistant"}' })
    data({ payload: "plain text" })
    expect(h.lines).toEqual(['{"type":"assistant"}', "plain text"])
    expect(h.exits).toEqual([])

    done({ payload: { code: 0, stderr: "" } })
    expect(h.exits).toEqual([{ code: 0, stderr: "" }])
    expect(mocks.unlistened).toHaveLength(2)
  })

  it("sends a missing code as null and a missing stderr as an empty string", async () => {
    const h = handlers()
    await spawnClaudeSkill("/home/user/example-wiki", "/wiki-lint", h)
    const done = [...mocks.listeners.entries()].find(([topic]) => topic.endsWith(":done"))?.[1]

    done?.({ payload: {} })

    expect(h.exits).toEqual([{ code: null, stderr: "" }])
  })

  it("stops listening and rejects with the error when the run cannot start", async () => {
    mocks.invoke.mockRejectedValue("Failed to spawn claude: not found")

    await expect(spawnClaudeSkill("/home/user/example-wiki", "/wiki-lint", handlers())).rejects.toBe(
      "Failed to spawn claude: not found",
    )

    expect(mocks.unlistened).toHaveLength(2)
  })
})

describe("detectClaudeCode", () => {
  it("returns what claude_cli_detect says", async () => {
    mocks.invoke.mockResolvedValue({ installed: true, version: "2.1.0", path: "/usr/bin/claude", error: null })

    await expect(detectClaudeCode()).resolves.toEqual({ installed: true, error: null })
    expect(mocks.invoke).toHaveBeenCalledWith("claude_cli_detect")
  })

  it("passes the reason when Claude Code is missing", async () => {
    mocks.invoke.mockResolvedValue({ installed: false, version: null, path: null, error: "claude was not found on PATH" })

    await expect(detectClaudeCode()).resolves.toEqual({ installed: false, error: "claude was not found on PATH" })
  })
})
