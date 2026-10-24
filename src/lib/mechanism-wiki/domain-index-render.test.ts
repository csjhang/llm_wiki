import { describe, expect, it } from "vitest"
import type { DomainsConfig } from "@/lib/wiki-config/domains"
import {
  compareText,
  domainIndexPath,
  indexedPageFromMarkdown,
  isDomainIndexPath,
  renderDomainIndex,
  renderMechanismIndex,
  renderRootIndex,
} from "./domain-index-render"
import type { IndexedPage } from "./domain-index-render"

const DOMAINS: DomainsConfig = {
  version: 1,
  domains: {
    "hardware/async-circuits": { lens: "hardware", description: "Circuits without a clock", whiteboards: [] },
    "ai/architecture": { lens: "ai", description: "Neural network designs", whiteboards: [] },
  },
}

function page(overrides: Partial<IndexedPage> & { slug: string }): IndexedPage {
  const type = overrides.type ?? "concept"
  return {
    path: `wiki/${type}s/${overrides.slug}.md`,
    type,
    title: overrides.slug,
    domain: null,
    ...overrides,
  }
}

describe("renderRootIndex", () => {
  it("renders root index with counts", () => {
    const pages = [
      page({ slug: "handshake", domain: "hardware/async-circuits" }),
      page({ slug: "bundled-data", type: "entity", domain: "hardware/async-circuits" }),
      page({ slug: "spikes", domain: "ai/architecture" }),
      page({ slug: "event-driven-computing", type: "mechanism" }),
      page({ slug: "backpressure", type: "mechanism" }),
      page({ slug: "loose" }),
    ]

    expect(renderRootIndex(pages, DOMAINS)).toBe(
      [
        "# Wiki Index",
        "",
        "- [ai/architecture](indexes/ai--architecture.md) — 1 pages",
        "- [hardware/async-circuits](indexes/hardware--async-circuits.md) — 2 pages",
        "- [Mechanisms](indexes/_mechanisms.md) — 2 pages",
        "- Unassigned — 1 pages",
        "  - [[loose]]",
        "",
      ].join("\n"),
    )
  })

  it("lists every domain of domains.yaml, also one without pages, sorted by path", () => {
    const text = renderRootIndex([], DOMAINS)

    expect(text).toBe(
      [
        "# Wiki Index",
        "",
        "- [ai/architecture](indexes/ai--architecture.md) — 0 pages",
        "- [hardware/async-circuits](indexes/hardware--async-circuits.md) — 0 pages",
        "- [Mechanisms](indexes/_mechanisms.md) — 0 pages",
        "- Unassigned — 0 pages",
        "",
      ].join("\n"),
    )
  })

  it("unassigned pages are listed", () => {
    const pages = [
      page({ slug: "no-domain" }),
      page({ slug: "unknown-domain", domain: "cognition/attention" }),
      // A type outside the seven goes to the list too, with its type.
      page({ slug: "odd-type", type: "synthesis", domain: "ai/architecture" }),
      page({ slug: "typeless", type: "", domain: "ai/architecture" }),
      page({ slug: "listed", domain: "ai/architecture" }),
    ]

    const text = renderRootIndex(pages, DOMAINS)

    expect(text).toContain("- [ai/architecture](indexes/ai--architecture.md) — 1 pages")
    expect(text).toContain("- Unassigned — 4 pages")
    const unassigned = text.slice(text.indexOf("- Unassigned"))
    expect(unassigned).toBe(
      [
        "- Unassigned — 4 pages",
        "  - [[no-domain]]",
        "  - [[odd-type]] (synthesis)",
        "  - [[typeless]] (no type)",
        "  - [[unknown-domain]]",
        "",
      ].join("\n"),
    )
  })

  it("does not treat an inherited object key as a listed domain", () => {
    const text = renderRootIndex([page({ slug: "p", domain: "constructor" })], DOMAINS)

    expect(text).toContain("- Unassigned — 1 pages")
    expect(text).toContain("  - [[p]]")
  })
})

