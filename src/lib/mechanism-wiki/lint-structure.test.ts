import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import type { DomainsConfig } from "@/lib/wiki-config/domains"
import { DEFAULT_LINT_THRESHOLDS } from "@/lib/wiki-config/wiki-identity"
import type { WikiIdentity } from "@/lib/wiki-config/wiki-identity"
import { checkStructure, configProblemText, structurePageFromMarkdown } from "./lint-structure"
import type { StructureFinding, StructureInput, StructurePage } from "./lint-structure"

const ALPHA = "example/alpha"
const BETA = "example/beta"
const GAMMA = "example/gamma"
const DELTA = "library/delta"
const TODAY = "2026-10-26"
const CARD_1 = "00000000-0000-4000-8000-000000000001"
const CARD_2 = "00000000-0000-4000-8000-000000000002"

function domainsOf(...names: string[]): DomainsConfig {
  return {
    version: 1,
    domains: Object.fromEntries(names.map((name) => [name, { lens: "ai", description: `The ${name} domain`, whiteboards: [] }])),
  }
}

const READING: WikiIdentity = {
  version: 1,
  id: "reading",
  role: "reading",
  mechanism_library: null,
  lint: DEFAULT_LINT_THRESHOLDS,
}
const WORK: WikiIdentity = { ...READING, id: "work", role: "work", mechanism_library: "../reading" }

type Fields = Record<string, string | string[] | undefined>

/** A page from frontmatter fields. An array is written as a YAML list; `undefined` leaves the field out. */
function pageOf(path: string, fields: Fields, body = "# Heading\n"): StructurePage {
  const lines = Object.entries(fields)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) =>
      Array.isArray(value) ? `${key}: [${value.map((item) => JSON.stringify(item)).join(", ")}]` : `${key}: ${JSON.stringify(value)}`,
    )
  return structurePageFromMarkdown(path, `---\n${lines.join("\n")}\n---\n${body}`)
}

function input(pages: StructurePage[], overrides: Partial<StructureInput> = {}): StructureInput {
  return {
    pages,
    domains: domainsOf(ALPHA, BETA),
    identity: { ...READING, lint: { ...DEFAULT_LINT_THRESHOLDS, min_domain_pages: 1 } },
    cardMap: null,
    today: TODAY,
    ...overrides,
  }
}

function only(check: string, findings: StructureFinding[]): StructureFinding[] {
  return findings.filter((finding) => finding.check === check)
}

describe("structurePageFromMarkdown", () => {
  it("reads the fields that the checks need", () => {
    const page = pageOf("wiki/concepts/a.md", {
      type: "concept",
      title: "Alpha",
      domain: ALPHA,
      also: [BETA],
      sources: ["a.md", "b.md"],
      status: "draft",
      updated: "2026-10-01",
      instances: ["x", "y"],
    })
    expect(page).toMatchObject({
      path: "wiki/concepts/a.md",
      slug: "a",
      type: "concept",
      title: "Alpha",
      domain: ALPHA,
      also: [BETA],
      sources: ["a.md", "b.md"],
      status: "draft",
      updated: "2026-10-01",
      instances: ["x", "y"],
    })
  })

  it("gives empty lists for missing fields and takes a single string as a list of one", () => {
    const bare = pageOf("wiki/concepts/a.md", { type: "concept" })
    expect(bare.also).toEqual([])
    expect(bare.sources).toEqual([])
    expect(bare.instances).toBeUndefined()
    expect(pageOf("wiki/concepts/b.md", { type: "concept", also: BETA }).also).toEqual([BETA])
  })

  it("reads created and takes an unquoted date as text", () => {
    const page = structurePageFromMarkdown(
      "wiki/hypotheses/h.md",
      "---\ntype: hypothesis\ncreated: 2026-01-15\nupdated: 2026-02-01\n---\n# H\n",
    )
    expect(page.created).toBe("2026-01-15")
    expect(page.updated).toBe("2026-02-01")
  })

  it("reads a hypothesis by its to_domain and keeps its from_domain", () => {
    const page = pageOf("wiki/hypotheses/h.md", { type: "hypothesis", from_domain: ALPHA, to_domain: BETA })
    expect(page.domain).toBe(BETA)
    expect(page.fromDomain).toBe(ALPHA)
  })

  it("has no from_domain for a page that is not a hypothesis", () => {
    expect(pageOf("wiki/concepts/a.md", { type: "concept", from_domain: ALPHA }).fromDomain).toBeNull()
  })
})

