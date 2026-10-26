import { describe, expect, it } from "vitest"
import { isSyncable, RETIRED_TITLE_PREFIX } from "./mirror-rules"

describe("isSyncable", () => {
  it("is true for a mechanism, a hypothesis, and a comparison", () => {
    for (const type of ["mechanism", "hypothesis", "comparison"]) {
      expect(isSyncable({ type, sources: [] }), type).toBe(true)
    }
  })

  it("is true for a concept with two sources and false for a concept with fewer", () => {
    expect(isSyncable({ type: "concept", sources: ["a.md", "b.md"] })).toBe(true)
    expect(isSyncable({ type: "concept", sources: ["a.md"] })).toBe(false)
    expect(isSyncable({ type: "concept", sources: [] })).toBe(false)
  })

  it("counts the distinct names of the sources", () => {
    expect(isSyncable({ type: "concept", sources: ["a.md", "a.md"] })).toBe(false)
    expect(isSyncable({ type: "concept", sources: [" a.md ", "a.md", "  "] })).toBe(false)
    expect(isSyncable({ type: "concept", sources: [" a.md ", "b.md"] })).toBe(true)
  })

  it("is false for any other type", () => {
    for (const type of ["entity", "source", "query", "", "Mechanism"]) {
      expect(isSyncable({ type, sources: ["a.md", "b.md", "c.md"] }), type).toBe(false)
    }
  })
})

describe("RETIRED_TITLE_PREFIX", () => {
  it("is the prefix that the mirror puts before the title of a retired card", () => {
    expect(RETIRED_TITLE_PREFIX).toBe("🗄 已停用｜")
  })
})
