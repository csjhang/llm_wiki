/**
 * skills-view.test.tsx - how the skill panel shows its buttons.
 *
 * The panel renders to static markup: the tests need no DOM.
 */
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import i18n from "@/i18n"
import { PANEL_ENTRIES, type PanelEntry } from "@/lib/skill-panel/panel-config"
import { SkillCopyError } from "@/lib/skill-panel/run-skill"
import type { WhiteboardOption } from "@/lib/skill-panel/whiteboards"
import type { ActivityItem } from "@/stores/activity-store"
import {
  NEED_SYNC_LABEL,
  SkillPanel,
  isRunBlocked,
  latestRuns,
  noticeForError,
  noticeForFallback,
  noticeForStart,
  runJustEnded,
  shouldReloadWhiteboards,
  type SkillPanelProps,
} from "./skills-view"

const BOARD_1 = "00000000-0000-4000-8000-000000000001"
const BOARD_2 = "00000000-0000-4000-8000-000000000002"
const WHITEBOARDS: WhiteboardOption[] = [
  { id: BOARD_1, label: "example/alpha" },
  { id: BOARD_2, label: "example/alpha / beta" },
]

const t = i18n.getFixedT("en")

function render(props: Partial<SkillPanelProps> = {}): string {
  return renderToStaticMarkup(
    createElement(SkillPanel, {
      entries: PANEL_ENTRIES,
      whiteboards: [],
      whiteboardsLoaded: true,
      values: {},
      onValueChange: () => {},
      busy: new Set<string>(),
      notices: {},
      runs: {},
      onRun: () => {},
      ...props,
    }),
  )
}

/** The markup of one card. */
function card(html: string, skill: string): string {
  const start = html.indexOf(`data-skill="${skill}"`)
  if (start === -1) throw new Error(`no card for ${skill}`)
  const next = html.indexOf('data-skill="', start + 1)
  return html.slice(start, next === -1 ? undefined : next)
}

/** The opening tag of the run button of a card. */
function runButton(cardHtml: string): string {
  const match = /<button[^>]*data-action="run"[^>]*>[\s\S]*?<\/button>/.exec(cardHtml)
  if (!match) throw new Error(`no run button in ${cardHtml}`)
  return match[0]
}

/** True when the button has the `disabled` attribute. The class names have `disabled:` in them, so the test looks for the attribute. */
function isDisabled(button: string): boolean {
  return / disabled=""/.test(button)
}

