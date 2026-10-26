/**
 * plan.test.ts - tests for the plan of a recut: reading it, checking it against the wiki, and the domain changes it
 * makes. Everything here is pure. Domains and pages are placeholders.
 */
import { describe, expect, it } from "vitest"
import { type DomainsConfig, parseDomainsYaml } from "@/lib/wiki-config/domains"
import { recutPage } from "./page-refs"
import {
  createMapper,
  findMergeCandidates,
  type MergePlan,
  parseRecutPlan,
  planDomains,
  planTitle,
  type RecutPlan,
  type RenamePlan,
  type SplitPlan,
  validateRecutPlan,
} from "./plan"

const WHITEBOARD_A = "00000000-0000-4000-8000-0000000000a1"
const WHITEBOARD_B = "00000000-0000-4000-8000-0000000000b2"

const DOMAINS_TEXT = [
  "version: 1",
  "domains:",
  "  example/alpha:",
  "    lens: hardware",
  "    description: Alpha",
  `    whiteboards: [${WHITEBOARD_A}]`,
  "  example/alpha/child:",
  "    lens: hardware",
  "    description: Alpha child",
  "  example/beta:",
  "    lens: business",
  "    description: Beta",
  `    whiteboards: [${WHITEBOARD_B}]`,
  "  example/zeta:",
  "    lens: physics",
  "    description: Zeta",
  "",
].join("\n")

const LENSES = ["business", "physics", "hardware", "ai"]

function domains(): DomainsConfig {
  const parsed = parseDomainsYaml(DOMAINS_TEXT)
  if (!parsed.ok) throw new Error("fixture domains.yaml is not valid")
  return parsed.value
}

function page(path: string, fields: Record<string, string | string[]>) {
  const lines = ["---"]
  for (const [key, value] of Object.entries(fields)) {
    lines.push(`${key}: ${Array.isArray(value) ? `[${value.join(", ")}]` : value}`)
  }
  lines.push("---", "", "Body.", "")
  return recutPage(path, lines.join("\n"))
}

const PAGES = [
  page("wiki/concepts/one.md", { type: "concept", title: "One", domain: "example/alpha" }),
  page("wiki/concepts/two.md", { type: "concept", title: "Two", domain: "example/alpha" }),
  page("wiki/entities/three.md", { type: "entity", title: "Three", domain: "example/beta", also: ["example/alpha"] }),
  page("wiki/hypotheses/idea.md", { type: "hypothesis", title: "Idea", from_domain: "example/alpha", to_domain: "example/beta" }),
  page("wiki/concepts/four.md", { type: "concept", title: "Four", domain: "example/zeta" }),
]

function check(plan: RecutPlan, pages = PAGES): string[] {
  return validateRecutPlan({ plan, domains: domains(), pages, lenses: LENSES })
}

const INTO = (domain: string) => ({ domain, lens: "ai", description: `About ${domain}` })