describe("domain-missing", () => {
  it("flags a page without a domain", () => {
    const findings = only(
      "domain-missing",
      checkStructure(input([pageOf("wiki/concepts/a.md", { type: "concept" }), pageOf("wiki/concepts/b.md", { type: "concept", domain: ALPHA })])),
    )
    expect(findings).toHaveLength(1)
    expect(findings[0]).toEqual({
      check: "domain-missing",
      page: "wiki/concepts/a.md",
      message: "This page has no domain. Set domain to a path from domains.yaml.",
    })
  })

  it("flags a page whose domain is empty", () => {
    const findings = only("domain-missing", checkStructure(input([pageOf("wiki/sources/a.md", { type: "source", domain: "  " })])))
    expect(findings.map((finding) => finding.page)).toEqual(["wiki/sources/a.md"])
  })

  it("does not apply to index.md, log.md, overview.md, or wiki/indexes/", () => {
    const pages = [
      pageOf("wiki/index.md", { type: "index" }),
      pageOf("wiki/log.md", { type: "log" }),
      pageOf("wiki/overview.md", { type: "overview" }),
      pageOf("wiki/indexes/example--alpha.md", {}),
      pageOf("wiki/indexes/_mechanisms.md", {}),
    ]
    expect(only("domain-missing", checkStructure(input(pages)))).toEqual([])
  })

  it("does not apply to a mechanism page", () => {
    const pages = [pageOf("wiki/mechanisms/m.md", { type: "mechanism", instances: ["x"] })]
    expect(only("domain-missing", checkStructure(input(pages)))).toEqual([])
  })

  it("does not ask a hypothesis page for a domain: it has from_domain and to_domain", () => {
    const pages = [pageOf("wiki/hypotheses/h.md", { type: "hypothesis", from_domain: ALPHA, to_domain: BETA })]
    expect(only("domain-missing", checkStructure(input(pages)))).toEqual([])
  })

  it("takes the type of a page from its folder when the frontmatter has none", () => {
    const pages = [pageOf("wiki/mechanisms/m.md", {})]
    expect(only("domain-missing", checkStructure(input(pages)))).toEqual([])
    const hypothesis = only("domain-missing", checkStructure(input([pageOf("wiki/hypotheses/h.md", {})])))
    expect(hypothesis.map((finding) => finding.message)).toEqual([
      "This hypothesis has no from_domain. Set it to a path from domains.yaml.",
      "This hypothesis has no to_domain. Set it to a path from domains.yaml.",
    ])
  })

  describe("a hypothesis without from_domain or to_domain (ruling U10)", () => {
    it("names the missing to_domain", () => {
      const pages = [pageOf("wiki/hypotheses/h.md", { type: "hypothesis", from_domain: ALPHA })]
      expect(only("domain-missing", checkStructure(input(pages)))).toEqual([
        {
          check: "domain-missing",
          page: "wiki/hypotheses/h.md",
          message: "This hypothesis has no to_domain. Set it to a path from domains.yaml.",
        },
      ])
    })

    it("names the missing from_domain", () => {
      const pages = [pageOf("wiki/hypotheses/h.md", { type: "hypothesis", to_domain: BETA })]
      expect(only("domain-missing", checkStructure(input(pages)))).toEqual([
        {
          check: "domain-missing",
          page: "wiki/hypotheses/h.md",
          message: "This hypothesis has no from_domain. Set it to a path from domains.yaml.",
        },
      ])
    })

    it("gives one finding for each missing key when both are missing", () => {
      const pages = [pageOf("wiki/hypotheses/h.md", { type: "hypothesis" })]
      const findings = only("domain-missing", checkStructure(input(pages)))
      expect(findings).toHaveLength(2)
      expect(findings[0].message).toContain("from_domain")
      expect(findings[1].message).toContain("to_domain")
    })

    it("treats an empty value as missing", () => {
      const pages = [pageOf("wiki/hypotheses/h.md", { type: "hypothesis", from_domain: " ", to_domain: "" })]
      expect(only("domain-missing", checkStructure(input(pages)))).toHaveLength(2)
    })

    it("also applies in a work wiki", () => {
      const pages = [pageOf("wiki/hypotheses/h.md", { type: "hypothesis", from_domain: ALPHA })]
      expect(only("domain-missing", checkStructure(input(pages, { identity: WORK })))).toHaveLength(1)
    })
  })
})

describe("domain-unknown", () => {
  it("names a domain that domains.yaml does not list", () => {
    const pages = [pageOf("wiki/concepts/a.md", { type: "concept", domain: "example/nowhere" })]
    const findings = only("domain-unknown", checkStructure(input(pages)))
    expect(findings).toHaveLength(1)
    expect(findings[0]).toEqual({
      check: "domain-unknown",
      page: "wiki/concepts/a.md",
      message: 'Unknown domain "example/nowhere" in field domain. Add it to domains.yaml, or fix the page.',
      domains: ["example/nowhere"],
    })
  })

  it("checks every entry of also", () => {
    const pages = [pageOf("wiki/concepts/a.md", { type: "concept", domain: ALPHA, also: [BETA, "example/x", "example/y"] })]
    const findings = only("domain-unknown", checkStructure(input(pages)))
    expect(findings.map((finding) => finding.domains)).toEqual([["example/x"], ["example/y"]])
  })

  it("checks from_domain and to_domain of a hypothesis", () => {
    const pages = [pageOf("wiki/hypotheses/h.md", { type: "hypothesis", from_domain: "example/from", to_domain: "example/to" })]
    const findings = only("domain-unknown", checkStructure(input(pages)))
    expect(findings.map((finding) => finding.domains)).toEqual([["example/from"], ["example/to"]])
  })

  it("reports one domain once for a page, even when two fields hold it", () => {
    const pages = [pageOf("wiki/concepts/a.md", { type: "concept", domain: "example/x", also: ["example/x"] })]
    expect(only("domain-unknown", checkStructure(input(pages)))).toHaveLength(1)
  })

  it("says nothing for known domains", () => {
    const pages = [
      pageOf("wiki/concepts/a.md", { type: "concept", domain: ALPHA, also: [BETA] }),
      pageOf("wiki/hypotheses/h.md", { type: "hypothesis", from_domain: ALPHA, to_domain: BETA }),
    ]
    expect(only("domain-unknown", checkStructure(input(pages)))).toEqual([])
  })

  it("does not report a missing domain as unknown", () => {
    const pages = [pageOf("wiki/concepts/a.md", { type: "concept" })]
    expect(only("domain-unknown", checkStructure(input(pages)))).toEqual([])
  })

  describe("a work wiki and the library domains (ruling U9, refined)", () => {
    const hypothesis = pageOf("wiki/hypotheses/h.md", { type: "hypothesis", from_domain: DELTA, to_domain: ALPHA })
    const library = domainsOf(DELTA)

    it("knows a library domain in from_domain and to_domain of a hypothesis", () => {
      const pages = [hypothesis, pageOf("wiki/hypotheses/g.md", { type: "hypothesis", from_domain: ALPHA, to_domain: DELTA })]
      const findings = checkStructure(input(pages, { identity: WORK, libraryDomains: library }))
      expect(only("domain-unknown", findings)).toEqual([])
    })

    it("does not know a library domain in the domain of a plain page", () => {
      const pages = [pageOf("wiki/concepts/a.md", { type: "concept", domain: DELTA })]
      const findings = only("domain-unknown", checkStructure(input(pages, { identity: WORK, libraryDomains: library })))
      expect(findings).toEqual([
        {
          check: "domain-unknown",
          page: "wiki/concepts/a.md",
          message: 'Unknown domain "library/delta" in field domain. Add it to domains.yaml, or fix the page.',
          domains: [DELTA],
        },
      ])
    })

    it("does not know a library domain in the also list of a plain page", () => {
      const pages = [pageOf("wiki/concepts/a.md", { type: "concept", domain: ALPHA, also: [DELTA] })]
      const findings = only("domain-unknown", checkStructure(input(pages, { identity: WORK, libraryDomains: library })))
      expect(findings.map((finding) => finding.domains)).toEqual([[DELTA]])
      expect(findings[0].message).toContain("field also")
    })

    it("does not know a library domain in the also list of a hypothesis", () => {
      const pages = [pageOf("wiki/hypotheses/h.md", { type: "hypothesis", from_domain: DELTA, to_domain: ALPHA, also: [DELTA] })]
      const findings = only("domain-unknown", checkStructure(input(pages, { identity: WORK, libraryDomains: library })))
      expect(findings).toHaveLength(1)
      expect(findings[0].message).toContain("field also")
      expect(findings[0].message).not.toContain("from_domain")
    })

    it("says where a hypothesis domain was looked up when it is in neither file", () => {
      const findings = only("domain-unknown", checkStructure(input([hypothesis], { identity: WORK, libraryDomains: domainsOf("library/other") })))
      expect(findings).toEqual([
        {
          check: "domain-unknown",
          page: "wiki/hypotheses/h.md",
          message:
            'Unknown domain "library/delta" in field from_domain. It is in neither domains.yaml of this wiki nor domains.yaml of the reading wiki. Add it to domains.yaml, or fix the page.',
          domains: [DELTA],
        },
      ])
    })

    it("reports a hypothesis domain when the library domains are not known", () => {
      const findings = checkStructure(input([hypothesis], { identity: WORK, libraryDomains: null }))
      expect(only("domain-unknown", findings)).toHaveLength(1)
      expect(checkStructure(input([hypothesis], { identity: WORK }))).toEqual(findings)
    })

    it("ignores the library domains in a reading wiki", () => {
      const findings = checkStructure(input([hypothesis], { identity: READING, libraryDomains: library }))
      expect(only("domain-unknown", findings)).toHaveLength(1)
    })
  })
})