describe("renderDomainIndex", () => {
  it("groups domain index by type in fixed order", () => {
    const d = "hardware/async-circuits"
    const pages = [
      page({ slug: "h1", type: "hypothesis", domain: d }),
      page({ slug: "q1", type: "query", domain: d }),
      page({ slug: "cmp", type: "comparison", domain: d }),
      page({ slug: "c-b", type: "concept", domain: d, title: "Beta" }),
      page({ slug: "c-a", type: "concept", domain: d, title: "alpha" }),
      page({ slug: "e1", type: "entity", domain: d, title: "Entity one" }),
      page({ slug: "s1", type: "source", domain: d, title: "Source one" }),
      // Not in this domain, and a mechanism: both stay out.
      page({ slug: "other", type: "concept", domain: "ai/architecture" }),
      page({ slug: "mech", type: "mechanism", domain: d }),
    ]

    expect(renderDomainIndex(d, pages)).toBe(
      [
        "# hardware/async-circuits",
        "",
        "## Source",
        "",
        "- [[s1]] — Source one",
        "",
        "## Entity",
        "",
        "- [[e1]] — Entity one",
        "",
        "## Concept",
        "",
        "- [[c-a]] — alpha",
        "- [[c-b]] — Beta",
        "",
        "## Comparison",
        "",
        "- [[cmp]] — cmp",
        "",
        "## Query",
        "",
        "- [[q1]] — q1",
        "",
        "## Hypothesis",
        "",
        "- [[h1]] — h1",
        "",
      ].join("\n"),
    )
  })

  it("is only a heading for a domain without pages", () => {
    expect(renderDomainIndex("ai/architecture", [])).toBe("# ai/architecture\n")
  })

  it("leaves out a page whose type is not one of the six", () => {
    const text = renderDomainIndex("ai/architecture", [page({ slug: "odd", type: "synthesis", domain: "ai/architecture" })])

    expect(text).toBe("# ai/architecture\n")
  })

  it("sorts pages with the same title by slug", () => {
    const d = "ai/architecture"
    const text = renderDomainIndex(d, [
      page({ slug: "b", domain: d, title: "Same" }),
      page({ slug: "a", domain: d, title: "Same" }),
    ])

    expect(text.indexOf("[[a]]")).toBeLessThan(text.indexOf("[[b]]"))
  })
})

describe("renderMechanismIndex", () => {
  it("lists one line per mechanism page, sorted by title", () => {
    const pages = [
      page({ slug: "event-driven-computing", type: "mechanism", title: "Event-driven computing" }),
      page({ slug: "backpressure", type: "mechanism", title: "Backpressure" }),
      page({ slug: "a-concept", type: "concept", domain: "ai/architecture" }),
    ]

    expect(renderMechanismIndex(pages)).toBe(
      [
        "# Mechanisms",
        "",
        "- [[backpressure]] — Backpressure",
        "- [[event-driven-computing]] — Event-driven computing",
        "",
      ].join("\n"),
    )
  })

  it("is only a heading without mechanism pages", () => {
    expect(renderMechanismIndex([])).toBe("# Mechanisms\n")
  })
})

describe("domainIndexPath", () => {
  it("index path replaces slashes", () => {
    expect(domainIndexPath("hardware/async-circuits")).toBe("wiki/indexes/hardware--async-circuits.md")
    expect(domainIndexPath("ai")).toBe("wiki/indexes/ai.md")
    expect(domainIndexPath("a/b/c")).toBe("wiki/indexes/a--b--c.md")
  })
})

describe("isDomainIndexPath", () => {
  it("is true for the files under wiki/indexes/ only", () => {
    expect(isDomainIndexPath("wiki/indexes/_mechanisms.md")).toBe(true)
    expect(isDomainIndexPath("wiki\\Indexes\\ai.md")).toBe(true)
    expect(isDomainIndexPath("wiki/index.md")).toBe(false)
    expect(isDomainIndexPath("wiki/concepts/indexes/x.md")).toBe(false)
  })
})

