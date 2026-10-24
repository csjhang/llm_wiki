import { describe, expect, it } from "vitest"
import { emptyDecisions } from "./types"

describe("emptyDecisions", () => {
  it("keeps the domain and leaves everything else empty", () => {
    expect(emptyDecisions("ai/architecture")).toEqual({
      domain: "ai/architecture",
      proposedDomain: null,
      mechanisms: [],
      problems: [],
    })
  })

  it("accepts a null domain", () => {
    expect(emptyDecisions(null).domain).toBeNull()
  })

  it("returns a new object each time", () => {
    const a = emptyDecisions(null)
    a.mechanisms.push({ kind: "new", slug: "x", summary: "y" })
    expect(emptyDecisions(null).mechanisms).toEqual([])
  })
})