describe("concept-cross-domain", () => {
  const sourceA = pageOf("wiki/sources/a.md", { type: "source", domain: ALPHA, sources: ["a.md"] })
  const sourceB = pageOf("wiki/sources/b.md", { type: "source", domain: BETA, sources: ["b.md"] })
  const sourceA2 = pageOf("wiki/sources/a2.md", { type: "source", domain: ALPHA, sources: ["a2.md"] })

  it("flags a concept whose sources are in two domains and names both", () => {
    const concept = pageOf("wiki/concepts/c.md", { type: "concept", domain: ALPHA, sources: ["a.md", "b.md"] })
    const findings = only("concept-cross-domain", checkStructure(input([sourceA, sourceB, concept])))
    expect(findings).toHaveLength(1)
    expect(findings).toEqual([
      {
        check: "concept-cross-domain",
        page: "wiki/concepts/c.md",
        message:
          "This concept page cites sources from 2 domains: example/alpha, example/beta. Split the page by domain, or move the shared structure to a mechanism page.",
        domains: [ALPHA, BETA],
      },
    ])
  })

  it("flags an entity page the same way", () => {
    const entity = pageOf("wiki/entities/e.md", { type: "entity", domain: BETA, sources: ["a.md", "b.md"] })
    const findings = only("concept-cross-domain", checkStructure(input([sourceA, sourceB, entity])))
    expect(findings.map((finding) => finding.page)).toEqual(["wiki/entities/e.md"])
  })

  it("names every domain, sorted, when there are three", () => {
    const sourceC = pageOf("wiki/sources/c.md", { type: "source", domain: GAMMA, sources: ["c.md"] })
    const concept = pageOf("wiki/concepts/c.md", { type: "concept", domain: ALPHA, sources: ["c.md", "b.md", "a.md"] })
    const findings = only("concept-cross-domain", checkStructure(input([sourceC, sourceB, sourceA, concept])))
    expect(findings[0].domains).toEqual([ALPHA, BETA, GAMMA])
  })

  it("says nothing when all sources are in one domain", () => {
    const concept = pageOf("wiki/concepts/c.md", { type: "concept", domain: ALPHA, sources: ["a.md", "a2.md"] })
    expect(only("concept-cross-domain", checkStructure(input([sourceA, sourceA2, concept])))).toEqual([])
  })

  it("says nothing when the page has one source", () => {
    const concept = pageOf("wiki/concepts/c.md", { type: "concept", domain: ALPHA, sources: ["a.md"] })
    expect(only("concept-cross-domain", checkStructure(input([sourceA, sourceB, concept])))).toEqual([])
  })

  it("ignores a source name that no source page holds", () => {
    const concept = pageOf("wiki/concepts/c.md", { type: "concept", domain: ALPHA, sources: ["a.md", "lost.md"] })
    expect(only("concept-cross-domain", checkStructure(input([sourceA, concept])))).toEqual([])
  })

  it("ignores a source page that has no domain", () => {
    const loose = pageOf("wiki/sources/loose.md", { type: "source", sources: ["loose.md"] })
    const concept = pageOf("wiki/concepts/c.md", { type: "concept", domain: ALPHA, sources: ["a.md", "loose.md"] })
    expect(only("concept-cross-domain", checkStructure(input([sourceA, loose, concept])))).toEqual([])
  })

  it("matches the raw file name without case, folder prefix, or back slashes", () => {
    const heptabase = pageOf("wiki/sources/h.md", { type: "source", domain: BETA, sources: ["heptabase/Card.md"] })
    const concept = pageOf("wiki/concepts/c.md", { type: "concept", domain: ALPHA, sources: ["raw/sources/a.md", "heptabase\\card.MD"] })
    const findings = only("concept-cross-domain", checkStructure(input([sourceA, heptabase, concept])))
    expect(findings).toHaveLength(1)
  })

  it("lets one raw file back two source pages in different domains", () => {
    const twin = pageOf("wiki/sources/a-twin.md", { type: "source", domain: GAMMA, sources: ["a.md"] })
    const concept = pageOf("wiki/concepts/c.md", { type: "concept", domain: ALPHA, sources: ["a.md"] })
    const findings = only("concept-cross-domain", checkStructure(input([sourceA, twin, concept])))
    expect(findings[0].domains).toEqual([ALPHA, GAMMA])
  })

  describe("Heptabase snapshot sources", () => {
    const ID_1 = "00000000-0000-4000-8000-000000000001"
    const ID_2 = "00000000-0000-4000-8000-000000000002"
    // The snapshot command writes raw/sources/heptabase/<card-id>.md. A source page lists that file as heptabase/<card-id>.md.
    const snapshotA = pageOf("wiki/sources/card-one.md", { type: "source", domain: ALPHA, sources: [`heptabase/${ID_1}.md`] })
    const snapshotB = pageOf("wiki/sources/card-two.md", { type: "source", domain: BETA, sources: [`heptabase/${ID_2}.md`] })

    it("flags a concept that cites two snapshots in two domains, by the same names", () => {
      const concept = pageOf("wiki/concepts/c.md", {
        type: "concept",
        domain: ALPHA,
        sources: [`heptabase/${ID_1}.md`, `heptabase/${ID_2}.md`],
      })
      const findings = only("concept-cross-domain", checkStructure(input([snapshotA, snapshotB, concept])))
      expect(findings.map((finding) => finding.domains)).toEqual([[ALPHA, BETA]])
    })

    it("flags a concept that cites the snapshots by the full raw path", () => {
      const concept = pageOf("wiki/concepts/c.md", {
        type: "concept",
        domain: ALPHA,
        sources: [`raw/sources/heptabase/${ID_1}.md`, `raw/sources/heptabase/${ID_2}.md`],
      })
      expect(only("concept-cross-domain", checkStructure(input([snapshotA, snapshotB, concept])))).toHaveLength(1)
    })

    it("matches a bare file name (the card id alone) when one source page has that base name", () => {
      const concept = pageOf("wiki/concepts/c.md", { type: "concept", domain: ALPHA, sources: [`${ID_1}.md`, `${ID_2}.md`] })
      const findings = only("concept-cross-domain", checkStructure(input([snapshotA, snapshotB, concept])))
      expect(findings.map((finding) => finding.domains)).toEqual([[ALPHA, BETA]])
    })

    it("does not match a bare file name when two source pages have that base name", () => {
      const twin = pageOf("wiki/sources/card-two-copy.md", { type: "source", domain: GAMMA, sources: [`archive/${ID_2}.md`] })
      const sameDomain = pageOf("wiki/sources/b2.md", { type: "source", domain: BETA, sources: [`heptabase/${ID_2}.md`] })
      const concept = pageOf("wiki/concepts/c.md", { type: "concept", domain: ALPHA, sources: [`${ID_1}.md`, `${ID_2}.md`] })
      // ID_2 is ambiguous (two source pages), so only ID_1 resolves: one domain, no finding.
      expect(only("concept-cross-domain", checkStructure(input([snapshotA, sameDomain, twin, concept])))).toEqual([])
    })

    it("an exact name wins over the base name, even when the base name is ambiguous", () => {
      const twin = pageOf("wiki/sources/card-two-copy.md", { type: "source", domain: GAMMA, sources: [`archive/${ID_2}.md`] })
      const concept = pageOf("wiki/concepts/c.md", {
        type: "concept",
        domain: ALPHA,
        sources: [`heptabase/${ID_1}.md`, `heptabase/${ID_2}.md`],
      })
      const findings = only("concept-cross-domain", checkStructure(input([snapshotA, snapshotB, twin, concept])))
      expect(findings.map((finding) => finding.domains)).toEqual([[ALPHA, BETA]])
    })

    it("does not use the base name for an entry that has a folder", () => {
      const concept = pageOf("wiki/concepts/c.md", {
        type: "concept",
        domain: ALPHA,
        sources: [`heptabase/${ID_1}.md`, `other/${ID_2}.md`],
      })
      expect(only("concept-cross-domain", checkStructure(input([snapshotA, snapshotB, concept])))).toEqual([])
    })

    it("counts a source page without a domain when it decides whether a base name is ambiguous", () => {
      const loose = pageOf("wiki/sources/loose.md", { type: "source", sources: [`archive/${ID_2}.md`] })
      const concept = pageOf("wiki/concepts/c.md", { type: "concept", domain: ALPHA, sources: [`${ID_1}.md`, `${ID_2}.md`] })
      expect(only("concept-cross-domain", checkStructure(input([snapshotA, snapshotB, loose, concept])))).toEqual([])
    })
  })

  it("does not check other page types", () => {
    const query = pageOf("wiki/queries/q.md", { type: "query", domain: ALPHA, sources: ["a.md", "b.md"] })
    const other = pageOf("wiki/sources/two.md", { type: "source", domain: ALPHA, sources: ["a.md", "b.md"] })
    expect(only("concept-cross-domain", checkStructure(input([sourceA, sourceB, query, other])))).toEqual([])
  })
})

