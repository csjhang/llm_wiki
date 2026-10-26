/**
 * frontmatter-edit.test.ts - tests for the in-place edit of the domain keys of a page.
 *
 * The edit changes the text of the named keys and nothing else, so most tests compare the whole result with the
 * expected text. Domains and slugs are placeholders.
 */
import { describe, expect, it } from "vitest"
import { editDomainKeys, type DomainKeyRewrite } from "./frontmatter-edit"

const SINGLE = ["domain", "from_domain", "to_domain"] as const

/** A rewrite that renames one domain in every value and keeps all list items. */
function renaming(from: string, to: string): DomainKeyRewrite {
  return {
    singleKeys: SINGLE,
    value: (_key, old) => (old === from ? to : old),
    also: (old) => old.map((item) => ({ value: item === from ? to : item, redundant: false })),
  }
}

function edit(text: string, rewrite: DomainKeyRewrite) {
  const result = editDomainKeys(text, rewrite)
  if (!result.ok) throw new Error(`edit failed: ${result.reason}`)
  return result
}

describe("editDomainKeys: a single value", () => {
  it("keeps every other byte of the page", () => {
    const text = [
      "---",
      "# A comment before the keys",
      'title:   "Placeholder: a title"   # quoted, with spaces',
      "type: concept",
      "domain: example/alpha",
      "sources: [ 'a.md' ,  \"b.md\" ]",
      "created: 2026-10-01",
      "note: >",
      "  domain: example/alpha",
      "  stays in the folded text",
      "---",
      "",
      "domain: example/alpha",
      "Body with a [[link]]  and trailing spaces  ",
      "",
    ].join("\n")
    const result = edit(text, renaming("example/alpha", "example/gamma"))
    expect(result.changed).toBe(true)
    expect(result.text).toBe(text.replace("\ndomain: example/alpha\nsources", "\ndomain: example/gamma\nsources"))
  })

  it("keeps the quote style and a trailing comment", () => {
    const double = edit('---\ndomain: "example/alpha"  # why\n---\nBody\n', renaming("example/alpha", "example/gamma"))
    expect(double.text).toBe('---\ndomain: "example/gamma"  # why\n---\nBody\n')
    const single = edit("---\ndomain: 'example/alpha'\n---\nBody\n", renaming("example/alpha", "example/gamma"))
    expect(single.text).toBe("---\ndomain: 'example/gamma'\n---\nBody\n")
    const spaced = edit("---\ndomain:    example/alpha   # c\n---\nBody\n", renaming("example/alpha", "example/gamma"))
    expect(spaced.text).toBe("---\ndomain:    example/gamma   # c\n---\nBody\n")
  })

  it("leaves a page alone when no value changes", () => {
    const text = "---\ndomain: example/beta\nalso: [example/gamma]\n---\nBody\n"
    const result = edit(text, renaming("example/alpha", "example/zeta"))
    expect(result).toEqual({ ok: true, changed: false, text })
  })

  it("rewrites from_domain and to_domain of a hypothesis page", () => {
    const text = "---\ntype: hypothesis\nfrom_domain: example/alpha\nto_domain: example/alpha # same\nstatus: draft\n---\nBody\n"
    const result = edit(text, renaming("example/alpha", "example/gamma"))
    expect(result.text).toBe("---\ntype: hypothesis\nfrom_domain: example/gamma\nto_domain: example/gamma # same\nstatus: draft\n---\nBody\n")
  })

  it("edits only the keys it is asked for", () => {
    const text = "---\ndomain: example/alpha\nto_domain: example/alpha\n---\nBody\n"
    const result = edit(text, { ...renaming("example/alpha", "example/gamma"), singleKeys: ["domain"] })
    expect(result.text).toBe("---\ndomain: example/gamma\nto_domain: example/alpha\n---\nBody\n")
  })

  it("does not match a key with a similar name, an indented key, or the body", () => {
    const text = [
      "---",
      "domain_note: example/alpha",
      "domains: example/alpha",
      "meta:",
      "  domain: example/alpha",
      "---",
      "domain: example/alpha",
      "",
    ].join("\n")
    const result = edit(text, renaming("example/alpha", "example/gamma"))
    expect(result).toEqual({ ok: true, changed: false, text })
  })

  it("quotes a new value that YAML would not read as a string", () => {
    const result = edit("---\ndomain: example/alpha\n---\nBody\n", renaming("example/alpha", "123"))
    expect(result.text).toBe('---\ndomain: "123"\n---\nBody\n')
  })

  it("keeps a byte order mark and the line breaks of a CRLF page", () => {
    const text = "\uFEFF---\r\ntitle: T\r\ndomain: example/alpha\r\nalso:\r\n  - example/alpha\r\n---\r\nBody\r\n"
    const result = edit(text, renaming("example/alpha", "example/gamma"))
    expect(result.text).toBe("\uFEFF---\r\ntitle: T\r\ndomain: example/gamma\r\nalso:\r\n  - example/gamma\r\n---\r\nBody\r\n")
  })

  it("finds frontmatter that the app reads after a line of code fence", () => {
    const text = "```yaml\n---\ndomain: example/alpha\ntype: concept\n---\n```\nBody\n"
    const result = edit(text, renaming("example/alpha", "example/gamma"))
    expect(result.text).toBe("```yaml\n---\ndomain: example/gamma\ntype: concept\n---\n```\nBody\n")
  })

  it("leaves a page without frontmatter alone", () => {
    const text = "domain: example/alpha\n\nBody\n"
    expect(edit(text, renaming("example/alpha", "example/gamma"))).toEqual({ ok: true, changed: false, text })
  })

  it("passes by a key with an empty value", () => {
    const text = "---\ndomain:\nto_domain: # none yet\nalso: [example/alpha]\n---\nBody\n"
    const result = edit(text, renaming("example/alpha", "example/gamma"))
    expect(result.text).toBe("---\ndomain:\nto_domain: # none yet\nalso: [example/gamma]\n---\nBody\n")
  })

  it("refuses a form it cannot edit safely", () => {
    for (const front of ["domain: |\n  example/alpha", "domain: [example/alpha]", "domain:\n  example/alpha"]) {
      const result = editDomainKeys(`---\n${front}\n---\nBody\n`, renaming("example/alpha", "example/gamma"))
      expect(result.ok, front).toBe(false)
      if (!result.ok) expect(result.reason).toContain("domain")
    }
  })
})

