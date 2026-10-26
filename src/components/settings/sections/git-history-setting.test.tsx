/**
 * git-history-setting.test.tsx - how the "Version history (git)" switch looks.
 *
 * The switch renders to static markup: the tests need no DOM. What a press does is tested in
 * `src/lib/git-history-setting.test.ts`.
 */
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import i18n from "@/i18n"
import { GitHistoryToggle, type GitHistoryToggleProps } from "./git-history-setting"

function render(props: Partial<GitHistoryToggleProps> = {}): string {
  return renderToStaticMarkup(
    createElement(GitHistoryToggle, {
      enabled: false,
      busy: false,
      disabled: false,
      error: null,
      onToggle: () => {},
      ...props,
    }),
  )
}

/** The opening tag of the switch. */
function switchTag(html: string): string {
  const match = /<button[^>]*role="switch"[^>]*>/.exec(html)
  if (!match) throw new Error(`no switch in ${html}`)
  return match[0]
}

function isDisabled(tag: string): boolean {
  return / disabled=""/.test(tag)
}

describe("GitHistoryToggle", () => {
  it("has a short label and a one-line help text", () => {
    const html = render()

    expect(html).toContain("Version history (git)")
    expect(html).toContain("Each ingest becomes one git commit that you can undo.")
  })

  it("shows the state of the switch", () => {
    expect(switchTag(render({ enabled: true }))).toContain('aria-checked="true"')
    expect(switchTag(render({ enabled: false }))).toContain('aria-checked="false"')
    expect(switchTag(render({ enabled: null }))).toContain('aria-checked="false"')
  })

  it("is off while the state loads, while a press is handled, and when there is no project", () => {
    expect(isDisabled(switchTag(render({ enabled: false })))).toBe(false)
    expect(isDisabled(switchTag(render({ enabled: true })))).toBe(false)
    expect(isDisabled(switchTag(render({ enabled: null })))).toBe(true)
    expect(isDisabled(switchTag(render({ busy: true })))).toBe(true)
    expect(isDisabled(switchTag(render({ disabled: true })))).toBe(true)
  })

  it("shows an error", () => {
    const html = render({ error: "Version history could not be turned on." })

    expect(html).toContain('role="alert"')
    expect(html).toContain("Version history could not be turned on.")
    expect(render()).not.toContain('role="alert"')
  })

  it("has its text in every language bundle", () => {
    for (const lng of ["en", "it", "ru", "zh"]) {
      const t = i18n.getFixedT(lng)
      for (const key of ["title", "hint", "failed"]) {
        const text = t(`settings.sections.maintenance.gitHistory.${key}`)
        expect(text, `${lng} ${key}`).not.toBe(`settings.sections.maintenance.gitHistory.${key}`)
        expect(text.length, `${lng} ${key}`).toBeGreaterThan(0)
      }
    }
  })
})