describe("mechanism-no-instance", () => {
  it("flags a mechanism with an empty instances list in a reading wiki", () => {
    const pages = [pageOf("wiki/mechanisms/m.md", { type: "mechanism", instances: [] })]
    const findings = only("mechanism-no-instance", checkStructure(input(pages)))
    expect(findings).toHaveLength(1)
    expect(findings).toEqual([
      {
        check: "mechanism-no-instance",
        page: "wiki/mechanisms/m.md",
        message: "This mechanism has no instance. Add an instance page under Known instances, or remove the mechanism.",
      },
    ])
  })

  it("flags a mechanism without an instances field", () => {
    const pages = [pageOf("wiki/mechanisms/m.md", { type: "mechanism" })]
    expect(only("mechanism-no-instance", checkStructure(input(pages)))).toHaveLength(1)
  })

  it("says nothing for a mechanism with an instance", () => {
    const pages = [pageOf("wiki/mechanisms/m.md", { type: "mechanism", instances: ["x"] })]
    expect(only("mechanism-no-instance", checkStructure(input(pages)))).toEqual([])
  })

  it("work wiki skips mechanism-no-instance", () => {
    const pages = [pageOf("wiki/mechanisms/m.md", { type: "mechanism", instances: [] })]
    expect(only("mechanism-no-instance", checkStructure(input(pages, { identity: WORK })))).toEqual([])
  })
})

