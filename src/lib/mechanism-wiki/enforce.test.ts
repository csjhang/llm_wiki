import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { DomainsConfig } from "@/lib/wiki-config/domains"
import type { WikiIdentity } from "@/lib/wiki-config/wiki-identity"
import { parseFileBlocks } from "@/lib/ingest"
import type { LensDoc, MechanismContext } from "./context"
import { enforceMechanismRules, proposedDomainReview } from "./enforce"
import { emptyDecisions } from "./types"
import type { AnalysisDecisions } from "./types"

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
const WORK: WikiIdentity = { version: 1, id: "work", role: "work", mechanism_library: "../reading" }

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

function decide(overrides: Partial<AnalysisDecisions> = {}): AnalysisDecisions {
  return { ...emptyDecisions("ai/architecture"), ...overrides }
}

const SOURCE_PATH = "raw/sources/note.md"

/** One FILE block in the format the model writes. */
function block(path: string, content: string): string {
  return `---FILE: ${path}---\n${content}\n---END FILE---`
}

/** A page with frontmatter. `extra` lines go at the end of the frontmatter. */
function page(type: string, extra: string[] = [], title = "Attention"): string {
  return [
    "---",
    `type: ${type}`,
    `title: ${title}`,
    "tags: []",
    ...extra,
    "---",
    `# ${title}`,
    "",
    "Body text.",
  ].join("\n")
}

function enforce(
  generation: string,
  options: { ctx?: MechanismContext; decisions?: AnalysisDecisions } = {},
) {
  return enforceMechanismRules(
    generation,
    options.ctx ?? makeCtx(),
    options.decisions ?? decide(),
    SOURCE_PATH,
  )
}

/** The blocks of the returned text, by path. */
function contentsByPath(text: string): Record<string, string> {
  return Object.fromEntries(parseFileBlocks(text).blocks.map((b) => [b.path, b.content]))
}

