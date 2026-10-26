/**
 * domain-picker.test.tsx - the picker of "Use an existing domain" (spec 6.6).
 *
 * The form renders to static markup: the tests need no DOM. Domains are placeholders.
 */
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import "@/i18n"
import { DomainPickerForm } from "./domain-picker"

function render(props: { domains?: string[]; proposed?: string; initial?: string } = {}): string {
  return renderToStaticMarkup(
    createElement(DomainPickerForm, {
      domains: props.domains ?? ["example/alpha", "example/beta/child"],
      proposed: props.proposed ?? "example/new",
      initial: props.initial,
      onChoose: () => {},
      onCancel: () => {},
    }),
  )
}

describe("DomainPickerForm", () => {
  it("shows a select with an empty first choice and one option for each domain of domains.yaml", () => {
    const html = render()
    expect(html).toContain("<select")
    const options = [...html.matchAll(/<option value="([^"]*)"/g)].map((match) => match[1])
    expect(options).toEqual(["", "example/alpha", "example/beta/child"])
  })

  it("names the proposed domain", () => {
    expect(render({ proposed: "example/new" })).toContain("example/new")
  })

  it("has a Cancel button, and a confirm button that is off until a domain is chosen", () => {
    const empty = render()
    expect(empty).toMatch(/<button[^>]*>Cancel<\/button>/)
    expect(empty).toMatch(/<button[^>]*disabled=""[^>]*>Use this domain<\/button>/)
    const chosen = render({ initial: "example/alpha" })
    expect(chosen).toMatch(/<option value="example\/alpha" selected=""/)
    expect(chosen).not.toMatch(/<button[^>]*disabled=""[^>]*>Use this domain<\/button>/)
  })

  it("escapes a domain name", () => {
    expect(render({ domains: ['a"<b>'] })).not.toContain('a"<b>')
  })
})

describe("the review view", () => {
  const view = readFileSync(fileURLToPath(new URL("./review-view.tsx", import.meta.url)), "utf8")

  it("gives the mechanism action handler a picker and a commit, and shows the picker", () => {
    expect(view).toMatch(/chooseDomain: pickDomain/)
    expect(view).toMatch(/commit: async \(paths, message\) =>/)
    expect(view).toContain("<DomainPickerDialog request={domainPicker} />")
  })

  it("commits through the git history of the project, and only when version history is on", () => {
    expect(view).toMatch(/if \(await resolveGitHistory\(project\.id, pp\)\) await commitReviewAction\(pp, paths, message\)/)
  })

  it("settles a picker that is open when the view goes away", () => {
    expect(view).toMatch(/useEffect\(\(\) => \(\) => pendingPicker\.current\?\.resolve\(null\), \[\]\)/)
  })
})