describe("mirror-retired", () => {
  const retiredEntry = { status: "retired", card_id: CARD_1 }

  it("names the page path and the card id, and says how to find the card (ruling U1)", () => {
    const pages = [pageOf("wiki/concepts/a.md", { type: "concept", title: "Alpha Page", domain: ALPHA })]
    const findings = only(
      "mirror-retired",
      checkStructure(input(pages, { cardMap: { pages: { "wiki/concepts/a.md": retiredEntry } } })),
    )
    expect(findings).toEqual([
      {
        check: "mirror-retired",
        page: "wiki/concepts/a.md",
        message:
          `The card of wiki/concepts/a.md ("Alpha Page") is retired. Card id: ${CARD_1}. ` +
          'Find the card in the mirror tag by this id or by the "🗄 已停用" title prefix. Delete it by hand.',
      },
    ])
  })

  it("names no title when the page is gone", () => {
    const findings = only(
      "mirror-retired",
      checkStructure(input([], { cardMap: { pages: { "wiki/concepts/gone.md": retiredEntry } } })),
    )
    expect(findings).toEqual([
      {
        check: "mirror-retired",
        page: "wiki/concepts/gone.md",
        message:
          `The card of wiki/concepts/gone.md is retired. Card id: ${CARD_1}. ` +
          'Find the card in the mirror tag by this id or by the "🗄 已停用" title prefix. Delete it by hand.',
      },
    ])
  })

  it("says nothing for an active entry or without a card map", () => {
    const pages = [pageOf("wiki/concepts/a.md", { type: "concept", domain: ALPHA })]
    const active = { pages: { "wiki/concepts/a.md": { status: "active", card_id: CARD_1 } } }
    expect(only("mirror-retired", checkStructure(input(pages, { cardMap: active })))).toEqual([])
    expect(only("mirror-retired", checkStructure(input(pages, { cardMap: null })))).toEqual([])
  })
})

describe("map-missing-page", () => {
  it("flags an active entry whose page is not in pages", () => {
    const pages = [pageOf("wiki/concepts/a.md", { type: "concept", domain: ALPHA })]
    const cardMap = {
      pages: {
        "wiki/concepts/a.md": { status: "active", card_id: CARD_1 },
        "wiki/concepts/gone.md": { status: "active", card_id: CARD_2 },
      },
    }
    const findings = only("map-missing-page", checkStructure(input(pages, { cardMap })))
    expect(findings).toEqual([
      {
        check: "map-missing-page",
        page: "wiki/concepts/gone.md",
        message: `The card map lists wiki/concepts/gone.md (card id: ${CARD_2}) as active, but the page is not in the wiki. Restore the page, or let the next mirror sync retire the card.`,
      },
    ])
  })

  it("does not flag a retired entry whose page is gone", () => {
    const cardMap = { pages: { "wiki/concepts/gone.md": { status: "retired", card_id: CARD_2 } } }
    expect(only("map-missing-page", checkStructure(input([], { cardMap })))).toEqual([])
  })

  it("says nothing without a card map", () => {
    expect(only("map-missing-page", checkStructure(input([], { cardMap: null })))).toEqual([])
  })
})

