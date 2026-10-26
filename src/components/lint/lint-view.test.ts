import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { Unlink } from "lucide-react"
import { describe, expect, it, vi } from "vitest"
import {
  fixableLintItems,
  groupLintResultsForDisplay,
  isFixableLintItem,
  LintCard,
  lintItemTitle,
  lintPageCandidates,
  sendLintItemsToReview,
  shouldShowLintResults,
} from "./lint-view"
import type { LintItem } from "@/stores/lint-store"

function makeLintItem(
  page: string,
  severity: "warning" | "info",
  index: number,
): LintItem {
  return {
    id: `lint-${index}`,
    type: severity === "warning" ? "broken-link" : "orphan",
    severity,
    page,
    detail: `${page} detail`,
    createdAt: Date.now(),
  }
}

describe("groupLintResultsForDisplay", () => {
  it("groups warnings and infos separately", () => {
    const items: LintItem[] = [
      makeLintItem("info-a.md", "info", 0),
      makeLintItem("warning-b.md", "warning", 1),
      makeLintItem("info-c.md", "info", 2),
      makeLintItem("warning-d.md", "warning", 3),
    ]

    const grouped = groupLintResultsForDisplay(items)

    expect(grouped.warnings.map((item) => item.page)).toEqual([
      "warning-b.md",
      "warning-d.md",
    ])
    expect(grouped.infos.map((item) => item.page)).toEqual([
      "info-a.md",
      "info-c.md",
    ])
  })
})

describe("shouldShowLintResults", () => {
  it("shows restored persisted lint items before a new run in the current view", () => {
    expect(shouldShowLintResults(false, 2)).toBe(true)
  })

  it("keeps the first-run empty prompt when no run has happened and nothing was restored", () => {
    expect(shouldShowLintResults(false, 0)).toBe(false)
  })

  it("shows the all-clear state after a run with no items", () => {
    expect(shouldShowLintResults(true, 0)).toBe(true)
  })
})

function structureItem(overrides: Partial<LintItem> = {}): LintItem {
  return {
    id: "lint-10",
    type: "structure",
    severity: "warning",
    page: "wiki/concepts/a.md",
    detail: "Unknown domain.",
    check: "domain-unknown",
    createdAt: 1,
    ...overrides,
  }
}

/** A translator that shows the key, and the page when there is one. */
const t = (key: string, options?: Record<string, unknown>): string =>
  options?.page === undefined ? key : `${key}|${String(options.page)}`

function renderCard(item: LintItem): string {
  return renderToStaticMarkup(
    createElement(LintCard, {
      item,
      fixing: false,
      selected: false,
      onSelectedChange: () => {},
      onOpenPage: () => {},
      onFix: () => {},
      typeConfig: { orphan: { icon: Unlink, label: "Orphan" }, structure: { icon: Unlink, label: "Structure" } },
      t,
    }),
  )
}

describe("a structure item has no Fix (ruling U13)", () => {
  it("is not fixable, and the other types are", () => {
    expect(isFixableLintItem(structureItem())).toBe(false)
    expect(isFixableLintItem(makeLintItem("a.md", "info", 1))).toBe(true)
    expect(isFixableLintItem(makeLintItem("b.md", "warning", 2))).toBe(true)
  })

  it("shows no Fix button on the card of a structure item, and one on any other card", () => {
    expect(renderCard(structureItem())).not.toContain("lint.fix")
    expect(renderCard(makeLintItem("a.md", "info", 1))).toContain("lint.fix")
  })

  it("still shows the check id, the detail, and Open", () => {
    const html = renderCard(structureItem())
    expect(html).toContain("[domain-unknown]")
    expect(html).toContain("Unknown domain.")
    expect(html).toContain("lint.open")
  })

  it("keeps only the fixable items for a batch action", () => {
    const orphan = makeLintItem("a.md", "info", 1)
    const broken = makeLintItem("b.md", "warning", 2)
    expect(fixableLintItems([orphan, structureItem(), broken, structureItem({ id: "lint-11" })])).toEqual([orphan, broken])
    expect(fixableLintItems([structureItem()])).toEqual([])
  })

  it("sends only the other items to Review in a batch, and removes only those", () => {
    const orphan = makeLintItem("a.md", "info", 1)
    const broken = makeLintItem("b.md", "warning", 2)
    const send = vi.fn()
    const remove = vi.fn()

    const sent = sendLintItemsToReview([orphan, structureItem(), broken], send, remove)

    expect(send.mock.calls.map(([item]) => item)).toEqual([orphan, broken])
    expect(remove).toHaveBeenCalledOnce()
    expect(remove).toHaveBeenCalledWith([orphan.id, broken.id])
    expect(sent.map((item) => item.id)).toEqual([orphan.id, broken.id])
  })

  it("sends nothing and removes nothing when only structure items are selected", () => {
    const send = vi.fn()
    const remove = vi.fn()

    expect(sendLintItemsToReview([structureItem()], send, remove)).toEqual([])

    expect(send).not.toHaveBeenCalled()
    expect(remove).not.toHaveBeenCalled()
  })
})

describe("the label of an item with no page", () => {
  it("uses the page, or the label of the type when the page is empty", () => {
    expect(lintItemTitle(structureItem(), "Structure")).toBe("wiki/concepts/a.md")
    expect(lintItemTitle(structureItem({ page: "" }), "Structure")).toBe("Structure")
  })

  it("is the text of the select checkbox and of the card title", () => {
    const html = renderCard(structureItem({ page: "", check: "domain-too-small", detail: 'Domain "x" has 2 pages.' }))
    expect(html).toContain('aria-label="lint.selectItem|Structure"')
    expect(html).not.toContain('aria-label="lint.selectItem|"')
    expect(html).toContain('<div class="font-medium truncate">Structure</div>')
  })

  it("disables Open for a finding about a domain", () => {
    expect(renderCard(structureItem({ page: "" }))).toMatch(/<button[^>]*disabled=""[^>]*>lint\.open</)
    expect(renderCard(structureItem())).not.toMatch(/<button[^>]*disabled=""[^>]*>lint\.open</)
  })
})

describe("lintPageCandidates", () => {
  it("tries the path from the project first for a page that starts with wiki/", () => {
    expect(lintPageCandidates("/p", "wiki/concepts/a.md")).toEqual([
      "/p/wiki/concepts/a.md",
      "/p/wiki/wiki/concepts/a.md",
      "/p/wiki/wiki/concepts/a.md.md",
    ])
  })

  it("tries the path in wiki/ for any other page", () => {
    expect(lintPageCandidates("/p", "concepts/a.md")).toEqual(["/p/wiki/concepts/a.md", "/p/wiki/concepts/a.md.md"])
  })
})
