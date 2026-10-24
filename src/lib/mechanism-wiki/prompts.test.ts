import { beforeEach, describe, expect, it, vi } from "vitest"
import { MECHANISM_TEMPLATE_FILES } from "@/lib/mechanism-template"
import type { DomainsConfig } from "@/lib/wiki-config/domains"
import { MECHANISM_SECTIONS } from "@/lib/wiki-config/section-headings"
import type { WikiIdentity } from "@/lib/wiki-config/wiki-identity"
import { extractLensPromptText } from "./context"
import type { LensDoc, MechanismContext } from "./context"
import { buildScopedIndexText } from "./domain-index"
import {
  appendPromptSection,
  buildAnalysisAddendum,
  buildGenerationAddendum,
  domainHintFromSource,
  prepareMechanismPrompts,
} from "./prompts"
import { emptyDecisions } from "./types"
import type { AnalysisDecisions } from "./types"

// The scoped index reads the wiki; the prompts only use its text.
vi.mock("./domain-index", () => ({ buildScopedIndexText: vi.fn() }))

const mockScopedIndex = vi.mocked(buildScopedIndexText)

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
    "business/franchising": {
      lens: "business",
      description: "Growing a business by licensing its brand and operating system",
      whiteboards: [],
    },
  },
}

function lensDoc(id: string, text: string): LensDoc {
  return { id, text, promptText: extractLensPromptText(text) }
}

function templateFile(path: string): string {
  const text = MECHANISM_TEMPLATE_FILES[path]
  if (text === undefined) throw new Error(`template file missing: ${path}`)
  return text
}

const READING: WikiIdentity = { version: 1, id: "reading", role: "reading", mechanism_library: null }
const WORK: WikiIdentity = { version: 1, id: "work", role: "work", mechanism_library: "../reading" }

function makeCtx(overrides: Partial<MechanismContext> = {}): MechanismContext {
  return {
    projectPath: "/projects/wiki",
    identity: READING,
    identityStatus: "ok",
    domains: DOMAINS,
    lenses: {
      hardware: lensDoc("hardware", templateFile("lenses/hardware.md")),
      ai: lensDoc("ai", templateFile("lenses/ai.md")),
      business: lensDoc("business", templateFile("lenses/business.md")),
    },
    pageTypeRules: { mechanism: templateFile("schema/page-types/mechanism.md") },
    mechanismLibraryPath: "/projects/wiki",
    configIssues: [],
    ...overrides,
  }
}

function decisions(overrides: Partial<AnalysisDecisions> = {}): AnalysisDecisions {
  return { ...emptyDecisions("hardware/async-circuits"), ...overrides }
}

