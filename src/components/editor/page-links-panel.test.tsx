/**
 * page-links-panel.test.tsx - the link lists of a page, and what a read-only page may do with them.
 *
 * The lists render to static markup: the tests need no DOM.
 */
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { beforeEach, describe, expect, it } from "vitest"
import i18n from "@/i18n"
import type { PageLinksResponse } from "@/commands/fs"
import { PageLinksSections } from "./page-links-panel"

const LINKS: PageLinksResponse = {
  outgoing: [{ title: "Outgoing page", path: "wiki/mechanisms/outgoing.md", snippet: "Outgoing snippet." }],
  backlinks: [{ title: "Backlink page", path: "wiki/concepts/backlink.md", snippet: "Backlink snippet." }],
  missing: [{ title: "Missing page" }],
}

function render(readOnly: boolean, links: PageLinksResponse = LINKS): string {
  return renderToStaticMarkup(
    createElement(PageLinksSections, {
      links,
      readOnly,
      onOpen: () => {},
      onCreate: async () => {},
      creatingTitle: "",
    }),
  )
}

/** The markup of one section: `outgoing`, `backlinks`, or `missing`. */
function section(html: string, name: string): string {
  const start = html.indexOf(`data-section="${name}"`)
  if (start === -1) throw new Error(`no ${name} section`)
  const end = html.indexOf("</section>", start)
  return html.slice(start, end)
}

describe("PageLinksSections", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en")
  })

  it("offers Create and Draft for a missing page in a page that can be edited", () => {
    const html = render(false)

    expect(html).toContain("Missing page")
    expect(html).toContain(i18n.t("editor.pageLinks.create"))
    expect(html).toContain(i18n.t("editor.pageLinks.draft"))
    expect(section(html, "missing").match(/<button/g)).toHaveLength(2)
  })

  it("offers no Create and no Draft on a read-only page, but still lists the missing page", () => {
    const html = render(true)

    expect(html).toContain("Missing page")
    expect(html).not.toContain(i18n.t("editor.pageLinks.create"))
    expect(html).not.toContain(i18n.t("editor.pageLinks.draft"))
    expect(section(html, "missing")).not.toContain("<button")
  })

  it("keeps the outgoing links and the backlinks open on a read-only page", () => {
    const html = render(true)

    for (const title of ["Outgoing page", "Backlink page"]) {
      const button = new RegExp(`<button[^>]*>(?:(?!</button>)[\\s\\S])*${title}`).exec(html)
      expect(button, title).not.toBeNull()
      // The class names have `disabled:` in them, so the test looks for the attribute.
      expect(button![0], title).not.toContain(' disabled=""')
    }
    expect(html).toContain("Outgoing snippet.")
    expect(html).toContain("Backlink snippet.")
  })
})