describe("hypothesis-stale-draft", () => {
  function hypothesis(fields: Fields): StructurePage {
    return pageOf("wiki/hypotheses/h.md", { type: "hypothesis", from_domain: ALPHA, to_domain: BETA, ...fields })
  }

  it("flags a draft that is older than 30 days", () => {
    const findings = only("hypothesis-stale-draft", checkStructure(input([hypothesis({ status: "draft", updated: "2026-09-20" })])))
    expect(findings).toEqual([
      {
        check: "hypothesis-stale-draft",
        page: "wiki/hypotheses/h.md",
        message:
          "This hypothesis has been a draft for 36 days (updated 2026-09-20). " +
          'To move it to testing, add a row under "What to verify" that links a page in wiki/queries/. ' +
          "If you cannot, update or remove the hypothesis.",
      },
    ])
  })

  it("says that testing needs a verify row that links a query page (ruling R18)", () => {
    const [finding] = only("hypothesis-stale-draft", checkStructure(input([hypothesis({ status: "draft", updated: "2026-01-01" })])))
    expect(finding.message).toContain("testing")
    expect(finding.message).toContain("What to verify")
    expect(finding.message).toContain("wiki/queries/")
  })

  it("uses 'more than' the limit: the 30th day is fine, the 31st is stale", () => {
    // 2026-10-26 minus 30 days is 2026-09-26.
    expect(only("hypothesis-stale-draft", checkStructure(input([hypothesis({ status: "draft", updated: "2026-09-26" })])))).toEqual([])
    expect(only("hypothesis-stale-draft", checkStructure(input([hypothesis({ status: "draft", updated: "2026-09-25" })])))).toHaveLength(1)
  })

  it("counts days across a month and a year boundary", () => {
    const identity = { ...READING, lint: { ...DEFAULT_LINT_THRESHOLDS, draft_days: 10 } }
    const stale = (updated: string, today: string) =>
      only("hypothesis-stale-draft", checkStructure(input([hypothesis({ status: "draft", updated })], { identity, today })))
    expect(stale("2025-12-25", "2026-01-04")).toEqual([])
    expect(stale("2025-12-25", "2026-01-05")).toHaveLength(1)
    expect(stale("2026-02-18", "2026-03-01")).toHaveLength(1)
    expect(stale("2026-02-19", "2026-03-01")).toEqual([])
  })

  it("says nothing for a draft that was updated lately", () => {
    expect(only("hypothesis-stale-draft", checkStructure(input([hypothesis({ status: "draft", updated: TODAY })])))).toEqual([])
  })

  it("says nothing for a hypothesis that is not a draft", () => {
    for (const status of ["testing", "supported", "refuted"]) {
      const pages = [hypothesis({ status, updated: "2025-01-01" })]
      expect(only("hypothesis-stale-draft", checkStructure(input(pages))), status).toEqual([])
    }
  })

  describe("a missing or bad updated date", () => {
    const stale = (fields: Fields) => only("hypothesis-stale-draft", checkStructure(input([hypothesis({ status: "draft", ...fields })])))

    it("uses created when updated is missing", () => {
      const findings = stale({ created: "2026-09-01" })
      expect(findings).toHaveLength(1)
      expect(findings[0].message).toContain("a draft for 55 days (created 2026-09-01).")
    })

    it("uses created when updated is not a date", () => {
      for (const updated of ["", "last week", "2026-13-45"]) {
        expect(stale({ updated, created: "2026-09-01" }), updated).toHaveLength(1)
      }
    })

    it("says nothing when created is recent and updated is bad", () => {
      expect(stale({ updated: "last week", created: "2026-10-20" })).toEqual([])
    })

    it("prefers a good updated date over created", () => {
      expect(stale({ updated: "2026-10-20", created: "2026-01-01" })).toEqual([])
    })

    it("reports the page when neither date is readable", () => {
      for (const fields of [{}, { updated: "soon" }, { updated: "soon", created: "2026-99-99" }]) {
        expect(stale(fields), JSON.stringify(fields)).toEqual([
          {
            check: "hypothesis-stale-draft",
            page: "wiki/hypotheses/h.md",
            message: "The date of this draft hypothesis is not readable. Set updated to a date in YYYY-MM-DD form.",
          },
        ])
      }
    })

    it("does not report a hypothesis that is not a draft, even without a date", () => {
      const pages = [hypothesis({ status: "testing" })]
      expect(only("hypothesis-stale-draft", checkStructure(input(pages)))).toEqual([])
    })
  })

  it("throws when today is not a date: that is a bug of the caller", () => {
    for (const today of ["", "yesterday", "2026-13-45", "26-10-2026"]) {
      expect(() => checkStructure(input([], { today })), today).toThrow(/today/)
    }
    expect(() => checkStructure(input([hypothesis({ status: "draft", updated: "2026-09-20" })], { today: "" }))).toThrow(/today/)
  })

  it("ignores a draft status on a page that is not a hypothesis", () => {
    const pages = [pageOf("wiki/concepts/c.md", { type: "concept", domain: ALPHA, status: "draft", updated: "2020-01-01" })]
    expect(only("hypothesis-stale-draft", checkStructure(input(pages)))).toEqual([])
  })
})

describe("domain-too-large and domain-too-small", () => {
  function pagesIn(domain: string, count: number, prefix = domain.replace("/", "-")): StructurePage[] {
    return Array.from({ length: count }, (_, index) =>
      pageOf(`wiki/concepts/${prefix}-${index}.md`, { type: "concept", domain }),
    )
  }

  it("flags a domain with more than 200 pages", () => {
    const findings = only("domain-too-large", checkStructure(input(pagesIn(ALPHA, 201))))
    expect(findings).toHaveLength(1)
    expect(findings).toEqual([
      {
        check: "domain-too-large",
        page: null,
        message: 'Domain "example/alpha" has 201 pages. The limit is 200. Split it into sub-domains.',
        domains: [ALPHA],
      },
    ])
  })

  it("does not flag a domain with exactly 200 pages", () => {
    expect(only("domain-too-large", checkStructure(input(pagesIn(ALPHA, 200))))).toEqual([])
  })

  it("flags a domain with fewer than 3 pages, with the default threshold", () => {
    const identity = READING
    const findings = only("domain-too-small", checkStructure(input([...pagesIn(ALPHA, 2), ...pagesIn(BETA, 3)], { identity })))
    expect(findings).toHaveLength(1)
    expect(findings).toEqual([
      {
        check: "domain-too-small",
        page: null,
        message: 'Domain "example/alpha" has 2 pages. The minimum is 3. Add pages, or merge it into a parent domain.',
        domains: [ALPHA],
      },
    ])
  })

  it("writes 1 page and 0 pages", () => {
    const findings = only("domain-too-small", checkStructure(input(pagesIn(ALPHA, 1), { identity: READING })))
    expect(findings.map((finding) => finding.message)).toEqual([
      'Domain "example/alpha" has 1 page. The minimum is 3. Add pages, or merge it into a parent domain.',
      'Domain "example/beta" has 0 pages. The minimum is 3. Add pages, or merge it into a parent domain.',
    ])
  })

  it("flags a domain of the config that has no page", () => {
    const findings = only("domain-too-small", checkStructure(input(pagesIn(ALPHA, 2), { identity: READING })))
    expect(findings.map((finding) => finding.domains)).toEqual([[ALPHA], [BETA]])
    expect(findings[1].message).toContain("0")
  })

  it("counts a hypothesis under its to_domain", () => {
    const hypotheses = Array.from({ length: 3 }, (_, index) =>
      pageOf(`wiki/hypotheses/h${index}.md`, { type: "hypothesis", from_domain: ALPHA, to_domain: BETA }),
    )
    const findings = only("domain-too-small", checkStructure(input(hypotheses, { identity: READING })))
    expect(findings.map((finding) => finding.domains)).toEqual([[ALPHA]])
  })

  it("counts a page once, under its domain, not under also", () => {
    const pages = Array.from({ length: 3 }, (_, index) =>
      pageOf(`wiki/concepts/c${index}.md`, { type: "concept", domain: ALPHA, also: [BETA] }),
    )
    const findings = only("domain-too-small", checkStructure(input(pages, { identity: READING })))
    expect(findings.map((finding) => finding.domains)).toEqual([[BETA]])
  })

  it("reports the domains of domains.yaml only, not the library domains", () => {
    const findings = checkStructure(
      input([], { identity: { ...WORK, lint: DEFAULT_LINT_THRESHOLDS }, domains: domainsOf(ALPHA), libraryDomains: domainsOf(DELTA) }),
    )
    expect(only("domain-too-small", findings).map((finding) => finding.domains)).toEqual([[ALPHA]])
  })

  it("does not count a page of an unlisted domain", () => {
    const findings = only("domain-too-small", checkStructure(input(pagesIn("example/nowhere", 5), { identity: READING })))
    expect(findings.map((finding) => finding.domains)).toEqual([[ALPHA], [BETA]])
  })

  it("custom thresholds from wiki.yaml apply", () => {
    const identity = { ...READING, lint: { ...DEFAULT_LINT_THRESHOLDS, max_domain_pages: 4, min_domain_pages: 5 } }
    const pages = [...pagesIn(ALPHA, 5), ...pagesIn(BETA, 3)]
    const findings = checkStructure(input(pages, { identity }))
    expect(only("domain-too-large", findings).map((finding) => finding.domains)).toEqual([[ALPHA]])
    expect(only("domain-too-small", findings).map((finding) => finding.domains)).toEqual([[BETA]])
  })

  it("custom draft_days from wiki.yaml applies", () => {
    const pages = [pageOf("wiki/hypotheses/h.md", { type: "hypothesis", from_domain: ALPHA, to_domain: BETA, status: "draft", updated: "2026-10-10" })]
    const strict = { ...READING, lint: { ...DEFAULT_LINT_THRESHOLDS, draft_days: 7 } }
    expect(only("hypothesis-stale-draft", checkStructure(input(pages)))).toEqual([])
    expect(only("hypothesis-stale-draft", checkStructure(input(pages, { identity: strict })))).toHaveLength(1)
  })
})