describe("deterministic output", () => {
  it("gives the same bytes for the same pages in any order", () => {
    const pages = [
      page({ slug: "c1", domain: "ai/architecture", title: "Zeta" }),
      page({ slug: "c2", domain: "ai/architecture", title: "Alpha" }),
      page({ slug: "c3", type: "entity", domain: "hardware/async-circuits" }),
      page({ slug: "m1", type: "mechanism", title: "Beta" }),
      page({ slug: "u1" }),
      page({ slug: "u2", type: "synthesis" }),
    ]
    const reversed = [...pages].reverse()

    expect(renderRootIndex(reversed, DOMAINS)).toBe(renderRootIndex(pages, DOMAINS))
    expect(renderDomainIndex("ai/architecture", reversed)).toBe(renderDomainIndex("ai/architecture", pages))
    expect(renderMechanismIndex(reversed)).toBe(renderMechanismIndex(pages))
    expect(renderRootIndex(pages, DOMAINS)).toBe(renderRootIndex(pages, DOMAINS))
  })
})

describe("order of titles", () => {
  const d = "ai/architecture"

  it("sorts by UTF-16 code units, lower case first, then the exact title, then the slug", () => {
    const titles = ["事件驅動", "Zebra", "apple", "あ", "Apple", "事件", "Ärger", "banana", "Banana"]
    const pages = titles.map((title, i) => page({ slug: `p${i}`, domain: d, title }))
    const expected = ["Apple", "apple", "Banana", "banana", "Zebra", "Ärger", "あ", "事件", "事件驅動"]

    const lines = (list: IndexedPage[]) =>
      renderDomainIndex(d, list)
        .split("\n")
        .filter((line) => line.startsWith("- "))
        .map((line) => line.slice(line.indexOf(" — ") + " — ".length))

    expect(lines(pages)).toEqual(expected)
    // The order does not depend on the order of the input.
    expect(lines([...pages].reverse())).toEqual(expected)
    expect(renderDomainIndex(d, [...pages].reverse())).toBe(renderDomainIndex(d, pages))
  })

  it("compares text by code units, not by locale", () => {
    expect(compareText("Z", "a")).toBeLessThan(0)
    expect(compareText("a", "ä")).toBeLessThan(0)
    expect(compareText("z", "あ")).toBeLessThan(0)
    expect(compareText("a", "a")).toBe(0)
  })
})

describe("renderRootIndex with a limit on the unassigned list", () => {
  const pages = ["a", "b", "c", "d", "e"].map((slug) => page({ slug }))

  it("lists all unassigned pages when there is no limit", () => {
    const text = renderRootIndex(pages, DOMAINS)

    expect(text).toContain("- Unassigned — 5 pages")
    for (const slug of ["a", "b", "c", "d", "e"]) expect(text).toContain(`  - [[${slug}]]`)
    expect(text).not.toContain("more unassigned")
  })

  it("cuts the list at the limit and says how many pages it left out", () => {
    const text = renderRootIndex(pages, DOMAINS, { maxUnassigned: 3 })

    // The count stays complete. Only the lines are cut.
    expect(text).toContain("- Unassigned — 5 pages\n  - [[a]]\n  - [[b]]\n  - [[c]]\n  - … 2 more unassigned pages\n")
    expect(text).not.toContain("[[d]]")
  })

  it("adds no extra line when the list fits the limit", () => {
    expect(renderRootIndex(pages, DOMAINS, { maxUnassigned: 5 })).toBe(renderRootIndex(pages, DOMAINS))
  })
})