describe("parseRecutPlan", () => {
  it("reads the four operations", () => {
    expect(parseRecutPlan('{"op":"rename","from":"example/alpha","to":"example/gamma"}')).toEqual({
      ok: true,
      plan: { op: "rename", from: "example/alpha", to: "example/gamma" },
    })
    expect(parseRecutPlan('{"op":"move","from":"example/alpha","to":"example/x/alpha"}')).toMatchObject({ ok: true })
    const split = {
      op: "split",
      from: "example/alpha",
      into: [INTO("example/one"), INTO("example/two")],
      assignments: { "wiki/concepts/one.md": "example/one" },
    }
    expect(parseRecutPlan(JSON.stringify(split))).toEqual({ ok: true, plan: split })
    const merge = { op: "merge", from: ["example/alpha", "example/beta"], into: INTO("example/gamma") }
    expect(parseRecutPlan(JSON.stringify(merge))).toEqual({ ok: true, plan: merge })
  })

  it("names every problem of a plan that has the wrong shape", () => {
    const problems = (text: string): string[] => {
      const result = parseRecutPlan(text)
      if (result.ok) throw new Error("expected a problem")
      return result.problems
    }
    expect(problems("not json")[0]).toMatch(/not valid JSON/)
    expect(problems("[]")[0]).toMatch(/must be a JSON object/)
    expect(problems('{"op":"copy"}')[0]).toMatch(/unknown op: "copy"/)
    expect(problems('{"op":"rename","from":"a"}')).toEqual(['rename needs "to" as text'])
    expect(problems('{"op":"rename","from":"a","to":"b","extra":1}')).toEqual(["unknown key in the plan: extra"])
    expect(problems('{"op":"split","from":"a","into":[],"assignments":{}}')).toEqual(['split needs "into" with at least one domain'])
    expect(problems('{"op":"split","from":"a","into":[{"domain":"b"}],"assignments":{"p":1}}')).toEqual([
      'into[0] needs "lens" as text',
      'into[0] needs "description" as text',
      'assignments["p"] must be the name of a new domain as text',
    ])
    expect(problems('{"op":"merge","from":"a","into":{"domain":"b","lens":"ai","description":"d"}}')).toEqual(['merge needs "from" as a list of domains'])
    expect(problems('{"op":"merge","from":["a","b"]}')).toEqual(['merge needs "into" with domain, lens, and description'])
  })
})

describe("rename and move", () => {
  const rename: RenamePlan = { op: "rename", from: "example/alpha", to: "example/gamma" }

  it("rename moves child domains", () => {
    const mapper = createMapper(rename)
    expect(mapper.map("example/alpha", "wiki/x.md")).toBe("example/gamma")
    expect(mapper.map("example/alpha/child", "wiki/x.md")).toBe("example/gamma/child")
    expect(mapper.map("example/alphabet", "wiki/x.md")).toBe("example/alphabet")
    expect(mapper.map("example/beta", "wiki/x.md")).toBe("example/beta")

    const changes = planDomains(rename, domains())
    expect([...changes.renames]).toEqual([
      ["example/alpha", "example/gamma"],
      ["example/alpha/child", "example/gamma/child"],
    ])
    expect(changes.replacements.size).toBe(0)
    expect(changes.removed).toEqual(["example/alpha", "example/alpha/child"])
    expect(Object.keys(changes.next.domains)).toEqual(["example/gamma", "example/gamma/child", "example/beta", "example/zeta"])
    expect(changes.next.domains["example/gamma"]).toEqual({ lens: "hardware", description: "Alpha", whiteboards: [WHITEBOARD_A] })
    expect(check(rename)).toEqual([])
  })

  it("moves a domain below another parent with the same code", () => {
    const move: RecutPlan = { op: "move", from: "example/alpha", to: "example/zeta/alpha" }
    expect(Object.keys(planDomains(move, domains()).next.domains)).toEqual(["example/zeta/alpha", "example/zeta/alpha/child", "example/beta", "example/zeta"])
    expect(check(move)).toEqual([])
  })

  it("refuses a name that is not a domain name", () => {
    expect(check({ op: "rename", from: "example/alpha", to: "Example/Gamma" })).toEqual([
      'the new name "Example/Gamma" is not a domain name: use lowercase letters, digits, and "-", with "/" between levels',
    ])
    expect(check({ op: "rename", from: "example/alpha", to: "example//gamma" })).toHaveLength(1)
  })

  it("refuses a target that exists, also one that a child would take", () => {
    expect(check({ op: "rename", from: "example/alpha", to: "example/beta" })).toEqual(["the domain example/beta already exists"])
    expect(check({ op: "rename", from: "example/beta", to: "example/alpha/child" })).toEqual(["the domain example/alpha/child already exists"])
    // The new name is free, but the child of alpha would move onto an existing domain.
    const withChild = parseDomainsYaml(`${DOMAINS_TEXT}  example/gamma/child:\n    lens: ai\n    description: Taken\n`)
    if (!withChild.ok) throw new Error("fixture")
    expect(validateRecutPlan({ plan: rename, domains: withChild.value, pages: PAGES, lenses: LENSES })).toEqual([
      "the domain example/gamma/child already exists",
    ])
  })

  it("refuses an unknown domain, the same name, and a move into the domain itself", () => {
    expect(check({ op: "rename", from: "example/missing", to: "example/gamma" })).toEqual(["the domain example/missing is not in domains.yaml"])
    expect(check({ op: "rename", from: "example/alpha", to: "example/alpha" })).toEqual(["the new name is the old name: example/alpha"])
    expect(check({ op: "move", from: "example/alpha", to: "example/alpha/inner" })).toEqual(["cannot move example/alpha below itself (example/alpha/inner)"])
  })

  it("names the plan in the commit title", () => {
    expect(planTitle(rename)).toBe("rename example/alpha → example/gamma")
    expect(planTitle({ op: "move", from: "example/alpha", to: "example/zeta/alpha" })).toBe("move example/alpha → example/zeta/alpha")
  })
})