describe("config-invalid (ruling U14)", () => {
  const OWN_DOMAINS = "domains.yaml: could not read the file"
  const LIBRARY_DOMAINS = "reading wiki domains.yaml: could not read the file"
  const unknownPage = pageOf("wiki/concepts/a.md", { type: "concept", domain: "example/nowhere" })
  const hypothesis = pageOf("wiki/hypotheses/h.md", { type: "hypothesis", from_domain: DELTA, to_domain: "example/elsewhere" })

  it("gives one finding for each problem, about no page, and names the problem", () => {
    const findings = only("config-invalid", checkStructure(input([], { configProblems: [OWN_DOMAINS, "wiki.yaml: the file is missing"] })))
    expect(findings).toEqual([
      {
        check: "config-invalid",
        page: null,
        message: "A config file has a problem: domains.yaml: could not read the file. The domain checks are skipped until you fix the file.",
      },
      { check: "config-invalid", page: null, message: "A config file has a problem: wiki.yaml: the file is missing. Fix the file." },
    ])
  })

  it("says nothing when there is no problem", () => {
    expect(only("config-invalid", checkStructure(input([])))).toEqual([])
    expect(only("config-invalid", checkStructure(input([], { configProblems: [] })))).toEqual([])
    expect(only("config-invalid", checkStructure(input([], { configProblems: ["  "] })))).toEqual([])
  })

  describe("a problem in domains.yaml of this wiki", () => {
    it("skips domain-unknown, so a broken file does not flag every page", () => {
      const findings = checkStructure(input([unknownPage, hypothesis], { configProblems: [OWN_DOMAINS], domains: domainsOf() }))
      expect(only("config-invalid", findings)).toHaveLength(1)
      expect(only("domain-unknown", findings)).toEqual([])
    })

    it("skips the domain size checks", () => {
      const findings = checkStructure(input([], { configProblems: [OWN_DOMAINS] }))
      expect(only("domain-too-small", findings)).toEqual([])
      expect(only("domain-too-large", findings)).toEqual([])
    })

    it("also holds for a problem in one key of the file", () => {
      const findings = checkStructure(input([unknownPage], { configProblems: ["domains.yaml:domains.example/alpha.lens: lens must be a known lens"] }))
      expect(only("domain-unknown", findings)).toEqual([])
    })

    it("keeps the checks that do not need the list of domains", () => {
      const findings = checkStructure(input([pageOf("wiki/concepts/b.md", { type: "concept" })], { configProblems: [OWN_DOMAINS] }))
      expect(only("domain-missing", findings)).toHaveLength(1)
    })
  })

  describe("a problem in domains.yaml of the reading wiki", () => {
    it("skips only the library part: a hypothesis domain that this wiki does not list is not reported", () => {
      const findings = checkStructure(input([hypothesis], { identity: WORK, configProblems: [LIBRARY_DOMAINS] }))
      expect(only("config-invalid", findings)).toEqual([
        {
          check: "config-invalid",
          page: null,
          message: "A config file has a problem: reading wiki domains.yaml: could not read the file. The domains of the reading wiki are not checked until you fix the file.",
        },
      ])
      expect(only("domain-unknown", findings)).toEqual([])
    })

    it("still reports a domain or also entry that this wiki does not list", () => {
      const pages = [unknownPage, pageOf("wiki/concepts/c.md", { type: "concept", domain: ALPHA, also: [DELTA] })]
      const findings = checkStructure(input(pages, { identity: WORK, configProblems: [LIBRARY_DOMAINS] }))
      expect(only("domain-unknown", findings).map((finding) => finding.page)).toEqual(["wiki/concepts/a.md", "wiki/concepts/c.md"])
    })

    it("still reports a hypothesis domain that is neither known nor skipped when the library is fine", () => {
      const findings = checkStructure(input([hypothesis], { identity: WORK, libraryDomains: domainsOf(DELTA) }))
      expect(only("domain-unknown", findings).map((finding) => finding.domains)).toEqual([["example/elsewhere"]])
    })

    it("keeps the domain size checks of this wiki", () => {
      const findings = checkStructure(input([], { identity: WORK, configProblems: [LIBRARY_DOMAINS] }))
      expect(only("domain-too-small", findings)).toHaveLength(2)
    })
  })

  it("does not skip anything for a problem in another file", () => {
    const findings = checkStructure(input([unknownPage], { configProblems: ["wiki.yaml: the file is missing", "lenses/x.md: has no Fields section"] }))
    expect(only("config-invalid", findings)).toHaveLength(2)
    expect(only("domain-unknown", findings)).toHaveLength(1)
  })

  it("builds the text of a problem from a config issue", () => {
    expect(configProblemText({ path: "domains.yaml", message: "could not read the file" }, "this")).toBe(OWN_DOMAINS)
    expect(configProblemText({ path: "domains.yaml", message: "could not read the file" }, "library")).toBe(LIBRARY_DOMAINS)
    expect(configProblemText({ path: "", message: "bad" }, "this")).toBe("bad")
  })
})