describe("SkillPanel", () => {
  it("shows one card per panel entry, in order, with its label and description", () => {
    const html = render()
    let at = -1
    for (const entry of PANEL_ENTRIES) {
      const next = html.indexOf(`data-skill="${entry.skill}"`)
      expect(next, entry.skill).toBeGreaterThan(at)
      at = next
      const cardHtml = card(html, entry.skill)
      expect(cardHtml).toContain(entry.label)
      // The description comes from SKILL.md, and the panel shows it whole.
      expect(cardHtml.replace(/&#x27;/g, "'").replace(/&quot;/g, '"')).toContain(entry.description.slice(0, 40))
    }
  })

  it("names the five buttons of the panel", () => {
    const html = render({ whiteboards: WHITEBOARDS, values: { whiteboard: BOARD_1 } })
    for (const label of ["同步 Heptabase", "融合", "健檢", "切分領域", "退回"]) expect(html).toContain(label)
  })

  it("enables the buttons that need no input", () => {
    const html = render()
    for (const skill of ["wiki-sync", "wiki-lint", "wiki-recut", "wiki-undo"]) {
      expect(isDisabled(runButton(card(html, skill))), skill).toBe(false)
    }
  })

  it("disables the fusion button and says to sync first when there is no whiteboard", () => {
    const html = card(render({ whiteboards: [] }), "wiki-fuse")

    const button = runButton(html)
    expect(isDisabled(button)).toBe(true)
    expect(button).toContain("先執行一次同步 Heptabase")
    expect(NEED_SYNC_LABEL).toBe("先執行一次同步 Heptabase")
    expect(html).not.toContain("<select")
  })

  it("offers the whiteboards in a picker, and keeps the button off until one is chosen", () => {
    const html = card(render({ whiteboards: WHITEBOARDS }), "wiki-fuse")

    expect(html).toContain("<select")
    expect(html).toContain(`value="${BOARD_1}"`)
    expect(html).toContain("example/alpha / beta")
    expect(isDisabled(runButton(html))).toBe(true)
    expect(runButton(html)).toContain("融合")
    expect(runButton(html)).not.toContain("先執行一次同步 Heptabase")
  })

  it("enables the fusion button when a whiteboard is chosen", () => {
    const html = card(render({ whiteboards: WHITEBOARDS, values: { whiteboard: BOARD_2 } }), "wiki-fuse")

    expect(isDisabled(runButton(html))).toBe(false)
    expect(html).toMatch(new RegExp(`<option value="${BOARD_2}" selected`))
  })

  it("keeps the button off for a value that is not in the list", () => {
    const html = card(render({ whiteboards: WHITEBOARDS, values: { whiteboard: "gone" } }), "wiki-fuse")

    expect(isDisabled(runButton(html))).toBe(true)
  })

  it("disables a button while its start is pending", () => {
    const html = render({ busy: new Set(["wiki-lint"]) })

    expect(isDisabled(runButton(card(html, "wiki-lint")))).toBe(true)
    expect(isDisabled(runButton(card(html, "wiki-sync")))).toBe(false)
  })

  it("disables a button while its run is running, for every button", () => {
    const html = render({
      runs: {
        "wiki-sync": { status: "running", detail: "/wiki-sync --yes" },
        "wiki-lint": { status: "running", detail: "/wiki-lint" },
      },
    })

    expect(isDisabled(runButton(card(html, "wiki-sync")))).toBe(true)
    expect(isDisabled(runButton(card(html, "wiki-lint")))).toBe(true)
    expect(isDisabled(runButton(card(html, "wiki-recut")))).toBe(false)
  })

  it("enables a button again when its run is over, whatever the result", () => {
    for (const status of ["done", "warning", "error"] as const) {
      const html = render({ runs: { "wiki-sync": { status, detail: "x" } } })
      expect(isDisabled(runButton(card(html, "wiki-sync"))), status).toBe(false)
    }
  })

  it("does not flash the sync label while the whiteboard list loads", () => {
    const html = card(render({ whiteboards: [], whiteboardsLoaded: false }), "wiki-fuse")

    const button = runButton(html)
    expect(isDisabled(button)).toBe(true)
    expect(button).toContain("融合")
    expect(button).not.toContain("先執行一次同步 Heptabase")
    expect(html).not.toContain("<select")
  })

  it("shows the picker once the list is loaded, and the sync label only for an empty loaded list", () => {
    expect(card(render({ whiteboards: WHITEBOARDS, whiteboardsLoaded: true }), "wiki-fuse")).toContain("<select")
    expect(runButton(card(render({ whiteboards: [], whiteboardsLoaded: true }), "wiki-fuse"))).toContain(
      "先執行一次同步 Heptabase",
    )
  })

  it("shows a run with denied tools as a warning, not as done", () => {
    const html = render({
      runs: { "wiki-sync": { status: "warning", detail: "Left out two cards.\n\nDenied tools: Bash" } },
    })

    expect(card(html, "wiki-sync")).toContain("Done with denied tools")
    expect(card(html, "wiki-sync")).toContain("Denied tools: Bash")
    expect(card(html, "wiki-sync")).not.toContain("Last run: Done<")
  })

  it("says how each button runs", () => {
    const html = render()

    expect(card(html, "wiki-sync")).toContain("Runs in the background")
    expect(card(html, "wiki-recut")).toContain("Opens a terminal")
  })

  it("shows the notice of a card: the text and the command to copy", () => {
    const html = render({
      notices: { "wiki-sync": { tone: "info", text: "Command copied.", command: "/wiki-sync --yes" } },
    })

    expect(card(html, "wiki-sync")).toContain("Command copied.")
    expect(card(html, "wiki-sync")).toContain("<code")
    expect(card(html, "wiki-sync")).toContain("/wiki-sync --yes")
    expect(card(html, "wiki-lint")).not.toContain("Command copied.")
  })

  it("shows an error notice", () => {
    const html = render({ notices: { "wiki-fuse": { tone: "error", text: "the whiteboard value must be a lowercase UUID" } } })

    expect(card(html, "wiki-fuse")).toContain("the whiteboard value must be a lowercase UUID")
  })

  it("shows the last run of a button, with its failure text", () => {
    const html = render({
      runs: { "wiki-sync": { status: "error", detail: "Credit balance is too low" } },
    })

    expect(card(html, "wiki-sync")).toContain("Failed")
    expect(card(html, "wiki-sync")).toContain("Credit balance is too low")
    expect(card(html, "wiki-lint")).not.toContain("Failed")
  })

  it("shows a running run and a finished run", () => {
    const html = render({
      runs: {
        "wiki-sync": { status: "running", detail: "/wiki-sync --yes\n-> Bash" },
        "wiki-lint": { status: "done", detail: "No findings." },
      },
    })

    expect(card(html, "wiki-sync")).toContain("Running")
    expect(card(html, "wiki-sync")).toContain("-&gt; Bash")
    expect(card(html, "wiki-lint")).toContain("Done")
    expect(card(html, "wiki-lint")).toContain("No findings.")
  })

  it("shows no input for a button without inputs", () => {
    const entry: PanelEntry = { skill: "wiki-lint", label: "健檢", mode: "background", inputs: [], description: "Lint." }
    expect(render({ entries: [entry] })).not.toContain("<select")
  })

  it("asks for a hypothesis path in a text field", () => {
    const entry: PanelEntry = {
      skill: "wiki-fuse",
      label: "融合",
      mode: "conversation",
      inputs: ["hypothesis"],
      description: "Fuse.",
    }
    const html = render({ entries: [entry], values: { hypothesis: "wiki/hypotheses/example.md" } })

    expect(html).toContain('value="wiki/hypotheses/example.md"')
    expect(isDisabled(runButton(card(html, "wiki-fuse")))).toBe(false)
  })
})

describe("notices", () => {
  const FUSE = PANEL_ENTRIES.find((entry) => entry.skill === "wiki-fuse") as PanelEntry
  const SYNC = PANEL_ENTRIES.find((entry) => entry.skill === "wiki-sync") as PanelEntry

  it("tells that a background run started and where its progress shows", () => {
    expect(noticeForStart(SYNC, t)).toEqual({
      tone: "info",
      text: "Started. The progress shows in the activity panel.",
    })
  })

  it("tells that a terminal opened", () => {
    expect(noticeForStart(FUSE, t)).toEqual({ tone: "info", text: "Claude Code opened in a terminal." })
  })

  it("says that the command was copied, why, and shows the command", () => {
    const missing = noticeForFallback({ reason: "claude-missing", detail: "claude was not found on PATH", command: "/wiki-sync --yes" }, t)
    expect(missing.tone).toBe("info")
    expect(missing.command).toBe("/wiki-sync --yes")
    expect(missing.text).toContain("Claude Code was not found")
    expect(missing.text).toContain("copied")
    expect(missing.text).toContain("claude was not found on PATH")

    const terminal = noticeForFallback({ reason: "terminal-failed", detail: "", command: "/wiki-fuse x" }, t)
    expect(terminal.text).toContain("No terminal could open")
    expect(terminal.text).toContain("copied")

    const spawn = noticeForFallback({ reason: "spawn-failed", detail: "boom", command: "/wiki-lint" }, t)
    expect(spawn.text).toContain("could not start")
  })

  it("shows the message of an error, and the command when copying failed too", () => {
    expect(noticeForError(new Error("the whiteboard value must be a lowercase UUID"), t)).toEqual({
      tone: "error",
      text: "the whiteboard value must be a lowercase UUID",
    })
    const copy = noticeForError(new SkillCopyError("clipboard is blocked", "/wiki-sync --yes"), t)
    expect(copy.tone).toBe("error")
    expect(copy.command).toBe("/wiki-sync --yes")
    expect(copy.text).toContain("clipboard is blocked")
    expect(noticeForError("plain text", t)).toEqual({ tone: "error", text: "plain text" })
  })
})

describe("isRunBlocked", () => {
  it("blocks a skill whose start is pending, or whose run is running", () => {
    expect(isRunBlocked("wiki-lint", new Set(["wiki-lint"]), {})).toBe(true)
    expect(isRunBlocked("wiki-lint", new Set(), { "wiki-lint": { status: "running", detail: "" } })).toBe(true)
  })

  it("does not block another skill, or a skill with no run or a finished run", () => {
    const runs = { "wiki-lint": { status: "running" as const, detail: "" } }
    expect(isRunBlocked("wiki-sync", new Set(["wiki-lint"]), runs)).toBe(false)
    expect(isRunBlocked("wiki-sync", new Set(), {})).toBe(false)
    for (const status of ["done", "warning", "error"] as const) {
      expect(isRunBlocked("wiki-sync", new Set(), { "wiki-sync": { status, detail: "" } }), status).toBe(false)
    }
  })
})

describe("shouldReloadWhiteboards", () => {
  it("is true when the sync run leaves running, whatever the result", () => {
    for (const next of ["done", "warning", "error"] as const) {
      expect(shouldReloadWhiteboards("running", next), next).toBe(true)
    }
    // The run item was removed while it ran.
    expect(shouldReloadWhiteboards("running", undefined)).toBe(true)
  })

  it("is false for every other change", () => {
    expect(shouldReloadWhiteboards(undefined, "running")).toBe(false)
    expect(shouldReloadWhiteboards("running", "running")).toBe(false)
    expect(shouldReloadWhiteboards("done", "done")).toBe(false)
    expect(shouldReloadWhiteboards("done", "running")).toBe(false)
    expect(shouldReloadWhiteboards(undefined, undefined)).toBe(false)
    expect(shouldReloadWhiteboards("error", "done")).toBe(false)
  })
})

describe("latestRuns", () => {
  const LINT = PANEL_ENTRIES.find((entry) => entry.skill === "wiki-lint") as PanelEntry
  const SYNC = PANEL_ENTRIES.find((entry) => entry.skill === "wiki-sync") as PanelEntry

  function item(overrides: Partial<ActivityItem>): ActivityItem {
    return {
      id: "activity-1",
      type: "skill",
      title: SYNC.label,
      status: "done",
      detail: "",
      filesWritten: [],
      createdAt: 1,
      projectPath: "/home/user/example-a",
      ...overrides,
    }
  }

  it("takes the newest item of each button, items come newest first", () => {
    const runs = latestRuns(
      [
        item({ id: "activity-3", status: "running", detail: "new" }),
        item({ id: "activity-2", status: "error", detail: "old" }),
        item({ id: "activity-1", title: LINT.label, status: "done", detail: "lint" }),
      ],
      PANEL_ENTRIES,
      "/home/user/example-a",
    )

    expect(runs["wiki-sync"]).toEqual({ status: "running", detail: "new" })
    expect(runs["wiki-lint"]).toEqual({ status: "done", detail: "lint" })
    expect(runs["wiki-recut"]).toBeUndefined()
  })

  it("shows only the runs of the open project after a project switch", () => {
    const items = [
      item({ id: "activity-2", status: "running", detail: "in B", projectPath: "/home/user/example-b" }),
      item({ id: "activity-1", status: "error", detail: "in A", projectPath: "/home/user/example-a" }),
    ]

    expect(latestRuns(items, PANEL_ENTRIES, "/home/user/example-a")["wiki-sync"]).toEqual({ status: "error", detail: "in A" })
    expect(latestRuns(items, PANEL_ENTRIES, "/home/user/example-b")["wiki-sync"]).toEqual({ status: "running", detail: "in B" })
    expect(latestRuns(items, PANEL_ENTRIES, "/home/user/example-c")).toEqual({})
    expect(latestRuns(items, PANEL_ENTRIES, null)).toEqual({})
  })

  it("leaves out an item with no project, an item of another type, and an item of another title", () => {
    const runs = latestRuns(
      [
        item({ projectPath: undefined }),
        item({ type: "lint" }),
        item({ title: "something else" }),
      ],
      PANEL_ENTRIES,
      "/home/user/example-a",
    )

    expect(runs).toEqual({})
  })
})

describe("lint reminder", () => {
  it("shows the count of ingests when the reminder is due", () => {
    const html = render({ lintReminder: 12 })

    expect(html).toContain("data-lint-reminder")
    expect(html).toContain("12 ingests since the last check. Consider running 健檢.")
  })

  it("says it in Traditional Chinese for the zh bundle", () => {
    const zh = i18n.getFixedT("zh")

    expect(zh("skillPanel.lintReminder", { count: 12 })).toBe("已累積 12 次收錄，建議執行健檢")
  })

  it("has the text in every language bundle with the count", () => {
    for (const lng of ["en", "it", "ru", "zh"]) {
      expect(i18n.getFixedT(lng)("skillPanel.lintReminder", { count: 12 }), lng).toContain("12")
    }
  })

  it("shows no reminder when it is not due, or when the count is unknown", () => {
    expect(render({ lintReminder: null })).not.toContain("data-lint-reminder")
    expect(render({})).not.toContain("data-lint-reminder")
  })

  it("keeps the five cards beside the reminder", () => {
    const html = render({ lintReminder: 10 })

    for (const entry of PANEL_ENTRIES) expect(html).toContain(`data-skill="${entry.skill}"`)
    // The reminder is above the cards.
    expect(html.indexOf("data-lint-reminder")).toBeLessThan(html.indexOf('data-skill="'))
  })
})

describe("runJustEnded", () => {
  it("is true when a run leaves running, whatever the result", () => {
    for (const next of ["done", "warning", "error", undefined] as const) {
      expect(runJustEnded("running", next), String(next)).toBe(true)
    }
  })

  it("is false for every other change", () => {
    expect(runJustEnded(undefined, "running")).toBe(false)
    expect(runJustEnded("running", "running")).toBe(false)
    expect(runJustEnded("done", "error")).toBe(false)
    expect(runJustEnded(undefined, undefined)).toBe(false)
  })
})
