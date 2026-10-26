/**
 * run-skill.test.ts - how the skill panel runs a button.
 *
 * Every branch of `runSkill` is tested with fake dependencies. The stream lines are
 * the shapes that Claude Code prints with `--output-format stream-json --verbose`.
 */
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { PanelEntry } from "./panel-config"
import {
  runSkill,
  type ActivityApi,
  type RunSkillDeps,
  type SkillFallback,
  type SkillRunHandlers,
} from "./run-skill"
import { useActivityStore } from "@/stores/activity-store"

const PROJECT = "/home/user/example-wiki"
const BOARD = "00000000-0000-4000-8000-000000000001"

const SYNC: PanelEntry = {
  skill: "wiki-sync",
  label: "同步 Heptabase",
  mode: "background",
  inputs: [],
  args: "--yes",
  description: "Sync.",
}
const LINT: PanelEntry = { skill: "wiki-lint", label: "健檢", mode: "background", inputs: [], description: "Lint." }
const FUSE: PanelEntry = {
  skill: "wiki-fuse",
  label: "融合",
  mode: "conversation",
  inputs: ["whiteboard"],
  description: "Fuse.",
}

// ---- stream lines, as Claude Code prints them ----

const line = (value: unknown): string => JSON.stringify(value)
const assistantText = (text: string): string =>
  line({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text }] } })
const assistantTool = (name: string, input: Record<string, unknown> = {}): string =>
  line({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: "toolu_1", name, input }] } })
const toolError = (text: string): string =>
  line({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", is_error: true, content: text }] } })
const toolOk = (text: string): string =>
  line({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: text }] } })
const denied = (tool: string, message: string): string =>
  line({ type: "system", subtype: "permission_denied", tool_name: tool, tool_use_id: "toolu_1", message })
const result = (fields: Record<string, unknown>): string =>
  line({ type: "result", subtype: "success", is_error: false, permission_denials: [], ...fields })

// ---- fakes ----

interface FakeItem {
  type: string
  title: string
  status: "running" | "done" | "error"
  detail: string
  filesWritten: string[]
}

function fakeActivity(): { api: ActivityApi; items: FakeItem[] } {
  const items: FakeItem[] = []
  return {
    items,
    api: {
      addItem: (item) => {
        items.push({ ...item })
        return String(items.length - 1)
      },
      updateItem: (id, updates) => {
        Object.assign(items[Number(id)], updates)
      },
    },
  }
}

interface Harness {
  deps: RunSkillDeps
  activity: ReturnType<typeof fakeActivity>
  spawnClaude: ReturnType<typeof vi.fn>
  openTerminal: ReturnType<typeof vi.fn>
  detectClaude: ReturnType<typeof vi.fn>
  copy: ReturnType<typeof vi.fn>
  fallbacks: SkillFallback[]
  /** The handlers that the last spawn got. */
  handlers(): SkillRunHandlers
}

function harness(overrides: Partial<RunSkillDeps> = {}): Harness {
  const activity = fakeActivity()
  const fallbacks: SkillFallback[] = []
  let captured: SkillRunHandlers | null = null
  const spawnClaude = vi.fn(async (_path: string, _command: string, handlers: SkillRunHandlers) => {
    captured = handlers
  })
  const openTerminal = vi.fn(async () => "gnome-terminal")
  const detectClaude = vi.fn(async () => ({ installed: true, error: null }))
  const copy = vi.fn(async () => {})
  const deps: RunSkillDeps = {
    projectPath: PROJECT,
    detectClaude,
    spawnClaude,
    openTerminal,
    copy,
    activity: activity.api,
    onFallback: (fallback) => fallbacks.push(fallback),
    ...overrides,
  }
  return {
    deps,
    activity,
    spawnClaude,
    openTerminal,
    detectClaude,
    copy,
    fallbacks,
    handlers: () => {
      if (!captured) throw new Error("spawnClaude was not called")
      return captured
    },
  }
}