describe("split", () => {
  const assignments = {
    "wiki/concepts/one.md": "example/one",
    "wiki/concepts/two.md": "example/two",
    "wiki/entities/three.md": "example/one",
    "wiki/hypotheses/idea.md": "example/two",
  }
  const split: SplitPlan = { op: "split", from: "example/alpha", into: [INTO("example/one"), INTO("example/two")], assignments }

  it("split assigns pages", () => {
    expect(check(split)).toEqual([])
    const mapper = createMapper(split)
    expect(mapper.map("example/alpha", "wiki/concepts/one.md")).toBe("example/one")
    expect(mapper.map("example/alpha", "wiki/concepts/two.md")).toBe("example/two")
    expect(mapper.map("example/beta", "wiki/concepts/one.md")).toBe("example/beta")
    expect(mapper.map("example/alpha/child", "wiki/concepts/one.md")).toBe("example/alpha/child")

    const changes = planDomains(split, domains())
    expect([...changes.replacements.keys()]).toEqual(["example/alpha"])
    expect(changes.replacements.get("example/alpha")).toEqual([
      { name: "example/one", lens: "ai", description: "About example/one", whiteboards: [] },
      { name: "example/two", lens: "ai", description: "About example/two", whiteboards: [] },
    ])
    expect(changes.removed).toEqual(["example/alpha"])
    expect(Object.keys(changes.next.domains)).toEqual(["example/one", "example/two", "example/alpha/child", "example/beta", "example/zeta"])
    expect(changes.notes).toEqual([
      `The whiteboard hints of example/alpha were dropped: ${WHITEBOARD_A}. Add them to the new domains by hand if you need them.`,
      "These child domains stay as they are: example/alpha/child.",
    ])
    expect(planTitle(split)).toBe("split example/alpha → example/one+example/two")
  })

  it("rejects unassigned pages", () => {
    const { "wiki/entities/three.md": _dropped, ...partial } = assignments
    const problems = check({ ...split, assignments: partial })
    expect(problems).toEqual(["the split leaves 1 page without a new domain: wiki/entities/three.md"])
  })

  it("lists the pages that are left out, at most twenty", () => {
    const many = Array.from({ length: 23 }, (_, index) => page(`wiki/concepts/p${String(index).padStart(2, "0")}.md`, { type: "concept", domain: "example/alpha" }))
    const problems = check({ ...split, assignments: {} }, many)
    expect(problems).toHaveLength(1)
    expect(problems[0]).toMatch(/^the split leaves 23 pages without a new domain: wiki\/concepts\/p00\.md, .*wiki\/concepts\/p19\.md and 3 more$/)
  })

  it("counts a page that only lists the domain in also", () => {
    const problems = check({ ...split, assignments: { ...assignments, "wiki/entities/three.md": "example/one" } }, [
      ...PAGES,
      page("wiki/concepts/five.md", { type: "concept", domain: "example/zeta", also: ["example/alpha"] }),
    ])
    expect(problems).toEqual(["the split leaves 1 page without a new domain: wiki/concepts/five.md"])
  })

  it("refuses an assignment to a domain that is not new, and to a page that does not use the domain", () => {
    expect(check({ ...split, assignments: { ...assignments, "wiki/concepts/one.md": "example/beta" } })).toEqual([
      'the assignment of wiki/concepts/one.md names example/beta, which is not in "into"',
    ])
    expect(check({ ...split, assignments: { ...assignments, "wiki/concepts/four.md": "example/one" } })).toEqual([
      "the assignments name a page that does not use example/alpha: wiki/concepts/four.md",
    ])
  })

  it("refuses new domains that exist, that repeat, or that are not names", () => {
    expect(check({ ...split, into: [INTO("example/beta"), INTO("example/two")] })).toEqual(["the domain example/beta already exists"])
    expect(check({ ...split, into: [INTO("example/alpha"), INTO("example/two")] })).toEqual(["the domain example/alpha already exists"])
    expect(check({ ...split, into: [INTO("example/one"), INTO("example/one")] })).toEqual(["the new domain example/one is listed twice"])
    expect(check({ ...split, into: [INTO("Example One"), INTO("example/two")] })[0]).toMatch(/^the new name "Example One" is not a domain name/)
  })

  it("refuses an unknown lens and an empty description", () => {
    expect(check({ ...split, into: [{ domain: "example/one", lens: "cooking", description: "x" }, INTO("example/two")] })).toEqual([
      'the lens "cooking" of example/one is not a lens: use one of business, physics, hardware, ai',
    ])
    expect(check({ ...split, into: [{ domain: "example/one", lens: "ai", description: "  " }, INTO("example/two")] })).toEqual([
      "the description of example/one is empty",
    ])
  })

  it("refuses an unknown domain", () => {
    expect(check({ ...split, from: "example/missing" })).toEqual(["the domain example/missing is not in domains.yaml"])
  })
})

