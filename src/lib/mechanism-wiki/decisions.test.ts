import { describe, expect, it } from "vitest"
import type { DomainsConfig } from "@/lib/wiki-config/domains"
import type { WikiIdentity } from "@/lib/wiki-config/wiki-identity"
import type { LensDoc, MechanismContext } from "./context"
import { parseAnalysisDecisions } from "./decisions"

const DOMAINS: DomainsConfig = {
  version: 1,
  domains: {
    "hardware/async-circuits": {
      lens: "hardware",
      description: "Digital circuits without a global clock",
      whiteboards: [],
    },
    "ai/architecture": {
      lens: "ai",
      description: "Designs of neural networks and the hardware that runs them",
      whiteboards: [],
    },
  },
}

const READING: WikiIdentity = { version: 1, id: "reading", role: "reading", mechanism_library: null }

function lensDoc(id: string): LensDoc {
  return { id, text: `# ${id}`, promptText: `# ${id}` }
}

function makeCtx(overrides: Partial<MechanismContext> = {}): MechanismContext {
  return {
    projectPath: "/projects/wiki",
    identity: READING,
    identityStatus: "ok",
    domains: DOMAINS,
    lenses: { hardware: lensDoc("hardware"), ai: lensDoc("ai"), business: lensDoc("business") },
    pageTypeRules: {},
    mechanismLibraryPath: "/projects/wiki",
    configIssues: [],
    ...overrides,
  }
}

const NO_MECHANISMS: ReadonlySet<string> = new Set()

function parse(
  analysis: string,
  options: { ctx?: MechanismContext; fallback?: string | null; existing?: ReadonlySet<string> } = {},
) {
  return parseAnalysisDecisions(
    analysis,
    options.ctx ?? makeCtx(),
    options.fallback ?? null,
    options.existing ?? NO_MECHANISMS,
  )
}

