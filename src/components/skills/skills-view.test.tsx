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
import { NEED_SYNC_LABEL, SkillPanel, noticeForFallback, noticeForStart, noticeForError, type SkillPanelProps } from "./skills-view"

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