describe("order and shape", () => {
  it("orders findings by check id, then by page path", () => {
    const pages = [
      pageOf("wiki/concepts/z.md", { type: "concept" }),
      pageOf("wiki/concepts/a.md", { type: "concept" }),
      pageOf("wiki/concepts/m.md", { type: "concept", domain: "example/nowhere" }),
      pageOf("wiki/mechanisms/m.md", { type: "mechanism", instances: [] }),
    ]
    const findings = checkStructure(input(pages, { cardMap: { pages: { "wiki/concepts/b.md": { status: "retired", card_id: CARD_1 } } } }))
    expect(findings.map((finding) => `${finding.check} ${finding.page ?? finding.domains?.join(",")}`)).toEqual([
      "domain-missing wiki/concepts/a.md",
      "domain-missing wiki/concepts/z.md",
      `domain-too-small ${ALPHA}`,
      `domain-too-small ${BETA}`,
      "domain-unknown wiki/concepts/m.md",
      "mechanism-no-instance wiki/mechanisms/m.md",
      "mirror-retired wiki/concepts/b.md",
    ])
  })

  it("gives the same output for the same pages in another order", () => {
    const pages = [
      pageOf("wiki/concepts/z.md", { type: "concept" }),
      pageOf("wiki/concepts/a.md", { type: "concept", domain: "example/nowhere" }),
      pageOf("wiki/sources/s.md", { type: "source", domain: ALPHA, sources: ["s.md"] }),
    ]
    const forward = checkStructure(input(pages, { identity: READING }))
    expect(checkStructure(input([...pages].reverse(), { identity: READING }))).toEqual(forward)
  })

  it("orders the domain-size findings by domain", () => {
    const findings = only("domain-too-small", checkStructure(input([], { identity: READING, domains: domainsOf(GAMMA, ALPHA, BETA) })))
    expect(findings.map((finding) => finding.domains)).toEqual([[ALPHA], [BETA], [GAMMA]])
  })

  it("finds nothing wrong in a tidy wiki", () => {
    const pages = [
      pageOf("wiki/sources/s.md", { type: "source", domain: ALPHA, sources: ["s.md"] }),
      pageOf("wiki/concepts/c.md", { type: "concept", domain: ALPHA, sources: ["s.md"] }),
      pageOf("wiki/mechanisms/m.md", { type: "mechanism", instances: ["c"] }),
      pageOf("wiki/hypotheses/h.md", { type: "hypothesis", from_domain: ALPHA, to_domain: BETA, status: "testing", updated: "2026-01-01" }),
      pageOf("wiki/index.md", {}),
    ]
    const cardMap = { pages: { "wiki/concepts/c.md": { status: "active", card_id: CARD_1 } } }
    expect(checkStructure(input(pages, { cardMap }))).toEqual([])
  })

  it("does not change its input", () => {
    const pages = [pageOf("wiki/concepts/a.md", { type: "concept" }), pageOf("wiki/concepts/b.md", { type: "concept", domain: ALPHA })]
    const snapshot = JSON.stringify(pages)
    checkStructure(input(pages))
    expect(JSON.stringify(pages)).toBe(snapshot)
  })

  it("writes short English messages", () => {
    const pages = [
      pageOf("wiki/concepts/a.md", { type: "concept" }),
      pageOf("wiki/concepts/b.md", { type: "concept", domain: "example/nowhere" }),
      pageOf("wiki/mechanisms/m.md", { type: "mechanism" }),
      pageOf("wiki/hypotheses/h.md", { type: "hypothesis", from_domain: ALPHA, to_domain: BETA, status: "draft", updated: "2020-01-01" }),
    ]
    const cardMap = {
      pages: {
        "wiki/concepts/a.md": { status: "retired", card_id: CARD_1 },
        "wiki/concepts/gone.md": { status: "active", card_id: CARD_2 },
      },
    }
    const configProblems = ["domains.yaml: could not read the file", "wiki.yaml: the file is missing"]
    for (const finding of checkStructure(input(pages, { cardMap, identity: READING, configProblems }))) {
      expect(finding.message, finding.check).not.toBe("")
      expect(finding.message.endsWith("."), finding.check).toBe(true)
      expect(finding.message.includes("\n"), finding.check).toBe(false)
      for (const sentence of finding.message.split(/(?<=\.)\s+/)) {
        expect(sentence.split(/\s+/).length, `${finding.check}: ${sentence}`).toBeLessThanOrEqual(30)
      }
    }
  })
})

describe("purity", () => {
  it("imports only pure modules, because the wiki-tool bundles this file", () => {
    const source = readFileSync(fileURLToPath(new URL("./lint-structure.ts", import.meta.url)), "utf8")
    const specifiers = [...source.matchAll(/^\s*import\s[^"']*["']([^"']+)["']/gm)].map((match) => match[1])
    expect(specifiers.length).toBeGreaterThan(0)
    for (const specifier of specifiers) {
      expect(specifier).not.toMatch(/^@\/commands\//)
      expect(specifier).not.toMatch(/tauri|@\/stores\//)
      expect(specifier).not.toMatch(/domain-index$/)
      expect(specifier).not.toMatch(/^node:/)
    }
    expect(specifiers).toContain("./domain-index-render")
  })
})
