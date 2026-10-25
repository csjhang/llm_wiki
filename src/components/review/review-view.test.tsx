/**
 * review-view.test.tsx - how a review card shows its text and its notice.
 *
 * The card renders to static markup: the tests need no DOM.
 */
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import type { ReviewItem } from "@/stores/review-store"
import { ReviewCard } from "./review-view"

function item(overrides: Partial<ReviewItem> = {}): ReviewItem {
  return {
    id: "review-1a2b3c4d",
    type: "fusion-candidate",
    title: "Fusion candidates for event-driven",
    description: "Domains where it may also work:\nCANDIDATE: business/inventory | structural | one\nCANDIDATE: hardware/async | surface | two",
    options: [{ label: "Skip", action: "mech:dismiss-fusion" }],
    resolved: false,
    createdAt: 1,
    ...overrides,
  }
}

function render(props: { item?: ReviewItem; notice?: string; error?: string } = {}): string {
  return renderToStaticMarkup(
    createElement(ReviewCard, {
      item: props.item ?? item(),
      onResolve: () => {},
      onDismiss: () => {},
      selected: false,
      onSelectedChange: () => {},
      working: false,
      error: props.error,
      notice: props.notice,
    }),
  )
}

describe("ReviewCard", () => {
  it("keeps the line breaks of the description, so each CANDIDATE line shows on its own line", () => {
    const html = render()
    const paragraph = /<p class="([^"]*)">Domains where it may also work:\nCANDIDATE/.exec(html)
    expect(paragraph, html).not.toBeNull()
    expect(paragraph?.[1]).toContain("whitespace-pre-line")
  })

  it("shows a notice, and none when there is no notice", () => {
    expect(render({ notice: "Copied: /wiki-fuse --candidate review-1a2b3c4d" })).toContain("Copied: /wiki-fuse --candidate review-1a2b3c4d")
    expect(render()).not.toContain("Copied")
  })

  it("shows the notice of an open item only, not of a resolved one", () => {
    expect(render({ item: item({ resolved: true, resolvedAction: "Skipped" }), notice: "Copied: x" })).not.toContain("Copied: x")
  })

  it("still shows an error", () => {
    expect(render({ error: "clipboard is blocked" })).toContain("clipboard is blocked")
  })
})