describe("enforceMechanismRules", () => {
  beforeEach(() => {
    // parseFileBlocks warns about the blocks it drops; keep test output clean.
    vi.spyOn(console, "warn").mockImplementation(() => {})
  })

  afterEach(() => {
    vi.mocked(console.warn).mockRestore()
  })

  it("adds missing domain to concept pages", () => {
    const concept = page("concept")
    const source = page("source", ['sources: ["note.md"]'], "Note")
    const result = enforce([block("wiki/concepts/attention.md", concept), block("wiki/sources/note.md", source)].join("\n\n"))

    const pages = contentsByPath(result.text)
    expect(pages["wiki/concepts/attention.md"]).toBe(concept.replace("\n---\n# Attention", "\ndomain: ai/architecture\n---\n# Attention"))
    expect(pages["wiki/sources/note.md"]).toContain("\ndomain: ai/architecture\n---\n")
    expect(result.reviews).toEqual([])
    expect(result.notes).toContain('Added domain "ai/architecture" to wiki/concepts/attention.md')
  })

  it("keeps an existing listed domain", () => {
    const concept = page("concept", ["domain: hardware/async-circuits"])
    const generation = block("wiki/concepts/handshake.md", concept)
    const result = enforce(generation)

    expect(result.text).toBe(generation)
    expect(result.notes).toEqual([])
  })

  it("replaces a domain that is not listed with the decided one", () => {
    const concept = page("concept", ["domain: made/up", "updated: 2026-01-01"])
    const result = enforce(block("wiki/concepts/attention.md", concept))

    const written = contentsByPath(result.text)["wiki/concepts/attention.md"]
    expect(written).toContain("domain: ai/architecture\nupdated: 2026-01-01\n---")
    expect(written).not.toContain("made/up")
    expect(result.notes).toContain('Replaced domain "made/up" with "ai/architecture" on wiki/concepts/attention.md')
  })

  it("fills an empty domain field", () => {
    const result = enforce(block("wiki/concepts/attention.md", page("concept", ['domain: ""'])))

    expect(contentsByPath(result.text)["wiki/concepts/attention.md"]).toContain("\ndomain: ai/architecture\n---\n")
  })

  it("uses the proposed domain when no listed domain was decided", () => {
    const decisions = decide({
      domain: null,
      proposedDomain: { path: "cognition/attention", lens: "ai", description: "How attention works" },
    })
    const result = enforce(block("wiki/concepts/attention.md", page("concept")), { decisions })

    expect(contentsByPath(result.text)["wiki/concepts/attention.md"]).toContain("\ndomain: cognition/attention\n---\n")
  })

  it("leaves pages alone when no domain was decided", () => {
    const generation = block("wiki/concepts/attention.md", page("concept"))
    const result = enforce(generation, { decisions: decide({ domain: null }) })

    expect(result.text).toBe(generation)
    expect(result.notes).toEqual([])
  })

  it("skips a page that has no frontmatter and says so", () => {
    const generation = block("wiki/concepts/attention.md", "# Attention\n\nNo frontmatter here.")
    const result = enforce(generation)

    expect(result.text).toBe(generation)
    expect(result.notes).toEqual(["Could not add domain to wiki/concepts/attention.md: the page has no frontmatter"])
  })

  it("adds the domain to a page whose frontmatter sits in a code fence", () => {
    const fenced = ["```yaml", "---", "type: concept", "title: Attention", "---", "# Attention", "```"].join("\n")
    const result = enforce(block("wiki/concepts/attention.md", fenced))

    const written = contentsByPath(result.text)["wiki/concepts/attention.md"]
    expect(written.startsWith("---\ntype: concept\ntitle: Attention\ndomain: ai/architecture\n---\n")).toBe(true)
    expect(written).not.toContain("```")
  })

  it("adds the domain to a page that starts with blank lines", () => {
    const result = enforce(block("wiki/concepts/attention.md", `\n\n${page("concept")}`))

    const written = contentsByPath(result.text)["wiki/concepts/attention.md"]
    expect(written).toBe(`\n\n${page("concept", ["domain: ai/architecture"])}`)
  })

  it("adds the domain to a page with an empty frontmatter", () => {
    const result = enforce(block("wiki/concepts/attention.md", "---\n---\n# Attention\n\n---\n\nA rule above."))

    expect(contentsByPath(result.text)["wiki/concepts/attention.md"]).toBe(
      "---\ndomain: ai/architecture\n---\n# Attention\n\n---\n\nA rule above.",
    )
  })

  it("strips domain from mechanism pages and adds lenses", () => {
    const mechanism = page("mechanism", ["domain: ai/architecture", "also: [hardware/async-circuits]"], "Event-driven computing")
    const result = enforce(block("wiki/mechanisms/event-driven-computing.md", mechanism))

    const written = contentsByPath(result.text)["wiki/mechanisms/event-driven-computing.md"]
    expect(written).toBe(
      ["---", "type: mechanism", "title: Event-driven computing", "tags: []", "lenses: [ai]", "instances: []", "---", "# Event-driven computing", "", "Body text."].join("\n"),
    )
    expect(result.notes).toContain("Removed domain and also from wiki/mechanisms/event-driven-computing.md")
    expect(result.notes).toContain("Added lenses and instances to wiki/mechanisms/event-driven-computing.md")
  })

  it("removes also when it is written as a block list", () => {
    const mechanism = page("mechanism", ["also:", "  - hardware/async-circuits", "  - ai/architecture", "lenses: [ai]", "instances: [a]"])
    const result = enforce(block("wiki/mechanisms/m.md", mechanism))

    expect(contentsByPath(result.text)["wiki/mechanisms/m.md"]).toBe(page("mechanism", ["lenses: [ai]", "instances: [a]"]))
  })

  it("keeps lenses and instances that a mechanism page already has", () => {
    const mechanism = page("mechanism", ["lenses: [hardware, ai]", "instances: [async-handshake]"])
    const generation = block("wiki/mechanisms/m.md", mechanism)

    expect(enforce(generation).text).toBe(generation)
  })

  it("gives a mechanism page the lens of the proposed domain when no listed domain was decided", () => {
    const decisions = decide({
      domain: null,
      proposedDomain: { path: "cognition/attention", lens: "business", description: "How attention works" },
    })
    const result = enforce(block("wiki/mechanisms/m.md", page("mechanism")), { decisions })

    expect(contentsByPath(result.text)["wiki/mechanisms/m.md"]).toContain("\nlenses: [business]\ninstances: []\n---\n")
  })

  it("gives a mechanism page empty lenses when no domain was decided", () => {
    const result = enforce(block("wiki/mechanisms/m.md", page("mechanism")), { decisions: decide({ domain: null }) })

    expect(contentsByPath(result.text)["wiki/mechanisms/m.md"]).toContain("\nlenses: []\ninstances: []\n---\n")
  })

  it("work wiki converts mechanism pages to proposals", () => {
    const mechanism = page("mechanism", [], "Event-driven computing")
    const concept = page("concept")
    const ctx = makeCtx({ identity: WORK })
    const result = enforce(
      [block("wiki/mechanisms/event-driven-computing.md", mechanism), block("wiki/concepts/attention.md", concept)].join("\n\n"),
      { ctx },
    )

    const paths = parseFileBlocks(result.text).blocks.map((b) => b.path)
    expect(paths).toEqual(["wiki/concepts/attention.md"])
    expect(result.text).not.toContain("wiki/mechanisms/")
    expect(result.reviews).toEqual([
      {
        type: "new-mechanism",
        title: "Event-driven computing",
        description: mechanism,
        sourcePath: SOURCE_PATH,
        affectedPages: ["wiki/mechanisms/event-driven-computing.md"],
        options: [
          { label: "Write to reading wiki", action: "mech:propose-mechanism" },
          { label: "Skip", action: "Skip" },
        ],
      },
    ])
    expect(result.notes).toContain("Moved wiki/mechanisms/event-driven-computing.md to a new-mechanism review item")
  })

  it("titles a proposal by the file name when the page has no title", () => {
    const ctx = makeCtx({ identity: WORK })
    const result = enforce(block("wiki/mechanisms/backpressure.md", "# Backpressure\n\nNo frontmatter."), { ctx })

    expect(result.reviews.map((review) => review.title)).toEqual(["backpressure"])
  })

  it("converts mechanism pages to proposals when wiki.yaml is invalid", () => {
    // An invalid wiki.yaml reads as the default reading identity, but it could be a work wiki.
    const ctx = makeCtx({ identity: READING, identityStatus: "invalid" })
    const result = enforce(block("wiki/mechanisms/backpressure.md", page("mechanism", [], "Backpressure")), { ctx })

    expect(result.text).toBe("")
    expect(result.reviews.map((review) => [review.type, review.title])).toEqual([["new-mechanism", "Backpressure"]])
  })

  it("still writes mechanism pages when wiki.yaml is missing", () => {
    const ctx = makeCtx({ identity: READING, identityStatus: "missing" })
    const result = enforce(block("wiki/mechanisms/backpressure.md", page("mechanism", [], "Backpressure")), { ctx })

    expect(Object.keys(contentsByPath(result.text))).toEqual(["wiki/mechanisms/backpressure.md"])
    expect(result.reviews).toEqual([])
  })

  it("treats the mechanisms folder case-insensitively", () => {
    const ctx = makeCtx({ identity: WORK })
    const result = enforce(block("wiki/Mechanisms/Backpressure.md", page("mechanism", [], "Backpressure")), { ctx })

    expect(result.text).toBe("")
    expect(result.reviews).toHaveLength(1)
  })

  it("drops an unfinished mechanism block in a work wiki so it is not repaired", () => {
    const ctx = makeCtx({ identity: WORK })
    const concept = block("wiki/concepts/attention.md", page("concept", ["domain: ai/architecture"]))
    const unfinished = "---FILE: wiki/mechanisms/backpressure.md---\n---\ntype: mechanism\ntitle: Backpressure\n"
    const result = enforce(`${concept}\n\n${unfinished}`, { ctx })

    expect(result.text).toBe(`${concept}\n`)
    expect(parseFileBlocks(result.text).truncatedPaths).toEqual([])
    expect(result.notes).toContain("Dropped the unfinished block wiki/mechanisms/backpressure.md")
    // The partial page stays visible as a review item.
    expect(result.reviews).toEqual([
      {
        type: "new-mechanism",
        title: "(incomplete) backpressure",
        description: "---\ntype: mechanism\ntitle: Backpressure\n",
        sourcePath: SOURCE_PATH,
        affectedPages: ["wiki/mechanisms/backpressure.md"],
        options: [
          { label: "Write to reading wiki", action: "mech:propose-mechanism" },
          { label: "Skip", action: "Skip" },
        ],
      },
    ])
  })

  it("titles an incomplete proposal by the title of its frontmatter when the frontmatter is complete", () => {
    const ctx = makeCtx({ identity: WORK })
    const unfinished = "---FILE: wiki/mechanisms/backpressure.md---\n---\ntype: mechanism\ntitle: Backpressure\n---\n# Backpressure\n\nA slow con"
    const result = enforce(unfinished, { ctx })

    expect(result.text).toBe("")
    expect(result.reviews.map((review) => review.title)).toEqual(["(incomplete) Backpressure"])
    expect(result.reviews[0].description).toBe("---\ntype: mechanism\ntitle: Backpressure\n---\n# Backpressure\n\nA slow con")
  })

  it("drops an unfinished type: mechanism block outside wiki/mechanisms/ in a work wiki", () => {
    const ctx = makeCtx({ identity: WORK })
    const unfinished = "---FILE: wiki/concepts/backpressure.md---\n---\ntype: mechanism\ntitle: Backpressure\n"
    const result = enforce(unfinished, { ctx })

    expect(result.text).toBe("")
    expect(result.reviews.map((review) => review.title)).toEqual(["(incomplete) backpressure"])
    expect(result.reviews[0].affectedPages).toEqual(["wiki/concepts/backpressure.md"])
  })

  it("keeps an unfinished mechanism block in a reading wiki so it can be repaired", () => {
    const unfinished = "---FILE: wiki/mechanisms/backpressure.md---\n---\ntype: mechanism\n"
    const result = enforce(unfinished)

    expect(result.text).toBe(unfinished)
    expect(result.reviews).toEqual([])
  })

  it("keeps an unfinished concept block so it can be repaired", () => {
    const unfinished = "---FILE: wiki/concepts/attention.md---\n---\ntype: concept\n"
    const result = enforce(unfinished)

    expect(result.text).toBe(unfinished)
  })

  it("proposed domain creates a new-domain review", () => {
    const decisions = decide({
      domain: null,
      proposedDomain: { path: "cognition/attention", lens: "ai", description: "How attention works" },
    })
    const review = proposedDomainReview(decisions, SOURCE_PATH)

    expect(review).not.toBeNull()
    expect(review?.type).toBe("new-domain")
    expect(review?.title).toBe("New domain: cognition/attention")
    expect(review?.sourcePath).toBe(SOURCE_PATH)
    expect(review?.description.split("\n")).toContain("PROPOSAL: cognition/attention | ai | How attention works")
    expect(review?.options).toEqual([
      { label: "Approve", action: "mech:approve-domain" },
      { label: "Skip", action: "Skip" },
    ])
  })

  it("makes no new-domain review when no domain is proposed", () => {
    expect(proposedDomainReview(decide(), SOURCE_PATH)).toBeNull()
  })

  it("writes a proposal description on one line", () => {
    const decisions = decide({
      domain: null,
      proposedDomain: { path: "cognition/attention", lens: "ai", description: "How attention\nworks | and why" },
    })

    expect(proposedDomainReview(decisions, SOURCE_PATH)?.description.split("\n")).toContain(
      "PROPOSAL: cognition/attention | ai | How attention works | and why",
    )
  })

  it("leaves the new-domain review to its caller, so a second pass does not repeat it", () => {
    const decisions = decide({
      domain: null,
      proposedDomain: { path: "cognition/attention", lens: "ai", description: "How attention works" },
    })
    const result = enforce(block("wiki/concepts/attention.md", page("concept")), { decisions })

    expect(contentsByPath(result.text)["wiki/concepts/attention.md"]).toContain("\ndomain: cognition/attention\n")
    expect(result.reviews).toEqual([])
    expect(result.notes.some((note) => note.includes("new-domain") || note.includes("proposed domain"))).toBe(false)
  })

  it("never adds domain to hypothesis pages", () => {
    const hypothesis = page("hypothesis", ["mechanism: backpressure", "from_domain: hardware/async-circuits", "to_domain: ai/architecture"], "H")
    const byPath = block("wiki/hypotheses/h.md", hypothesis)
    const byType = block("wiki/synthesis/h2.md", hypothesis)
    const unlisted = block("wiki/hypotheses/h3.md", page("hypothesis", ["domain: made/up"], "H3"))
    const generation = [byPath, byType, unlisted].join("\n\n")
    const result = enforce(generation)

    expect(result.text).toBe(generation)
    expect(result.notes).toEqual([])
    // A page in wiki/hypotheses/ is a hypothesis whatever its type line says.
    const untyped = block("wiki/Hypotheses/h4.md", page("concept", [], "H4"))
    expect(enforce(untyped).text).toBe(untyped)
  })

  it("work wiki proposes a type: mechanism page written outside wiki/mechanisms/", () => {
    // writeFileBlocks moves a page to the folder of its type after the rules ran.
    const ctx = makeCtx({ identity: WORK })
    const mechanism = page("mechanism", ["domain: ai/architecture"], "Backpressure")
    const result = enforce(block("wiki/concepts/backpressure.md", mechanism), { ctx })

    expect(result.text).toBe("")
    expect(result.reviews).toEqual([
      {
        type: "new-mechanism",
        title: "Backpressure",
        description: mechanism,
        sourcePath: SOURCE_PATH,
        affectedPages: ["wiki/concepts/backpressure.md"],
        options: [
          { label: "Write to reading wiki", action: "mech:propose-mechanism" },
          { label: "Skip", action: "Skip" },
        ],
      },
    ])
  })

  it("reading wiki strips domain from a type: mechanism page outside wiki/mechanisms/", () => {
    const mechanism = page("mechanism", ["domain: ai/architecture", "also: [hardware/async-circuits]"], "Backpressure")
    const result = enforce(block("wiki/concepts/backpressure.md", mechanism))

    expect(contentsByPath(result.text)["wiki/concepts/backpressure.md"]).toBe(
      page("mechanism", ["lenses: [ai]", "instances: []"], "Backpressure"),
    )
    expect(result.reviews).toEqual([])
  })

  it("reads the type of a page whose frontmatter does not parse", () => {
    const ctx = makeCtx({ identity: WORK })
    const broken = ["---", "type: mechanism", "title: Backpressure: a trap", "---", "# Backpressure"].join("\n")
    const result = enforce(block("wiki/concepts/backpressure.md", broken), { ctx })

    expect(result.text).toBe("")
    expect(result.reviews).toHaveLength(1)
  })

  it("leaves index, log, overview untouched", () => {
    const generation = [
      block("wiki/index.md", "# Index\n\n- [[a]]"),
      block("wiki/log.md", page("log", [], "Log")),
      block("wiki/overview.md", page("overview", [], "Overview")),
    ].join("\n\n")
    const result = enforce(generation)

    expect(result.text).toBe(generation)
    expect(result.notes).toEqual([])
  })

  it("round-trips blocks it does not change byte-for-byte", () => {
    const generation = [
      "Some text before the blocks.",
      "",
      block("wiki/concepts/a.md", page("concept", ["domain: ai/architecture"])),
      "",
      "",
      "---REVIEW: contradiction | A versus B---",
      "A says one thing and B another.",
      "OPTIONS: Approve | Skip",
      "---END REVIEW---",
      "--- FILE: wiki/concepts/b.md ---",
      "---",
      "type: concept",
      "domain: hardware/async-circuits",
      "---",
      "```",
      "---END FILE---",
      "```",
      "---end file---",
      "",
      "Text after the blocks.\n",
    ].join("\n")

    expect(enforce(generation).text).toBe(generation)
  })

  it("round-trips CRLF text that it does not change", () => {
    const generation = block("wiki/concepts/a.md", page("concept", ["domain: ai/architecture"])).replace(/\n/g, "\r\n")

    expect(enforce(generation).text).toBe(generation)
  })

  it("keeps the text between blocks and the order of blocks when it changes one", () => {
    const first = block("wiki/concepts/a.md", page("concept", ["domain: ai/architecture"], "A"))
    const second = block("wiki/concepts/b.md", page("concept", [], "B"))
    const review = "---REVIEW: suggestion | Look into C---\nC is unclear.\nSEARCH: c topic\n---END REVIEW---"
    const generation = `Before.\n\n${first}\n\n${review}\n${second}\n\nAfter.\n`
    const result = enforce(generation)

    expect(result.text).toBe(generation.replace("tags: []\n---\n# B", "tags: []\ndomain: ai/architecture\n---\n# B"))
  })

  it("keeps the opener and closer lines of a block it changes", () => {
    const generation = `--- FILE: wiki/concepts/b.md ---\n${page("concept", [], "B")}\n---end file---\n`
    const result = enforce(generation)

    expect(result.text.startsWith("--- FILE: wiki/concepts/b.md ---\n")).toBe(true)
    expect(result.text.endsWith("\n---end file---\n")).toBe(true)
    expect(result.text).toContain("domain: ai/architecture")
  })

  it("converts new-mechanism review blocks", () => {
    const concept = block("wiki/concepts/attention.md", page("concept", ["domain: ai/architecture"]))
    const other = "---REVIEW: contradiction | A versus B---\nA says one thing and B another.\n---END REVIEW---"
    const proposal = [
      "---REVIEW: new-mechanism | Backpressure---",
      "A slow consumer slows the producer.",
      "PAGES: wiki/concepts/attention.md, wiki/concepts/flow-control.md",
      "OPTIONS: Create | Skip",
      "---END REVIEW---",
    ].join("\n")
    const generation = `${concept}\n${proposal}\n${other}\n`
    const result = enforce(generation)

    expect(result.text).toBe(`${concept}\n${other}\n`)
    expect(result.reviews).toEqual([
      {
        type: "new-mechanism",
        title: "Backpressure",
        description: "A slow consumer slows the producer.",
        sourcePath: SOURCE_PATH,
        affectedPages: ["wiki/concepts/attention.md", "wiki/concepts/flow-control.md"],
        options: [
          { label: "Write to reading wiki", action: "mech:propose-mechanism" },
          { label: "Skip", action: "Skip" },
        ],
      },
    ])
    expect(result.notes).toContain('Moved the new-mechanism review "Backpressure" to the review queue')
  })

  it("converts a new-mechanism review block that has no PAGES line", () => {
    const result = enforce("---REVIEW: NEW-MECHANISM | Backpressure---\nA slow consumer slows the producer.\n---END REVIEW---")

    expect(result.text).toBe("")
    expect(result.reviews).toHaveLength(1)
    expect(result.reviews[0].affectedPages).toBeUndefined()
    expect(result.reviews[0].description).toBe("A slow consumer slows the producer.")
  })

  it("collects every new-mechanism review block and drops only those", () => {
    const first = "---REVIEW: new-mechanism | One---\nFirst.\n---END REVIEW---"
    const second = "---REVIEW: new-mechanism | Two---\nSecond.\n---END REVIEW---"
    const keep = "---REVIEW: missing-page | Three---\nThird.\n---END REVIEW---"
    const concept = block("wiki/concepts/a.md", page("concept", ["domain: ai/architecture"]))
    const result = enforce(`${first}\n${keep}\n${concept}\n${second}`)

    expect(result.text).toBe(`${keep}\n${concept}`)
    expect(result.reviews.map((review) => review.title)).toEqual(["One", "Two"])
  })

  it("does not read a review block that sits inside a page", () => {
    const inside = block("wiki/concepts/a.md", `${page("concept", ["domain: ai/architecture"])}\n\n---REVIEW: new-mechanism | Quoted---\nQuoted.\n---END REVIEW---`)
    const result = enforce(inside)

    expect(result.text).toBe(inside)
    expect(result.reviews).toEqual([])
  })

  it("returns text without blocks unchanged", () => {
    expect(enforce("---RESUME COMPLETE---").text).toBe("---RESUME COMPLETE---")
    expect(enforce("").text).toBe("")
  })
})