describe("editDomainKeys: the also list", () => {
  it("rewrites a flow list item by item and keeps its spacing, quotes, and comment", () => {
    const text = "---\nalso: [ \"example/alpha\" ,example/beta, 'example/alpha' ] # note\n---\nBody\n"
    const result = edit(text, renaming("example/alpha", "example/gamma"))
    expect(result.text).toBe("---\nalso: [ \"example/gamma\" ,example/beta, 'example/gamma' ] # note\n---\nBody\n")
  })

  it("rewrites a block list and keeps comments, quotes, and the indent", () => {
    const text = "---\nalso:\n  - example/alpha   # first\n  # between\n  - \"example/beta\"\n  - 'example/alpha'\ntags: [x]\n---\nBody\n"
    const result = edit(text, renaming("example/alpha", "example/gamma"))
    expect(result.text).toBe("---\nalso:\n  - example/gamma   # first\n  # between\n  - \"example/beta\"\n  - 'example/gamma'\ntags: [x]\n---\nBody\n")
  })

  it("reads a block list whose dashes start in the first column", () => {
    const text = "---\nalso:\n- example/alpha\n- example/beta\ntype: concept\n---\nBody\n"
    const result = edit(text, renaming("example/alpha", "example/gamma"))
    expect(result.text).toBe("---\nalso:\n- example/gamma\n- example/beta\ntype: concept\n---\nBody\n")
  })

  it("rewrites a list that runs over several lines, with comments", () => {
    const text = "---\nalso: [\n  example/alpha, # first\n  example/beta,\n]\ntype: concept\n---\nBody\n"
    const result = edit(text, renaming("example/alpha", "example/gamma"))
    expect(result.text).toBe("---\nalso: [\n  example/gamma, # first\n  example/beta,\n]\ntype: concept\n---\nBody\n")
  })

  it("reads a single value as a list of one", () => {
    const result = edit("---\nalso: example/alpha  # one\n---\nBody\n", renaming("example/alpha", "example/gamma"))
    expect(result.text).toBe("---\nalso: example/gamma  # one\n---\nBody\n")
  })

  const dropping: DomainKeyRewrite = {
    singleKeys: SINGLE,
    value: (_key, old) => old,
    also: (old) => old.map((item) => ({ value: item, redundant: item.endsWith("/drop") })),
  }

  it("drops a redundant item of a flow list on one line", () => {
    expect(edit("---\nalso: [example/a/drop, example/b, example/c/drop]\n---\nB\n", dropping).text).toBe("---\nalso: [example/b]\n---\nB\n")
    expect(edit("---\nalso: [example/a, example/b/drop,example/c]  # k\n---\nB\n", dropping).text).toBe("---\nalso: [example/a,example/c]  # k\n---\nB\n")
    expect(edit("---\nalso: [example/a/drop, example/b/drop]\n---\nB\n", dropping).text).toBe("---\nalso: []\n---\nB\n")
  })

  it("drops a redundant item of a block list, and writes [] when none is left", () => {
    const some = edit("---\nalso:\n  - example/a/drop\n  - example/b\n---\nB\n", dropping)
    expect(some.text).toBe("---\nalso:\n  - example/b\n---\nB\n")
    const none = edit("---\nalso:  # who\n  - example/a/drop\n  - example/b/drop\ntype: concept\n---\nB\n", dropping)
    expect(none.text).toBe("---\nalso: []  # who\ntype: concept\n---\nB\n")
  })

  it("keeps a redundant item of a list over several lines, because a drop would lose its comments", () => {
    const text = "---\nalso: [\n  example/a/drop, # keep me\n  example/b,\n]\n---\nB\n"
    expect(edit(text, dropping)).toEqual({ ok: true, changed: false, text })
  })

  it("replaces a redundant single value with an empty list", () => {
    expect(edit("---\nalso: example/a/drop # c\n---\nB\n", dropping).text).toBe("---\nalso: [] # c\n---\nB\n")
  })

  it("does not call the also rewrite for a page without the key", () => {
    let called = false
    const rewrite: DomainKeyRewrite = {
      singleKeys: SINGLE,
      value: (_key, old) => old,
      also: (old) => {
        called = true
        return old.map((value) => ({ value, redundant: false }))
      },
    }
    edit("---\ndomain: example/alpha\n---\nBody\n", rewrite)
    expect(called).toBe(false)
  })

  it("leaves a page alone whose frontmatter is not valid YAML, for example a list that is not closed", () => {
    const text = "---\nalso: [example/alpha, example/beta\ntype: concept\n---\nBody\n"
    expect(edit(text, renaming("example/alpha", "example/gamma"))).toEqual({ ok: true, changed: false, text })
  })

  it("refuses a list of nested values", () => {
    const result = editDomainKeys("---\nalso: [[example/alpha]]\n---\nBody\n", renaming("example/alpha", "example/gamma"))
    expect(result.ok).toBe(false)
  })
})