describe("merge", () => {
  const merge: MergePlan = { op: "merge", from: ["example/beta", "example/alpha"], into: INTO("example/gamma") }

  it("merges into a new domain at the place of the first merged domain in the file", () => {
    expect(check(merge)).toEqual([])
    const mapper = createMapper(merge)
    expect(mapper.map("example/alpha", "p")).toBe("example/gamma")
    expect(mapper.map("example/beta", "p")).toBe("example/gamma")
    expect(mapper.map("example/alpha/child", "p")).toBe("example/alpha/child")

    const changes = planDomains(merge, domains())
    expect([...changes.replacements.keys()]).toEqual(["example/alpha", "example/beta"])
    expect(changes.replacements.get("example/alpha")).toEqual([
      { name: "example/gamma", lens: "ai", description: "About example/gamma", whiteboards: [WHITEBOARD_A, WHITEBOARD_B] },
    ])
    expect(changes.replacements.get("example/beta")).toEqual([])
    expect(changes.removed).toEqual(["example/alpha", "example/beta"])
    expect(Object.keys(changes.next.domains)).toEqual(["example/gamma", "example/alpha/child", "example/zeta"])
    expect(changes.notes).toEqual(["These child domains stay as they are: example/alpha/child."])
    expect(planTitle(merge)).toBe("merge example/beta+example/alpha → example/gamma")
  })

  it("merges into one of the merged domains", () => {
    const plan: MergePlan = { op: "merge", from: ["example/alpha", "example/beta"], into: INTO("example/beta") }
    expect(check(plan)).toEqual([])
    const changes = planDomains(plan, domains())
    expect(changes.removed).toEqual(["example/alpha"])
    expect(Object.keys(changes.next.domains)).toEqual(["example/alpha/child", "example/beta", "example/zeta"])
    expect(changes.next.domains["example/beta"]).toEqual({ lens: "ai", description: "About example/beta", whiteboards: [WHITEBOARD_A, WHITEBOARD_B] })
    expect(createMapper(plan).map("example/beta", "p")).toBe("example/beta")
  })

  it("merges into an existing domain that is not merged", () => {
    const plan: MergePlan = { op: "merge", from: ["example/alpha", "example/beta"], into: INTO("example/zeta") }
    expect(check(plan)).toEqual([])
    const changes = planDomains(plan, domains())
    expect(changes.removed).toEqual(["example/alpha", "example/beta"])
    expect(Object.keys(changes.next.domains)).toEqual(["example/alpha/child", "example/zeta"])
    expect(changes.next.domains["example/zeta"].whiteboards).toEqual([WHITEBOARD_A, WHITEBOARD_B])
  })

  it("refuses fewer than two domains, a repeat, and an unknown domain", () => {
    expect(check({ ...merge, from: ["example/alpha"] })).toEqual(["a merge needs at least two domains in \"from\""])
    expect(check({ ...merge, from: ["example/alpha", "example/alpha"] })).toEqual(["the domain example/alpha is listed twice in \"from\""])
    expect(check({ ...merge, from: ["example/alpha", "example/missing"] })).toEqual(["the domain example/missing is not in domains.yaml"])
    expect(check({ ...merge, into: INTO("Not A Name") })[0]).toMatch(/^the new name "Not A Name" is not a domain name/)
  })

  it("merge reports same-slug pairs", () => {
    const pages = [
      page("wiki/concepts/restock.md", { type: "concept", domain: "example/alpha" }),
      page("wiki/concepts/restock-too.md", { type: "concept", domain: "example/alpha" }),
      page("wiki/entities/restock.md", { type: "entity", domain: "example/beta" }),
      page("wiki/concepts/other.md", { type: "concept", domain: "example/beta" }),
      page("wiki/concepts/restock2.md", { type: "concept", domain: "example/zeta" }),
      // A hypothesis counts under its to_domain.
      page("wiki/hypotheses/shared.md", { type: "hypothesis", from_domain: "example/zeta", to_domain: "example/alpha" }),
      page("wiki/hypotheses/other-folder/shared.md", { type: "hypothesis", from_domain: "example/zeta", to_domain: "example/beta" }),
      // The same slug in the same domain is not a pair that the merge brings together.
      page("wiki/concepts/twin.md", { type: "concept", domain: "example/alpha" }),
      page("wiki/entities/twin.md", { type: "entity", domain: "example/alpha" }),
      // A domain outside the merge.
      page("wiki/concepts/shared.md", { type: "concept", domain: "example/zeta" }),
    ]
    expect(findMergeCandidates(merge, pages)).toEqual([
      { a: "wiki/concepts/restock.md", b: "wiki/entities/restock.md" },
      { a: "wiki/hypotheses/other-folder/shared.md", b: "wiki/hypotheses/shared.md" },
    ])
  })

  it("counts the pages of an existing target as well", () => {
    const plan: MergePlan = { op: "merge", from: ["example/alpha", "example/beta"], into: INTO("example/zeta") }
    const pages = [
      page("wiki/concepts/x.md", { type: "concept", domain: "example/alpha" }),
      page("wiki/entities/x.md", { type: "entity", domain: "example/zeta" }),
    ]
    expect(findMergeCandidates(plan, pages)).toEqual([{ a: "wiki/concepts/x.md", b: "wiki/entities/x.md" }])
  })

  it("lists every pair of three pages with one slug", () => {
    const pages = [
      page("wiki/concepts/x.md", { type: "concept", domain: "example/alpha" }),
      page("wiki/entities/x.md", { type: "entity", domain: "example/beta" }),
      page("wiki/queries/x.md", { type: "query", domain: "example/zeta" }),
    ]
    const plan: MergePlan = { op: "merge", from: ["example/alpha", "example/beta", "example/zeta"], into: INTO("example/gamma") }
    expect(findMergeCandidates(plan, pages)).toEqual([
      { a: "wiki/concepts/x.md", b: "wiki/entities/x.md" },
      { a: "wiki/concepts/x.md", b: "wiki/queries/x.md" },
      { a: "wiki/entities/x.md", b: "wiki/queries/x.md" },
    ])
  })

  it("has no candidates for a plan that is not a merge", () => {
    expect(findMergeCandidates({ op: "rename", from: "example/alpha", to: "example/gamma" }, PAGES)).toEqual([])
  })
})
