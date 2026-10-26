/**
 * discard-edits.test.ts - the list of mirror pages whose Heptabase edit the user chose to discard.
 *
 * The app adds a page (`mech:discard-mirror-edit`); `wiki-tool hepta plan-down` reads the list and
 * `hepta record updated` takes the page out. Page paths are placeholders.
 */
import { describe, expect, it } from "vitest"
import {
  addDiscardEdit,
  DISCARD_EDITS_FILE,
  discardEditPage,
  parseDiscardEdits,
  removeDiscardEdit,
  renderDiscardEdits,
} from "./discard-edits"

describe("DISCARD_EDITS_FILE", () => {
  it("is in the hepta folder of .llm-wiki", () => {
    expect(DISCARD_EDITS_FILE).toBe(".llm-wiki/hepta/discard-edits.json")
  })
})

describe("discardEditPage", () => {
  it("takes a path of a page in wiki/ and writes it with forward slashes", () => {
    expect(discardEditPage("wiki/mechanisms/alpha.md")).toBe("wiki/mechanisms/alpha.md")
    expect(discardEditPage("  ./wiki\\concepts\\beta.md ")).toBe("wiki/concepts/beta.md")
  })

  it("refuses a path outside wiki/, a path with .., and a file that is not .md", () => {
    for (const path of ["", "raw/sources/a.md", "/wiki/a.md", "wiki/../raw/a.md", "wiki/a.txt", "wiki/", "../wiki/a.md", "C:/wiki/a.md"]) {
      expect(discardEditPage(path), path).toBeNull()
    }
  })
})

describe("parseDiscardEdits", () => {
  it("reads a JSON array of page paths", () => {
    expect(parseDiscardEdits('["wiki/a.md", "wiki/b.md"]')).toEqual({ ok: true, pages: ["wiki/a.md", "wiki/b.md"] })
  })

  it("reads an empty file and a byte order mark as no pages", () => {
    expect(parseDiscardEdits("")).toEqual({ ok: true, pages: [] })
    expect(parseDiscardEdits("\uFEFF[]")).toEqual({ ok: true, pages: [] })
  })

  it("drops a duplicate and keeps the order", () => {
    expect(parseDiscardEdits('["wiki/b.md", "wiki/a.md", "wiki/b.md"]')).toEqual({ ok: true, pages: ["wiki/b.md", "wiki/a.md"] })
  })

  it("refuses text that is not JSON, not an array, or has an item that is not a page path", () => {
    for (const text of ["{", '{"pages": []}', '["wiki/a.md", 3]', '["raw/a.md"]', "null"]) {
      const result = parseDiscardEdits(text)
      expect(result.ok, text).toBe(false)
      if (!result.ok) expect(result.reason, text).toContain("discard-edits.json")
    }
  })
})

describe("addDiscardEdit and removeDiscardEdit", () => {
  it("adds a page once", () => {
    expect(addDiscardEdit([], "wiki/a.md")).toEqual(["wiki/a.md"])
    expect(addDiscardEdit(["wiki/a.md"], "wiki/a.md")).toEqual(["wiki/a.md"])
    expect(addDiscardEdit(["wiki/a.md"], "wiki/b.md")).toEqual(["wiki/a.md", "wiki/b.md"])
  })

  it("removes a page and leaves the others", () => {
    expect(removeDiscardEdit(["wiki/a.md", "wiki/b.md"], "wiki/a.md")).toEqual(["wiki/b.md"])
    expect(removeDiscardEdit(["wiki/a.md"], "wiki/c.md")).toEqual(["wiki/a.md"])
  })
})

describe("renderDiscardEdits", () => {
  it("is a JSON array with a line break at the end, and reads back", () => {
    const text = renderDiscardEdits(["wiki/a.md", "wiki/b.md"])
    expect(text.endsWith("\n")).toBe(true)
    expect(parseDiscardEdits(text)).toEqual({ ok: true, pages: ["wiki/a.md", "wiki/b.md"] })
    expect(renderDiscardEdits([])).toBe("[]\n")
  })
})