describe("runSkill, conversation button", () => {
  it("opens a terminal in the project with the command, and starts", async () => {
    const h = harness()

    const outcome = await runSkill(FUSE, { whiteboard: BOARD }, h.deps)

    expect(outcome).toBe("started")
    expect(h.openTerminal).toHaveBeenCalledWith(PROJECT, `/wiki-fuse ${BOARD}`)
    expect(h.copy).not.toHaveBeenCalled()
    expect(h.spawnClaude).not.toHaveBeenCalled()
    expect(h.activity.items).toEqual([])
    expect(h.fallbacks).toEqual([])
  })

  it("copies the command when no terminal can start, and says why", async () => {
    // Tauri rejects with a plain string, not an Error.
    const h = harness({
      openTerminal: vi.fn(async () => {
        throw "Could not open a terminal (xterm: not found)."
      }),
    })

    const outcome = await runSkill(FUSE, { whiteboard: BOARD }, h.deps)

    expect(outcome).toBe("copied")
    expect(h.copy).toHaveBeenCalledWith(`/wiki-fuse ${BOARD}`)
    expect(h.fallbacks).toEqual([
      {
        reason: "terminal-failed",
        detail: "Could not open a terminal (xterm: not found).",
        command: `/wiki-fuse ${BOARD}`,
      },
    ])
  })

  it("does not check for Claude Code first: the terminal says it when claude is missing", async () => {
    const h = harness()
    await runSkill(FUSE, { whiteboard: BOARD }, h.deps)
    expect(h.detectClaude).not.toHaveBeenCalled()
  })
})

describe("runSkill, a bad value", () => {
  it("throws the message of commandFor and runs nothing", async () => {
    const h = harness()

    await expect(runSkill(FUSE, { whiteboard: "x; rm -rf ~" }, h.deps)).rejects.toThrow(/whiteboard value must be/)

    expect(h.openTerminal).not.toHaveBeenCalled()
    expect(h.spawnClaude).not.toHaveBeenCalled()
    expect(h.copy).not.toHaveBeenCalled()
    expect(h.activity.items).toEqual([])
  })
})

describe("runSkill, background button: Claude Code is missing", () => {
  it("copies the command and says so, with no error stack and no activity item", async () => {
    const h = harness({
      detectClaude: vi.fn(async () => ({ installed: false, error: "claude was not found on PATH" })),
    })

    const outcome = await runSkill(SYNC, {}, h.deps)

    expect(outcome).toBe("copied")
    expect(h.copy).toHaveBeenCalledWith("/wiki-sync --yes")
    expect(h.spawnClaude).not.toHaveBeenCalled()
    expect(h.activity.items).toEqual([])
    expect(h.fallbacks).toEqual([
      { reason: "claude-missing", detail: "claude was not found on PATH", command: "/wiki-sync --yes" },
    ])
  })

  it("treats a failed detection like a missing Claude Code", async () => {
    const h = harness({
      detectClaude: vi.fn(async () => {
        throw new Error("invoke failed")
      }),
    })

    const outcome = await runSkill(LINT, {}, h.deps)

    expect(outcome).toBe("copied")
    expect(h.copy).toHaveBeenCalledWith("/wiki-lint")
    expect(h.fallbacks[0]).toMatchObject({ reason: "claude-missing", detail: "invoke failed" })
    expect(h.spawnClaude).not.toHaveBeenCalled()
  })

  it("copies the command when the run cannot start", async () => {
    const h = harness({
      spawnClaude: vi.fn(async () => {
        throw "Claude Code CLI working directory must be an LLM Wiki project containing wiki/index.md"
      }),
    })

    const outcome = await runSkill(LINT, {}, h.deps)

    expect(outcome).toBe("copied")
    expect(h.copy).toHaveBeenCalledWith("/wiki-lint")
    expect(h.fallbacks).toEqual([
      {
        reason: "spawn-failed",
        detail: "Claude Code CLI working directory must be an LLM Wiki project containing wiki/index.md",
        command: "/wiki-lint",
      },
    ])
    expect(h.activity.items).toEqual([])
  })

  it("rejects with the command when it cannot copy either, so the panel can show it", async () => {
    const h = harness({
      detectClaude: vi.fn(async () => ({ installed: false, error: null })),
      copy: vi.fn(async () => {
        throw new Error("clipboard is blocked")
      }),
    })

    await expect(runSkill(SYNC, {}, h.deps)).rejects.toMatchObject({
      message: expect.stringContaining("clipboard is blocked"),
      command: "/wiki-sync --yes",
    })
  })
})

