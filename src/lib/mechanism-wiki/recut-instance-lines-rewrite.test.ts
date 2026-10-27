/**
 * recut-instance-lines-rewrite.test.ts - tests for the rewrite of the `(<domain>)` of Known instances lines (ruling U4).
 *
 * A line has the form `- [[<slug>]] (<domain>): <term>` under the heading "Known instances" (or its Chinese
 * variants). The rest of the page must not change. Slugs and domains are placeholders.
 */
import { describe, expect, it } from "vitest"
import { rewriteInstanceLines } from "./recut-instance-lines"

const rename = (domain: string): string => (domain === "example/alpha" ? "example/gamma" : domain)

describe("rewriteInstanceLines", () => {
  it("rewrites the domain of each line of the section and nothing else", () => {
    const page = [
      "---",
      "type: mechanism",
      "---",
      "# Handshake",
      "",
      "## Parts",
      "- [[part-one]] (example/alpha): not an instance line",
      "",
      "## Known instances",
      "",
      "- [[async-handshake]] (example/alpha): request and ack",
      "- [[other-thing]]   (  example/beta ) : spaced",
      "* [[third-thing]] (example/alpha): star bullet, with (example/alpha) in the term",
      "  - ![[embedded]] (example/alpha): nested and embedded",
      "- [[no-domain]]: no parentheses",
      "A sentence with [[a-link]] (example/alpha) that is no list item.",
      "",
      "## Why it works",
      "- [[after]] (example/alpha): another section",
      "",
    ].join("\n")
    const result = rewriteInstanceLines(page, (domain) => rename(domain))
    expect(result.changed).toBe(3)
    expect(result.unresolved).toEqual([])
    expect(result.text).toBe(
      page
        .replace("- [[async-handshake]] (example/alpha)", "- [[async-handshake]] (example/gamma)")
        .replace("* [[third-thing]] (example/alpha): star bullet, with (example/alpha)", "* [[third-thing]] (example/gamma): star bullet, with (example/alpha)")
        .replace("  - ![[embedded]] (example/alpha)", "  - ![[embedded]] (example/gamma)"),
    )
  })

  it("reads the heading in every language, with or without a colon", () => {
    for (const heading of ["Known instances", "known INSTANCES:", "已知實例", "已知实例：", "已知實例"]) {
      const result = rewriteInstanceLines(`## ${heading}\n- [[a]] (example/alpha): t\n`, (domain) => rename(domain))
      expect(result.text, heading).toBe(`## ${heading}\n- [[a]] (example/gamma): t\n`)
    }
  })

  it("keeps CRLF line breaks and the last line without a line break", () => {
    const result = rewriteInstanceLines("# T\r\n## Known instances\r\n- [[a]] (example/alpha): t\r\n- [[b]] (example/alpha): u", (domain) => rename(domain))
    expect(result.text).toBe("# T\r\n## Known instances\r\n- [[a]] (example/gamma): t\r\n- [[b]] (example/gamma): u")
    expect(result.changed).toBe(2)
  })

  it("gives the resolver the slug of the link, without an alias or a heading", () => {
    const seen: Array<[string, string]> = []
    rewriteInstanceLines(
      "## Known instances\n- [[plain]] (d/one): t\n- [[with-alias|Alias]] (d/two): t\n- [[with-heading#Part]] (d/three): t\n- [[ spaced ]] (d/four): t\n",
      (domain, slug) => {
        seen.push([domain, slug])
        return domain
      },
    )
    expect(seen).toEqual([
      ["d/one", "plain"],
      ["d/two", "with-alias"],
      ["d/three", "with-heading"],
      ["d/four", "spaced"],
    ])
  })

  it("leaves a line alone when the resolver cannot decide, and reports it", () => {
    const page = "## Known instances\n- [[a]] (example/alpha): t\n- [[b]] (example/beta): u\n"
    const result = rewriteInstanceLines(page, (domain, slug) => (slug === "a" ? null : domain))
    expect(result.text).toBe(page)
    expect(result.changed).toBe(0)
    expect(result.unresolved).toEqual([{ slug: "a", domain: "example/alpha" }])
  })

  it("leaves a page without the section alone", () => {
    const page = "# T\n\n- [[a]] (example/alpha): t\n"
    expect(rewriteInstanceLines(page, (domain) => rename(domain))).toEqual({ text: page, changed: 0, unresolved: [] })
  })
})