describe("indexedPageFromMarkdown", () => {
  it("reads slug, type, title, and domain from the frontmatter", () => {
    const markdown = [
      "---",
      "type: concept",
      "title: Handshake protocol",
      "domain: hardware/async-circuits",
      "---",
      "",
      "# Another heading",
    ].join("\n")

    expect(indexedPageFromMarkdown("wiki/concepts/handshake.md", markdown)).toEqual({
      path: "wiki/concepts/handshake.md",
      slug: "handshake",
      type: "concept",
      title: "Handshake protocol",
      domain: "hardware/async-circuits",
    })
  })

  it("falls back to the first heading, then to the slug, for the title", () => {
    expect(indexedPageFromMarkdown("wiki/concepts/a.md", "---\ntype: concept\n---\n\nIntro\n\n# From heading\n").title).toBe(
      "From heading",
    )
    expect(indexedPageFromMarkdown("wiki/concepts/a.md", "---\ntype: concept\ntitle: \"  \"\n---\n\n# From heading\n").title).toBe(
      "From heading",
    )
    expect(indexedPageFromMarkdown("wiki/concepts/a-slug.md", "No heading here").title).toBe("a-slug")
  })

  it("puts a title on one line", () => {
    const markdown = "---\ntype: concept\ntitle: |\n  Two\n  lines\n---\n"

    expect(indexedPageFromMarkdown("wiki/concepts/a.md", markdown).title).toBe("Two lines")
  })

  it("infers the type from the folder when the frontmatter has none", () => {
    expect(indexedPageFromMarkdown("wiki/entities/x.md", "# X").type).toBe("entity")
    expect(indexedPageFromMarkdown("wiki/mechanisms/x.md", "# X").type).toBe("mechanism")
    expect(indexedPageFromMarkdown("wiki/hypotheses/x.md", "# X").type).toBe("hypothesis")
    expect(indexedPageFromMarkdown("wiki/sources/x.md", "---\ntype: concept\n---\n").type).toBe("concept")
    // No folder and no frontmatter type: the page has no type.
    expect(indexedPageFromMarkdown("wiki/x.md", "# X").type).toBe("")
  })

  it("has no domain when the frontmatter has none or a non-text one", () => {
    expect(indexedPageFromMarkdown("wiki/concepts/x.md", "# X").domain).toBeNull()
    expect(indexedPageFromMarkdown("wiki/concepts/x.md", "---\ndomain: [a, b]\n---\n").domain).toBeNull()
    expect(indexedPageFromMarkdown("wiki/concepts/x.md", "---\ndomain: \"\"\n---\n").domain).toBeNull()
  })

  it("handles a Windows path", () => {
    const result = indexedPageFromMarkdown("wiki\\concepts\\x.md", "# X")

    expect(result.path).toBe("wiki/concepts/x.md")
    expect(result.slug).toBe("x")
    expect(result.type).toBe("concept")
  })

  it("hypothesis pages are indexed under to_domain", () => {
    const markdown = [
      "---",
      "type: hypothesis",
      "title: Handshakes are backpressure",
      "from_domain: hardware/async-circuits",
      "to_domain: ai/architecture",
      "---",
      "",
      "# Handshakes are backpressure",
    ].join("\n")

    const hypothesis = indexedPageFromMarkdown("wiki/hypotheses/handshake-backpressure.md", markdown)

    expect(hypothesis.domain).toBe("ai/architecture")
    expect(renderDomainIndex("ai/architecture", [hypothesis])).toContain("## Hypothesis\n\n- [[handshake-backpressure]] — Handshakes are backpressure")
    expect(renderDomainIndex("hardware/async-circuits", [hypothesis])).toBe("# hardware/async-circuits\n")
    expect(renderRootIndex([hypothesis], DOMAINS)).toContain("- [ai/architecture](indexes/ai--architecture.md) — 1 pages")
    // A hypothesis without to_domain has no domain, even when it carries a domain line.
    const stray = indexedPageFromMarkdown(
      "wiki/hypotheses/stray.md",
      "---\ntype: hypothesis\ndomain: ai/architecture\n---\n",
    )
    expect(stray.domain).toBeNull()
  })
})