describe("parseAnalysisDecisions", () => {
  it("parses domain and mechanisms", () => {
    const analysis = [
      "## Analysis",
      "Some prose.",
      "",
      "## Decisions",
      "DOMAIN: hardware/async-circuits",
      "MECHANISM: existing:event-driven-computing | Work happens only when an event arrives",
      "MECHANISM: new:backpressure | A slow consumer slows the producer",
    ].join("\n")

    const result = parse(analysis, { existing: new Set(["event-driven-computing"]) })

    expect(result).toEqual({
      domain: "hardware/async-circuits",
      proposedDomain: null,
      mechanisms: [
        { kind: "existing", slug: "event-driven-computing", summary: "Work happens only when an event arrives" },
        { kind: "new", slug: "backpressure", summary: "A slow consumer slows the producer" },
      ],
      problems: [],
    })
  })

  it("uses the last Decisions section", () => {
    const analysis = [
      "## Decisions",
      "DOMAIN: ai/architecture",
      "MECHANISM: new:first-draft | Dropped in the second pass",
      "",
      "## Revised analysis",
      "Text.",
      "",
      "## Decisions",
      "DOMAIN: hardware/async-circuits",
      "MECHANISM: new:backpressure | A slow consumer slows the producer",
    ].join("\n")

    const result = parse(analysis)

    expect(result.domain).toBe("hardware/async-circuits")
    expect(result.mechanisms.map((m) => m.slug)).toEqual(["backpressure"])
    expect(result.problems).toEqual([])
  })

  it("unknown DOMAIN becomes a proposal", () => {
    const result = parse("## Decisions\nDOMAIN: hardware/async-circuits/handshakes\n")

    expect(result.domain).toBeNull()
    expect(result.proposedDomain).toEqual({
      path: "hardware/async-circuits/handshakes",
      lens: "hardware",
      description: "Part of hardware/async-circuits: Digital circuits without a global clock",
    })
    expect(result.problems).toEqual([])
  })

  it("uses the nearest listed ancestor for the lens of a proposal", () => {
    const ctx = makeCtx({
      domains: {
        version: 1,
        domains: {
          ...DOMAINS.domains,
          "hardware/async-circuits/handshakes": {
            lens: "physics",
            description: "Request and acknowledge wires",
            whiteboards: [],
          },
        },
      },
    })

    const result = parse("## Decisions\nDOMAIN: hardware/async-circuits/handshakes/four-phase\n", { ctx })

    expect(result.proposedDomain?.lens).toBe("physics")
  })

  it("makes an unknown DOMAIN with no listed ancestor a problem and falls back to the hint", () => {
    const result = parse("## Decisions\nDOMAIN: cooking/pasta\n", { fallback: "ai/architecture" })

    expect(result.domain).toBe("ai/architecture")
    expect(result.proposedDomain).toBeNull()
    expect(result.problems.join("\n")).toContain("cooking/pasta")
  })

  it("makes a DOMAIN with an invalid name a problem", () => {
    const result = parse("## Decisions\nDOMAIN: Hardware Stuff\n")

    expect(result.domain).toBeNull()
    expect(result.proposedDomain).toBeNull()
    expect(result.problems.join("\n")).toContain("Hardware Stuff")
  })

  it("reads a valid NEW-DOMAIN as a proposal", () => {
    const result = parse(
      "## Decisions\nNEW-DOMAIN: business/franchising | business | Growing a business by licensing its brand\n",
    )

    expect(result.domain).toBeNull()
    expect(result.proposedDomain).toEqual({
      path: "business/franchising",
      lens: "business",
      description: "Growing a business by licensing its brand",
    })
    expect(result.problems).toEqual([])
  })

  it("keeps a pipe inside the NEW-DOMAIN description", () => {
    const result = parse("## Decisions\nNEW-DOMAIN: business/franchising | business | Brand | system licensing\n")

    expect(result.proposedDomain?.description).toBe("Brand | system licensing")
  })

  it("NEW-DOMAIN with bad name is a problem", () => {
    const result = parse(
      "## Decisions\nNEW-DOMAIN: Business Franchising | business | Growing a business\n",
      { fallback: "ai/architecture" },
    )

    expect(result.proposedDomain).toBeNull()
    expect(result.domain).toBe("ai/architecture")
    expect(result.problems.join("\n")).toContain("Business Franchising")
  })

  it("makes a NEW-DOMAIN with an unknown lens a problem", () => {
    const result = parse("## Decisions\nNEW-DOMAIN: business/franchising | cooking | Growing a business\n")

    expect(result.proposedDomain).toBeNull()
    expect(result.problems.join("\n")).toContain("cooking")
  })

  it("accepts the lens of a lens file and a built-in lens without a file", () => {
    const ctx = makeCtx({ lenses: { hardware: lensDoc("hardware"), biology: lensDoc("biology") } })

    expect(parse("## Decisions\nNEW-DOMAIN: life/cells | biology | Living cells\n", { ctx }).proposedDomain?.lens).toBe(
      "biology",
    )
    expect(parse("## Decisions\nNEW-DOMAIN: life/stars | physics | Stars\n", { ctx }).proposedDomain?.lens).toBe(
      "physics",
    )
  })

  it("makes a NEW-DOMAIN with a missing part or an empty description a problem", () => {
    for (const line of [
      "NEW-DOMAIN: business/franchising",
      "NEW-DOMAIN: business/franchising | business",
      "NEW-DOMAIN: business/franchising | business |   ",
    ]) {
      const result = parse(`## Decisions\n${line}\n`)
      expect(result.proposedDomain, line).toBeNull()
      expect(result.problems.length, line).toBeGreaterThan(0)
    }
  })

  it("reads a NEW-DOMAIN that names a listed domain as that domain", () => {
    const result = parse("## Decisions\nNEW-DOMAIN: ai/architecture | ai | Neural networks\n")

    expect(result.domain).toBe("ai/architecture")
    expect(result.proposedDomain).toBeNull()
    expect(result.problems).toEqual([])
  })

  it("uses the first valid domain line and reports the others", () => {
    const result = parse("## Decisions\nDOMAIN: cooking/pasta\nDOMAIN: ai/architecture\nDOMAIN: hardware/async-circuits\n")

    expect(result.domain).toBe("ai/architecture")
    // The unlisted line is a problem, and so is the second valid one.
    expect(result.problems).toHaveLength(2)
  })

  it("falls back to the hint when the section has no domain line", () => {
    const result = parse("## Decisions\nMECHANISM: new:backpressure | A slow consumer slows the producer\n", {
      fallback: "hardware/async-circuits",
    })

    expect(result.domain).toBe("hardware/async-circuits")
    expect(result.mechanisms).toHaveLength(1)
    expect(result.problems).toHaveLength(1)
    expect(result.problems[0]).toMatch(/DOMAIN/)
  })

  it("existing slug not found becomes new", () => {
    const result = parse(
      [
        "## Decisions",
        "DOMAIN: ai/architecture",
        "MECHANISM: existing:event-driven-computing | Work happens only when an event arrives",
        "MECHANISM: existing:ghost-mechanism | Not in the library",
      ].join("\n"),
      { existing: new Set(["event-driven-computing"]) },
    )

    expect(result.mechanisms).toEqual([
      { kind: "existing", slug: "event-driven-computing", summary: "Work happens only when an event arrives" },
      { kind: "new", slug: "ghost-mechanism", summary: "Not in the library" },
    ])
    expect(result.problems).toEqual([])
  })

  it("keeps a new mechanism as new", () => {
    const result = parse("## Decisions\nDOMAIN: ai/architecture\nMECHANISM: new:backpressure | A slow consumer slows the producer\n")

    expect(result.mechanisms[0].kind).toBe("new")
  })

  it("missing decisions falls back", () => {
    const result = parse("## Analysis\nNo decisions here.\n\nDOMAIN: ai/architecture\n", {
      fallback: "hardware/async-circuits",
    })

    expect(result.domain).toBe("hardware/async-circuits")
    expect(result.proposedDomain).toBeNull()
    expect(result.mechanisms).toEqual([])
    expect(result.problems).toHaveLength(1)
    expect(result.problems[0]).toMatch(/no Decisions section/i)
  })

  it("falls back to null when there is no hint either", () => {
    const result = parse("")

    expect(result.domain).toBeNull()
    expect(result.problems).toHaveLength(1)
  })

  it("ignores lines outside the section", () => {
    const analysis = [
      "DOMAIN: ai/architecture",
      "MECHANISM: new:before-section | Before",
      "",
      "## Decisions",
      "DOMAIN: hardware/async-circuits",
      "MECHANISM: new:backpressure | A slow consumer slows the producer",
      "",
      "## Notes",
      "DOMAIN: ai/architecture",
      "MECHANISM: new:after-section | After",
    ].join("\n")

    const result = parse(analysis)

    expect(result.domain).toBe("hardware/async-circuits")
    expect(result.mechanisms.map((m) => m.slug)).toEqual(["backpressure"])
    expect(result.problems).toEqual([])
  })

  describe("the section", () => {
    it("reads a level-3 Decisions subsection", () => {
      const analysis = [
        "# Consolidated Long-Document Analysis",
        "",
        "## Final Global Digest",
        "### Decisions",
        "DOMAIN: hardware/async-circuits",
        "MECHANISM: new:backpressure | A slow consumer slows the producer",
        "",
        "### Summary",
        "Text.",
      ].join("\n")

      const result = parse(analysis)

      expect(result.domain).toBe("hardware/async-circuits")
      expect(result.mechanisms.map((m) => m.slug)).toEqual(["backpressure"])
      expect(result.problems).toEqual([])
    })

    it("level-3 section ends at the next level-3 heading", () => {
      const analysis = [
        "### Decisions",
        "DOMAIN: hardware/async-circuits",
        "MECHANISM: new:backpressure | A slow consumer slows the producer",
        "### Entities",
        "MECHANISM: new:from-entities | Not a decision",
      ].join("\n")

      expect(parse(analysis).mechanisms.map((m) => m.slug)).toEqual(["backpressure"])
    })

    it("level-3 section ends at a level-2 or level-1 heading", () => {
      for (const heading of ["## Per-Chunk Analyses", "# Title"]) {
        const analysis = [
          "### Decisions",
          "DOMAIN: hardware/async-circuits",
          heading,
          "MECHANISM: new:after-heading | Not a decision",
        ].join("\n")
        expect(parse(analysis).mechanisms, heading).toEqual([])
      }
    })

    it("level-3 section runs through level-4 headings", () => {
      const analysis = [
        "### Decisions",
        "DOMAIN: hardware/async-circuits",
        "#### Mechanisms",
        "MECHANISM: new:backpressure | A slow consumer slows the producer",
      ].join("\n")

      expect(parse(analysis).mechanisms.map((m) => m.slug)).toEqual(["backpressure"])
    })

    it("level-2 section runs through level-3 headings and ends at the next level-2 heading", () => {
      const analysis = [
        "## Decisions",
        "DOMAIN: hardware/async-circuits",
        "### Mechanisms",
        "MECHANISM: new:backpressure | A slow consumer slows the producer",
        "## Appendix",
        "MECHANISM: new:appendix | Not a decision",
      ].join("\n")

      expect(parse(analysis).mechanisms.map((m) => m.slug)).toEqual(["backpressure"])
    })

    it("ends a level-2 section at a level-1 heading", () => {
      const analysis = ["## Decisions", "DOMAIN: ai/architecture", "# Next", "MECHANISM: new:late | Late"].join("\n")

      expect(parse(analysis).mechanisms).toEqual([])
    })

    it("reads the last of a level-2 and a level-3 Decisions heading", () => {
      const levelTwoLast = [
        "### Decisions",
        "DOMAIN: ai/architecture",
        "## Decisions",
        "DOMAIN: hardware/async-circuits",
      ].join("\n")
      const levelThreeLast = [
        "## Decisions",
        "DOMAIN: ai/architecture",
        "## Other",
        "### Decisions",
        "DOMAIN: hardware/async-circuits",
      ].join("\n")

      expect(parse(levelTwoLast).domain).toBe("hardware/async-circuits")
      expect(parse(levelThreeLast).domain).toBe("hardware/async-circuits")
    })

    it("tolerates a trailing colon and spaces in the heading", () => {
      for (const heading of ["## Decisions:", "## Decisions  ", "### Decisions :", "##   Decisions", "## Decisions ##"]) {
        const result = parse(`${heading}\nDOMAIN: ai/architecture\n`)
        expect(result.domain, heading).toBe("ai/architecture")
      }
    })

    it("does not read other headings as Decisions", () => {
      for (const heading of ["# Decisions", "#### Decisions", "## Decisions made", "## Key Decisions", "## Decision"]) {
        const result = parse(`${heading}\nDOMAIN: ai/architecture\n`, { fallback: "hardware/async-circuits" })
        expect(result.domain, heading).toBe("hardware/async-circuits")
        expect(result.problems[0], heading).toMatch(/no Decisions section/i)
      }
    })

    it("ignores headings inside fenced code blocks", () => {
      const analysis = [
        "## Decisions",
        "DOMAIN: hardware/async-circuits",
        "",
        "## Example of the format",
        "```",
        "## Decisions",
        "DOMAIN: ai/architecture",
        "```",
      ].join("\n")

      // The fenced "## Decisions" is not the last Decisions heading.
      expect(parse(analysis).domain).toBe("hardware/async-circuits")
    })

    it("does not end the section at a heading inside a fence", () => {
      const analysis = [
        "## Decisions",
        "DOMAIN: hardware/async-circuits",
        "~~~~",
        "## not a heading",
        "~~~~",
        "MECHANISM: new:backpressure | A slow consumer slows the producer",
      ].join("\n")

      expect(parse(analysis).mechanisms.map((m) => m.slug)).toEqual(["backpressure"])
    })

    it("closes a fence only with a fence of the same character and enough length", () => {
      const analysis = [
        "```",
        "~~~",
        "## Decisions",
        "DOMAIN: ai/architecture",
        "```",
        "## Decisions",
        "DOMAIN: hardware/async-circuits",
      ].join("\n")

      expect(parse(analysis).domain).toBe("hardware/async-circuits")
    })

    it("reads decision lines that the model fenced", () => {
      const analysis = ["## Decisions", "```", "DOMAIN: ai/architecture", "```"].join("\n")

      const result = parse(analysis)

      expect(result.domain).toBe("ai/architecture")
      expect(result.problems).toEqual([])
    })

    it("reads Windows line endings", () => {
      const result = parse("## Decisions\r\nDOMAIN: ai/architecture\r\nMECHANISM: new:backpressure | A slow consumer\r\n")

      expect(result.domain).toBe("ai/architecture")
      expect(result.mechanisms).toEqual([{ kind: "new", slug: "backpressure", summary: "A slow consumer" }])
    })

    it("tolerates bullets and extra spaces on decision lines", () => {
      const analysis = [
        "## Decisions",
        "- DOMAIN:   ai/architecture  ",
        "* MECHANISM:  new:backpressure  |  A slow consumer slows the producer  ",
      ].join("\n")

      const result = parse(analysis)

      expect(result.domain).toBe("ai/architecture")
      expect(result.mechanisms).toEqual([
        { kind: "new", slug: "backpressure", summary: "A slow consumer slows the producer" },
      ])
      expect(result.problems).toEqual([])
    })

    it("ignores prose in the section without raising a problem", () => {
      const analysis = [
        "## Decisions",
        "The source belongs to async circuits.",
        "DOMAIN: hardware/async-circuits",
        "",
        "---",
      ].join("\n")

      const result = parse(analysis)

      expect(result.domain).toBe("hardware/async-circuits")
      expect(result.problems).toEqual([])
    })
  })

  describe("mechanism lines", () => {
    function mechanismResult(...lines: string[]) {
      return parse(["## Decisions", "DOMAIN: ai/architecture", ...lines].join("\n"))
    }

    it("drops a bad line, reports it, and keeps the good ones", () => {
      const result = mechanismResult(
        "MECHANISM: new:Backpressure Model | Not kebab-case",
        "MECHANISM: new:backpressure | A slow consumer slows the producer",
        "MECHANISM: maybe:something | Unknown kind",
      )

      expect(result.mechanisms.map((m) => m.slug)).toEqual(["backpressure"])
      expect(result.problems).toHaveLength(2)
      expect(result.problems[0]).toContain("Backpressure Model")
      expect(result.problems[1]).toContain("maybe:something")
    })

    it("accepts digits in a kebab-case slug and rejects stray hyphens and capitals", () => {
      const result = mechanismResult(
        "MECHANISM: new:two-phase-commit-2 | Ok",
        "MECHANISM: new:-leading | Bad",
        "MECHANISM: new:trailing- | Bad",
        "MECHANISM: new:double--hyphen | Bad",
        "MECHANISM: new:CamelCase | Bad",
        "MECHANISM: new:snake_case | Bad",
        "MECHANISM: new:with/slash | Bad",
        "MECHANISM: new:../escape | Bad",
      )

      expect(result.mechanisms.map((m) => m.slug)).toEqual(["two-phase-commit-2"])
      expect(result.problems).toHaveLength(7)
    })

    it("rejects a slug longer than 80 characters", () => {
      const ok = `${"a".repeat(39)}-${"b".repeat(40)}`
      const long = `${ok}c`
      const cjk = "事".repeat(81)
      expect(ok).toHaveLength(80)
      const result = mechanismResult(
        `MECHANISM: new:${ok} | Fits`,
        `MECHANISM: new:${long} | Too long`,
        `MECHANISM: new:${cjk} | Too long`,
      )

      expect(result.mechanisms.map((m) => m.slug)).toEqual([ok])
      expect(result.problems).toHaveLength(2)
      expect(result.problems[0]).toContain("80 characters")
    })

    it("rejects the file names that Windows reserves", () => {
      const reserved = ["con", "prn", "aux", "nul", ...[1, 2, 3, 4, 5, 6, 7, 8, 9].flatMap((n) => [`com${n}`, `lpt${n}`])]
      const result = mechanismResult(...reserved.map((slug) => `MECHANISM: new:${slug} | Reserved`))

      expect(result.mechanisms).toEqual([])
      expect(result.problems).toHaveLength(reserved.length)
      expect(result.problems[0]).toContain("reserved")
    })

    it("accepts a slug that only starts with, or ends in, a reserved name", () => {
      const result = mechanismResult(
        "MECHANISM: new:console | Ok",
        "MECHANISM: new:con-trol | Ok",
        "MECHANISM: new:com10 | Ok",
        "MECHANISM: new:com0 | Ok",
        "MECHANISM: new:lpt0 | Ok",
        "MECHANISM: new:null | Ok",
      )

      expect(result.mechanisms.map((m) => m.slug)).toEqual(["console", "con-trol", "com10", "com0", "lpt0", "null"])
      expect(result.problems).toEqual([])
    })

    it("accepts a CJK slug", () => {
      const result = mechanismResult(
        "MECHANISM: new:事件驅動計算 | 只有事件到達時才工作",
        "MECHANISM: new:イベント駆動 | イベントが来た時だけ動く",
        "MECHANISM: new:이벤트-구동 | 이벤트가 올 때만 작동",
        "MECHANISM: new:ai-驅動-model | Mixed",
      )

      expect(result.mechanisms.map((m) => m.slug)).toEqual([
        "事件驅動計算",
        "イベント駆動",
        "이벤트-구동",
        "ai-驅動-model",
      ])
      expect(result.problems).toEqual([])
    })

    it("matches an existing CJK slug", () => {
      const result = parse("## Decisions\nDOMAIN: ai/architecture\nMECHANISM: existing:事件驅動計算 | x\n", {
        existing: new Set(["事件驅動計算"]),
      })

      expect(result.mechanisms[0].kind).toBe("existing")
    })

    it("drops a line with no summary", () => {
      const result = mechanismResult("MECHANISM: new:backpressure", "MECHANISM: new:buffering |   ")

      expect(result.mechanisms).toEqual([])
      expect(result.problems).toHaveLength(2)
    })

    it("keeps a pipe inside the summary", () => {
      const result = mechanismResult("MECHANISM: new:backpressure | A slow consumer | slows the producer")

      expect(result.mechanisms[0].summary).toBe("A slow consumer | slows the producer")
    })

    it("keeps only the first line of a repeated slug", () => {
      const result = mechanismResult(
        "MECHANISM: new:backpressure | First",
        "MECHANISM: new:backpressure | Second",
        "MECHANISM: existing:backpressure | Third",
      )

      expect(result.mechanisms).toEqual([{ kind: "new", slug: "backpressure", summary: "First" }])
      expect(result.problems).toEqual([])
    })

    it("reports a line that has a decision keyword but is not in the exact form", () => {
      const result = parse("## Decisions\nDomain: ai/architecture\nmechanism: new:x | y\n", { fallback: "ai/architecture" })

      expect(result.mechanisms).toEqual([])
      // Both lines, and the missing domain line.
      expect(result.problems.length).toBeGreaterThanOrEqual(2)
      expect(result.problems.join("\n")).toContain("Domain: ai/architecture")
    })
  })
})