describe("runSkill, background button: the run", () => {
  it("starts claude in the project with the command, and adds one running item", async () => {
    const h = harness()

    const outcome = await runSkill(SYNC, {}, h.deps)

    expect(outcome).toBe("started")
    expect(h.spawnClaude).toHaveBeenCalledTimes(1)
    expect(h.spawnClaude.mock.calls[0].slice(0, 2)).toEqual([PROJECT, "/wiki-sync --yes"])
    expect(h.copy).not.toHaveBeenCalled()
    expect(h.activity.items).toHaveLength(1)
    expect(h.activity.items[0]).toMatchObject({
      type: "skill",
      title: "同步 Heptabase",
      status: "running",
      filesWritten: [],
    })
    expect(h.activity.items[0].detail).toContain("/wiki-sync --yes")
  })

  it("puts the progress into the item while it runs", async () => {
    const h = harness()
    await runSkill(SYNC, {}, h.deps)

    h.handlers().onLine(assistantText("Reading heptabase.yaml.\nThen the plan."))
    h.handlers().onLine(assistantTool("Bash", { command: "node wiki-tool.mjs hepta plan-up", description: "Plan the Up step" }))
    h.handlers().onLine(toolOk("{}"))
    h.handlers().onLine(assistantTool("mcp__example__list_cards"))

    const item = h.activity.items[0]
    expect(item.status).toBe("running")
    expect(item.detail).toContain("Reading heptabase.yaml.")
    expect(item.detail).not.toContain("Then the plan.")
    expect(item.detail).toContain("Bash: Plan the Up step")
    expect(item.detail).toContain("mcp__example__list_cards")
    // The detail names the command, so the user knows which run this is.
    expect(item.detail).toContain("/wiki-sync --yes")
  })

  it("keeps only the latest progress lines", async () => {
    const h = harness()
    await runSkill(SYNC, {}, h.deps)

    for (let i = 1; i <= 30; i += 1) h.handlers().onLine(assistantTool(`tool_${i}`))

    const detail = h.activity.items[0].detail
    expect(detail).toContain("tool_30")
    expect(detail).not.toContain("tool_1\n")
    expect(detail.split("\n").length).toBeLessThan(12)
  })

  it("ignores lines that are not events, and events with no progress", async () => {
    const h = harness()
    await runSkill(SYNC, {}, h.deps)

    h.handlers().onLine("")
    h.handlers().onLine("not json")
    h.handlers().onLine(line({ type: "system", subtype: "hook_started" }))
    h.handlers().onLine(line({ type: "rate_limit_event" }))

    expect(h.activity.items[0].status).toBe("running")
    expect(h.activity.items[0].detail.trim()).toBe("/wiki-sync --yes")
  })

  it("shows the final text when the run is done", async () => {
    const h = harness()
    await runSkill(SYNC, {}, h.deps)

    h.handlers().onLine(assistantText("Working."))
    h.handlers().onLine(result({ result: "Up: 3 snapshots. Down: 2 created." }))
    h.handlers().onExit({ code: 0, stderr: "" })

    const item = h.activity.items[0]
    expect(item.status).toBe("done")
    expect(item.detail).toContain("Up: 3 snapshots. Down: 2 created.")
    expect(item.detail).not.toContain("Working.")
  })

  it("lists the tools that were denied, with the text of the denial", async () => {
    const h = harness()
    await runSkill(SYNC, {}, h.deps)
    const text = "touch zz.txt needs approval."

    h.handlers().onLine(assistantTool("Bash"))
    h.handlers().onLine(denied("Bash", text))
    h.handlers().onLine(toolError(text))
    // While the run goes on, the denial shows once.
    expect(h.activity.items[0].detail.split(text).length - 1).toBe(1)

    h.handlers().onLine(
      result({
        result: "I did not create the file. The Bash call needs approval.",
        permission_denials: [{ tool_name: "Bash", tool_use_id: "toolu_1", tool_input: {} }],
      }),
    )
    h.handlers().onExit({ code: 0, stderr: "" })

    const item = h.activity.items[0]
    expect(item.status).toBe("done")
    expect(item.detail).toContain("The Bash call needs approval.")
    expect(item.detail).toContain("Denied tools: Bash")
  })

  it("shows an error from a tool call while the run goes on", async () => {
    const h = harness()
    await runSkill(SYNC, {}, h.deps)

    h.handlers().onLine(assistantTool("mcp__example__read_object"))
    h.handlers().onLine(toolError("MCP server example is not connected"))

    expect(h.activity.items[0].detail).toContain("MCP server example is not connected")
    expect(h.activity.items[0].status).toBe("running")
  })

  it("shows the failure text of Claude Code when the run fails mid-way", async () => {
    const h = harness()
    await runSkill(SYNC, {}, h.deps)

    h.handlers().onLine(assistantText("Reading the plan."))
    h.handlers().onLine(assistantTool("Bash"))
    h.handlers().onLine(result({ is_error: true, subtype: "error_during_execution", result: "Credit balance is too low" }))
    h.handlers().onExit({ code: 1, stderr: "" })

    const item = h.activity.items[0]
    expect(item.status).toBe("error")
    expect(item.detail).toContain("Credit balance is too low")
  })

  it("shows the errors list of an error result that has no result text", async () => {
    const h = harness()
    await runSkill(SYNC, {}, h.deps)

    h.handlers().onLine(result({ is_error: true, subtype: "error_max_turns", errors: ["Reached the maximum number of turns (30)"] }))
    h.handlers().onExit({ code: 1, stderr: "" })

    expect(h.activity.items[0].status).toBe("error")
    expect(h.activity.items[0].detail).toContain("Reached the maximum number of turns (30)")
  })

  it("shows stderr when claude exits with a code and sent no result", async () => {
    const h = harness()
    await runSkill(SYNC, {}, h.deps)

    h.handlers().onLine(assistantText("Starting."))
    h.handlers().onExit({ code: 2, stderr: "Error: unknown option '--yes'\n" })

    const item = h.activity.items[0]
    expect(item.status).toBe("error")
    expect(item.detail).toContain("exited with code 2")
    expect(item.detail).toContain("unknown option '--yes'")
  })

  it("says to log in when Claude Code is not authenticated", async () => {
    const h = harness()
    await runSkill(SYNC, {}, h.deps)

    h.handlers().onExit({ code: 1, stderr: "Unauthenticated: please log in" })

    expect(h.activity.items[0].status).toBe("error")
    expect(h.activity.items[0].detail).toContain("not authenticated")
  })

  it("shows the structured error event when the process exits with no result", async () => {
    const h = harness()
    await runSkill(SYNC, {}, h.deps)

    h.handlers().onLine(line({ type: "error", error: { message: "Overloaded" } }))
    h.handlers().onExit({ code: 1, stderr: "" })

    expect(h.activity.items[0].status).toBe("error")
    expect(h.activity.items[0].detail).toContain("Overloaded")
  })

  it("is an error when claude exits 0 with no result, and shows what it printed", async () => {
    const h = harness()
    await runSkill(SYNC, {}, h.deps)

    h.handlers().onLine("Warning: something odd")
    h.handlers().onExit({ code: 0, stderr: "" })

    const item = h.activity.items[0]
    expect(item.status).toBe("error")
    expect(item.detail).toContain("no result")
    expect(item.detail).toContain("Warning: something odd")
  })

  it("is an error when the process was stopped before it finished", async () => {
    const h = harness()
    await runSkill(SYNC, {}, h.deps)

    h.handlers().onExit({ code: null, stderr: "" })

    expect(h.activity.items[0].status).toBe("error")
    expect(h.activity.items[0].detail).toMatch(/stopped|no result/)
  })

  it("keeps the events that arrive before the item exists", async () => {
    const activity = fakeActivity()
    const h = harness({
      activity: activity.api,
      spawnClaude: vi.fn(async (_path: string, _command: string, handlers: SkillRunHandlers) => {
        // A fast run: the events come before the start call returns.
        handlers.onLine(result({ result: "Nothing to lint." }))
        handlers.onExit({ code: 0, stderr: "" })
      }),
    })

    await runSkill(LINT, {}, h.deps)

    expect(activity.items).toHaveLength(1)
    expect(activity.items[0].status).toBe("done")
    expect(activity.items[0].detail).toContain("Nothing to lint.")
  })

  it("keeps a long final text whole, up to a limit", async () => {
    const h = harness()
    await runSkill(SYNC, {}, h.deps)
    const long = "x".repeat(20_000)

    h.handlers().onLine(result({ result: long }))
    h.handlers().onExit({ code: 0, stderr: "" })

    const detail = h.activity.items[0].detail
    expect(detail.length).toBeLessThan(long.length)
    expect(detail.length).toBeGreaterThan(2_000)
  })

  it("works with the real activity store", async () => {
    useActivityStore.setState({ items: [] })
    const h = harness({ activity: useActivityStore.getState() })

    await runSkill(LINT, {}, h.deps)
    h.handlers().onLine(result({ result: "Lint done." }))
    h.handlers().onExit({ code: 0, stderr: "" })

    const items = useActivityStore.getState().items
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ type: "skill", title: "健檢", status: "done" })
    expect(items[0].detail).toContain("Lint done.")
  })
})

describe("runSkill, command", () => {
  beforeEach(() => {
    useActivityStore.setState({ items: [] })
  })

  it("adds the fixed args of the entry before the input values", async () => {
    const entry: PanelEntry = { ...FUSE, mode: "conversation", args: "--explore", inputs: [] }
    const h = harness()

    await runSkill(entry, {}, h.deps)

    expect(h.openTerminal).toHaveBeenCalledWith(PROJECT, "/wiki-fuse --explore")
  })
})