describe("buildAnalysisAddendum", () => {
  it("analysis addendum lists domains and decision lines", () => {
    const text = buildAnalysisAddendum(makeCtx(), null)

    for (const [name, entry] of Object.entries(DOMAINS.domains)) {
      expect(text).toContain(name)
      expect(text).toContain(entry.description)
    }
    expect(text).toContain("exactly one domain")
    expect(text).toContain("## Decisions")
    expect(text).toContain("DOMAIN: <path>")
    expect(text).toContain("NEW-DOMAIN: <path> | <lens> | <description>")
    expect(text).toContain("MECHANISM: existing:<slug> | <one-line>")
    expect(text).toContain("MECHANISM: new:<slug> | <one-line>")
    expect(text).toContain("no industry, vendor, or product detail")
  })

  it("names the six mechanism sections", () => {
    const text = buildAnalysisAddendum(makeCtx(), null)
    for (const section of MECHANISM_SECTIONS) {
      expect(text).toContain(section.en)
    }
  })

  it("names the lens ids a new domain may use", () => {
    const text = buildAnalysisAddendum(makeCtx(), null)
    expect(text).toContain("Lens ids for a new domain: ai, business, hardware")
  })

  it("says so when no domain is listed yet", () => {
    const text = buildAnalysisAddendum(makeCtx({ domains: { version: 1, domains: {} } }), null)
    expect(text).toContain("NEW-DOMAIN: <path> | <lens> | <description>")
    expect(text).toMatch(/no domain is listed/i)
  })

  it("uses one lens when a hint exists", () => {
    const ctx = makeCtx()
    const text = buildAnalysisAddendum(ctx, "hardware/async-circuits")

    expect(text).toContain(ctx.lenses.hardware.promptText)
    // A line that only the hardware lens has, and one that only the ai lens has.
    expect(text).toContain("Measured silicon data")
    expect(text).not.toContain(ctx.lenses.ai.promptText)
    expect(text).not.toContain(ctx.lenses.business.promptText)
  })

  it("uses all lens field sections without a hint", () => {
    const ctx = makeCtx()
    const text = buildAnalysisAddendum(ctx, null)

    for (const id of ["hardware", "ai", "business"]) {
      const fields = ctx.lenses[id].promptText.split(/\n## Evidence standard/)[0]
      expect(text).toContain(fields)
    }
    // Evidence standard and Strength rules are not part of the all-lens text.
    expect(text).not.toContain("Measured silicon data")
    expect(text).not.toContain("## Strength rules")
    // The Example section of a lens file is not part of it either.
    expect(text).not.toContain("分段並行處理")
  })

  it("reads Fields sections fence-aware", () => {
    const tricky = [
      "# Lens: odd",
      "",
      "## Purpose",
      "",
      "Text.",
      "",
      "## Fields",
      "",
      "### Parts",
      "",
      "REAL-FIELDS-LINE",
      "",
      "## Example",
      "",
      "```markdown",
      "## Fields",
      "",
      "DECOY-FIELDS-LINE",
      "```",
    ].join("\n")
    const ctx = makeCtx({
      domains: { version: 1, domains: { odd: { lens: "odd", description: "Odd things", whiteboards: [] } } },
      lenses: { odd: lensDoc("odd", tricky) },
    })

    const text = buildAnalysisAddendum(ctx, null)

    expect(text).toContain("REAL-FIELDS-LINE")
    expect(text).not.toContain("DECOY-FIELDS-LINE")
  })

  it("uses all lens field sections when the hint has no lens", () => {
    const ctx = makeCtx()
    const text = buildAnalysisAddendum(ctx, "physics/unknown")

    expect(text).toContain("### Parts")
    expect(text).not.toContain("Measured silicon data")
    for (const id of ["hardware", "ai", "business"]) {
      expect(text).toContain(id)
    }
  })

  it("chunk variant keeps the two-section output and puts the decisions in the digest", () => {
    const text = buildAnalysisAddendum(makeCtx(), null, { chunked: true })

    expect(text).toContain("DOMAIN: <path>")
    expect(text).toContain("MECHANISM: existing:<slug> | <one-line>")
    expect(text).toContain("### Decisions")
    expect(text).toContain("Updated Global Digest")
    expect(text).not.toContain("End the analysis with")
  })

  it("chunk variant asks for the decisions first in the digest, where a cut of the tail keeps them", () => {
    const text = buildAnalysisAddendum(makeCtx(), null, { chunked: true })

    expect(text).toContain("FIRST subsection of the Updated Global Digest")
    expect(text).toContain("directly after the `## Updated Global Digest` heading")
    expect(text).toContain("then the rest of the digest")
    expect(text).not.toMatch(/end the Updated Global Digest/i)
    expect(text).not.toMatch(/last (subsection|part) of the (Updated )?(Global )?Digest/i)
  })
})

describe("buildGenerationAddendum", () => {
  it("requires the chosen domain on every non-mechanism page", () => {
    const text = buildGenerationAddendum(makeCtx(), decisions())

    expect(text).toContain("domain: hardware/async-circuits")
    expect(text).toMatch(/every page except mechanism pages/i)
  })

  it("uses a proposed domain when no listed domain was chosen", () => {
    const text = buildGenerationAddendum(
      makeCtx(),
      decisions({
        domain: null,
        proposedDomain: { path: "cognition/attention", lens: "ai", description: "How attention works" },
      }),
    )

    expect(text).toContain("domain: cognition/attention")
  })

  it("points to the Decisions section when no domain is known", () => {
    const text = buildGenerationAddendum(makeCtx(), decisions({ domain: null }))

    expect(text).toContain("DOMAIN line")
    expect(text).not.toContain("domain: null")
  })

  it("includes the mechanism page rules of the wiki", () => {
    const ctx = makeCtx({ pageTypeRules: { mechanism: "RULES-MARKER Write at least one failure condition." } })
    const text = buildGenerationAddendum(ctx, decisions())

    expect(text).toContain("RULES-MARKER Write at least one failure condition.")
  })

  it("states that mechanism and hypothesis are also known types", () => {
    const text = buildGenerationAddendum(makeCtx(), decisions())

    expect(text).toMatch(/`mechanism` and `hypothesis` are also known types/)
    expect(text).toMatch(/do not write.*wiki\/hypotheses\//i)
  })

  it("lists the section headings in the output language", () => {
    const english = buildGenerationAddendum(makeCtx(), decisions())
    const traditional = buildGenerationAddendum(makeCtx(), decisions(), "Traditional Chinese")
    const simplified = buildGenerationAddendum(makeCtx(), decisions(), "Chinese")
    const japanese = buildGenerationAddendum(makeCtx(), decisions(), "Japanese")

    expect(english).toContain("## Parts\n## Flows\n## Constraints and trade-offs\n## Why it works\n## Failure conditions\n## Known instances")
    expect(traditional).toContain("## 組成\n## 流動\n## 約束與取捨\n## 為什麼有效\n## 失效條件\n## 已知實例")
    expect(simplified).toContain("## 组成\n## 流动\n## 约束与取舍\n## 为什么有效\n## 失效条件\n## 已知实例")
    expect(japanese).toContain("## Parts\n## Flows")
  })

  it("tells the model to use the six headings exactly and not to translate them", () => {
    const sentence = "Use exactly these six level-2 headings, in this order. Do not translate or rephrase them."
    const work = makeCtx({ identity: WORK })

    expect(buildGenerationAddendum(makeCtx(), decisions())).toContain(sentence)
    expect(buildGenerationAddendum(makeCtx(), decisions(), "Traditional Chinese")).toContain(sentence)
    expect(buildGenerationAddendum(work, decisions())).toContain(sentence)
    expect(buildGenerationAddendum(makeCtx(), decisions())).not.toContain("in the output language:")
  })

  it("generation addendum for work wiki forbids mechanism files", () => {
    const ctx = makeCtx({ identity: WORK, mechanismLibraryPath: "/projects/reading" })
    const text = buildGenerationAddendum(
      ctx,
      decisions({ mechanisms: [{ kind: "new", slug: "event-driven", summary: "Work happens only on events" }] }),
    )

    expect(text).toContain("do not write wiki/mechanisms/ files")
    expect(text).toContain("REVIEW block of type new-mechanism")
  })

  it("still gives a work wiki the mechanism rules, to draft the review item", () => {
    const ctx = makeCtx({
      identity: WORK,
      pageTypeRules: { mechanism: "RULES-MARKER Write at least one failure condition." },
    })
    const text = buildGenerationAddendum(ctx, decisions())

    expect(text).toContain("RULES-MARKER Write at least one failure condition.")
  })

  it("generation addendum for a reading wiki with an invalid wiki.yaml forbids mechanism files", () => {
    const ctx = makeCtx({ identity: READING, identityStatus: "invalid" })
    const text = buildGenerationAddendum(ctx, decisions())

    expect(text).toContain("do not write wiki/mechanisms/ files")
    expect(text).toContain("REVIEW block of type new-mechanism")
  })

  it("lets a reading wiki write mechanism pages", () => {
    const text = buildGenerationAddendum(makeCtx(), decisions())

    expect(text).not.toContain("do not write wiki/mechanisms/ files")
    expect(text).not.toContain("REVIEW block of type new-mechanism")
    expect(text).toContain("wiki/mechanisms/")
  })

  it("lets a reading wiki without wiki.yaml write mechanism pages", () => {
    const text = buildGenerationAddendum(makeCtx({ identityStatus: "missing" }), decisions())

    expect(text).not.toContain("do not write wiki/mechanisms/ files")
  })

  it("generation addendum lists existing mechanisms to update", () => {
    const text = buildGenerationAddendum(
      makeCtx(),
      decisions({
        mechanisms: [
          { kind: "existing", slug: "event-driven-computing", summary: "Work happens only when an event arrives" },
          { kind: "new", slug: "backpressure", summary: "A slow consumer slows the producer" },
        ],
      }),
    )

    expect(text).toContain("update wiki/mechanisms/event-driven-computing.md")
    expect(text).toContain("Known instances")
    expect(text).toContain("Work happens only when an event arrives")
    expect(text).toContain("wiki/mechanisms/backpressure.md")
    expect(text).toContain("A slow consumer slows the producer")
  })

  it("names the known-instances heading in the output language", () => {
    const text = buildGenerationAddendum(
      makeCtx(),
      decisions({ mechanisms: [{ kind: "existing", slug: "event-driven-computing", summary: "x" }] }),
      "Traditional Chinese",
    )

    expect(text).toContain("update wiki/mechanisms/event-driven-computing.md")
    expect(text).toContain("## 已知實例")
  })

  it("does not update existing mechanism pages in a work wiki", () => {
    const ctx = makeCtx({ identity: WORK })
    const text = buildGenerationAddendum(
      ctx,
      decisions({ mechanisms: [{ kind: "existing", slug: "event-driven-computing", summary: "x" }] }),
    )

    expect(text).not.toContain("update wiki/mechanisms/event-driven-computing.md")
  })

  it("states a neutral rule when the decisions list no mechanism", () => {
    const text = buildGenerationAddendum(makeCtx(), decisions({ mechanisms: [] }))

    expect(text).not.toContain("update wiki/mechanisms/")
    expect(text).toContain(
      "Write a mechanism page only for a MECHANISM line in the analysis decisions. This analysis has none, so do not write a mechanism page.",
    )
    // It must not read as a finding about the source.
    expect(text).not.toContain("The analysis found no mechanism")
    expect(text).not.toContain("had problems")
  })

  it("lists the valid mechanisms and says that lines were dropped when there are problems", () => {
    const dropped =
      "Some analysis decision lines were invalid and were dropped. Write or update mechanism pages only for the lines listed here."
    const withProblems = buildGenerationAddendum(
      makeCtx(),
      decisions({
        problems: ["A MECHANISM line was not understood."],
        mechanisms: [
          { kind: "existing", slug: "event-driven-computing", summary: "Work happens only when an event arrives" },
          { kind: "new", slug: "backpressure", summary: "A slow consumer slows the producer" },
        ],
      }),
    )

    expect(withProblems).toContain(dropped)
    expect(withProblems).toContain("update wiki/mechanisms/event-driven-computing.md")
    expect(withProblems).toContain("wiki/mechanisms/backpressure.md")
    // The old rule that blocked every mechanism page is gone.
    expect(withProblems).not.toContain("do not write or update a mechanism page in this run")
    expect(withProblems).not.toContain("had problems")

    const clean = buildGenerationAddendum(
      makeCtx(),
      decisions({ mechanisms: [{ kind: "new", slug: "backpressure", summary: "x" }] }),
    )
    expect(clean).not.toContain("were invalid and were dropped")
  })

  it("keeps the empty-list rule and adds the dropped-lines sentence when every line was dropped", () => {
    const text = buildGenerationAddendum(makeCtx(), decisions({ problems: ["The analysis has no Decisions section."] }))

    expect(text).toContain(
      "Write a mechanism page only for a MECHANISM line in the analysis decisions. This analysis has none, so do not write a mechanism page.",
    )
    expect(text).toContain(
      "Some analysis decision lines were invalid and were dropped. Write or update mechanism pages only for the lines listed here.",
    )
    expect(text).not.toContain("do not write or update a mechanism page in this run")
  })

  it("keeps the valid mechanisms of a work wiki as review rules when there are problems", () => {
    const text = buildGenerationAddendum(
      makeCtx({ identity: WORK }),
      decisions({
        problems: ["A MECHANISM line was not understood."],
        mechanisms: [{ kind: "new", slug: "backpressure", summary: "A slow consumer slows the producer" }],
      }),
    )

    expect(text).toContain("MECHANISM new:backpressure")
    expect(text).toContain("REVIEW block of type new-mechanism")
    expect(text).toContain("were invalid and were dropped")
  })

  it("keeps the output format reminder at the end", () => {
    const text = buildGenerationAddendum(makeCtx(), decisions())

    const lines = text.trimEnd().split("\n")
    expect(lines[lines.length - 1]).toMatch(/---FILE:/)
  })

  it("ends by repeating the output language rule, since it follows the upstream language rule", () => {
    const text = buildGenerationAddendum(makeCtx(), decisions())

    expect(text.trimEnd().endsWith("Write all prose in the mandatory output language above.")).toBe(true)
  })
})

describe("domainHintFromSource", () => {
  const ctx = makeCtx()

  it("returns a listed frontmatter domain", () => {
    const source = "---\ntitle: Notes\ndomain: hardware/async-circuits\n---\n\nBody"
    expect(domainHintFromSource(source, ctx)).toBe("hardware/async-circuits")
  })

  it("domainHintFromSource ignores unknown domains", () => {
    expect(domainHintFromSource("---\ndomain: cooking/pasta\n---\n\nBody", ctx)).toBeNull()
    // A child of a listed domain is not itself listed.
    expect(domainHintFromSource("---\ndomain: hardware/async-circuits/handshakes\n---\n", ctx)).toBeNull()
  })

  it("returns null without frontmatter or a domain field", () => {
    expect(domainHintFromSource("Just text", ctx)).toBeNull()
    expect(domainHintFromSource("---\ntitle: x\n---\n\nBody", ctx)).toBeNull()
    expect(domainHintFromSource("", ctx)).toBeNull()
  })

  it("ignores a domain that is not a string", () => {
    expect(domainHintFromSource("---\ndomain: [ai/architecture]\n---\n", ctx)).toBeNull()
  })

  it("does not read inherited object keys as domains", () => {
    expect(domainHintFromSource("---\ndomain: constructor\n---\n", ctx)).toBeNull()
  })
})

describe("prepareMechanismPrompts", () => {
  beforeEach(() => {
    mockScopedIndex.mockReset()
    mockScopedIndex.mockResolvedValue("# Scoped index\n")
  })

  it("bundles the index, both addenda, and the hint", async () => {
    const ctx = makeCtx()
    const source = "---\ndomain: ai/architecture\n---\n\nText"
    const prompts = await prepareMechanismPrompts(ctx, source, "English")

    expect(prompts.hint).toBe("ai/architecture")
    expect(prompts.analysis).toBe(buildAnalysisAddendum(ctx, "ai/architecture"))
    expect(prompts.chunkAnalysis).toBe(buildAnalysisAddendum(ctx, "ai/architecture", { chunked: true }))
    const d = emptyDecisions("ai/architecture")
    expect(prompts.generation(d)).toBe(buildGenerationAddendum(ctx, d, "English"))
    expect(prompts.reservedChars).toBeGreaterThan(prompts.analysis.length)
  })

  it("uses the scoped index of the hinted domain as the index", async () => {
    const ctx = makeCtx()
    const prompts = await prepareMechanismPrompts(ctx, "---\ndomain: ai/architecture\n---\n\nText", "English")

    expect(prompts.index).toBe("# Scoped index\n")
    expect(mockScopedIndex).toHaveBeenCalledTimes(1)
    expect(mockScopedIndex).toHaveBeenCalledWith("/projects/wiki", ctx, "ai/architecture")
  })

  it("asks for the index without a domain when the source names none", async () => {
    const ctx = makeCtx()
    await prepareMechanismPrompts(ctx, "Text", "English")

    expect(mockScopedIndex).toHaveBeenCalledWith("/projects/wiki", ctx, null)
  })

  it("passes the output language to the generation addendum", async () => {
    const ctx = makeCtx()
    const prompts = await prepareMechanismPrompts(ctx, "Text", "Traditional Chinese")

    expect(prompts.hint).toBeNull()
    expect(prompts.generation(emptyDecisions(null))).toContain("## 組成")
  })
})

describe("appendPromptSection", () => {
  it("returns the prompt itself for an empty or missing section", () => {
    expect(appendPromptSection("base", "")).toBe("base")
    expect(appendPromptSection("base", undefined)).toBe("base")
  })

  it("adds a blank line and the section", () => {
    expect(appendPromptSection("base", "extra")).toBe("base\n\nextra")
  })
})
