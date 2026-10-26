/**
 * page-edits.test.ts - tests for the edits that a recut makes to the pages: the domain keys of the frontmatter
 * (rulings U3) and the Known instances lines of mechanism pages (ruling U4). Pure: the text goes in and comes out.
 * Domains and slugs are placeholders.
 */
import { describe, expect, it } from "vitest"
import { computePageEdits, findLeftoverRefs, type PageSource } from "./page-edits"
import { recutPage } from "./page-refs"
import type { RecutPlan, SplitPlan } from "./plan"

function source(path: string, text: string): PageSource {
  return { page: recutPage(path, text.replace(/^\uFEFF/, "")), text }
}

const rename: RecutPlan = { op: "rename", from: "example/alpha", to: "example/gamma" }
const INTO = (domain: string) => ({ domain, lens: "ai", description: `About ${domain}` })

describe("computePageEdits: rename and merge", () => {
  it("rewrites domain, also, from_domain, and to_domain, and leaves the other pages out", () => {
    const concept = "---\ntype: concept\ntitle: One\ndomain: example/alpha\nalso: [example/alpha/child, example/beta]\n---\n\nBody.\n"
    const hypothesis = "---\ntype: hypothesis\nfrom_domain: example/alpha\nto_domain: example/beta\nstatus: draft\n---\n\nBody.\n"
    const other = "---\ntype: concept\ndomain: example/beta\n---\n\nBody.\n"
    const result = computePageEdits(rename, [
      source("wiki/concepts/one.md", concept),
      source("wiki/hypotheses/idea.md", hypothesis),
      source("wiki/concepts/other.md", other),
    ])
    expect(result.problems).toEqual([])
    expect(result.edits).toEqual([
      {
        path: "wiki/concepts/one.md",
        before: concept,
        after: "---\ntype: concept\ntitle: One\ndomain: example/gamma\nalso: [example/gamma/child, example/beta]\n---\n\nBody.\n",
      },
      {
        path: "wiki/hypotheses/idea.md",
        before: hypothesis,
        after: "---\ntype: hypothesis\nfrom_domain: example/gamma\nto_domain: example/beta\nstatus: draft\n---\n\nBody.\n",
      },
    ])
  })

  it("does not read from_domain and to_domain on a page that is no hypothesis", () => {
    const text = "---\ntype: concept\ndomain: example/beta\nto_domain: example/alpha\n---\n\nBody.\n"
    expect(computePageEdits(rename, [source("wiki/concepts/x.md", text)]).edits).toEqual([])
  })

  it("rewrites the instance lines of a mechanism page, and counts the page as changed", () => {
    const text = "---\ntype: mechanism\ntitle: M\n---\n\n## Known instances\n- [[a]] (example/alpha): t\n- [[b]] (example/beta): u\n"
    const result = computePageEdits(rename, [source("wiki/mechanisms/m.md", text)])
    expect(result.edits).toEqual([
      { path: "wiki/mechanisms/m.md", before: text, after: text.replace("(example/alpha)", "(example/gamma)") },
    ])
    expect(result.notes).toEqual([])
  })

  it("does not read instance lines on a page that is no mechanism", () => {
    const text = "---\ntype: concept\ndomain: example/beta\n---\n\n## Known instances\n- [[a]] (example/alpha): t\n"
    expect(computePageEdits(rename, [source("wiki/concepts/x.md", text)]).edits).toEqual([])
  })

  it("keeps a byte order mark and the bytes of the body", () => {
    const text = "\uFEFF---\r\ndomain: example/alpha\r\n---\r\nBody  \r\n\r\n- [[x]] (example/alpha)\r\n"
    const result = computePageEdits(rename, [source("wiki/concepts/x.md", text)])
    expect(result.edits[0].after).toBe("\uFEFF---\r\ndomain: example/gamma\r\n---\r\nBody  \r\n\r\n- [[x]] (example/alpha)\r\n")
  })

  const merge: RecutPlan = { op: "merge", from: ["example/alpha", "example/beta"], into: INTO("example/beta") }

  it("drops an also item that now repeats the domain of the page or an earlier item", () => {
    const pages = [
      source("wiki/concepts/a.md", "---\ndomain: example/beta\nalso: [example/alpha, example/zeta]\n---\nB\n"),
      source("wiki/concepts/b.md", "---\ndomain: example/zeta\nalso: [example/alpha, example/beta, example/alpha]\n---\nB\n"),
      source("wiki/concepts/c.md", "---\ndomain: example/alpha\nalso:\n  - example/beta\n  - example/zeta\n---\nB\n"),
    ]
    const result = computePageEdits(merge, pages)
    expect(result.problems).toEqual([])
    expect(result.edits.map((edit) => edit.after)).toEqual([
      "---\ndomain: example/beta\nalso: [example/zeta]\n---\nB\n",
      "---\ndomain: example/zeta\nalso: [example/beta]\n---\nB\n",
      "---\ndomain: example/beta\nalso:\n  - example/zeta\n---\nB\n",
    ])
  })

  it("does not tidy a list that the recut did not touch", () => {
    const text = "---\ndomain: example/zeta\nalso: [example/zeta, example/zeta, example/gamma]\n---\nB\n"
    expect(computePageEdits(rename, [source("wiki/concepts/a.md", text)]).edits).toEqual([])
  })

  it("names a page whose frontmatter it cannot edit, and still edits the others", () => {
    const bad = "---\ndomain: |\n  example/alpha\n---\nB\n"
    const good = "---\ndomain: example/alpha\n---\nB\n"
    const result = computePageEdits(rename, [source("wiki/concepts/bad.md", bad), source("wiki/concepts/good.md", good)])
    expect(result.problems).toEqual([expect.stringMatching(/^wiki\/concepts\/bad\.md: domain /)])
    expect(result.edits.map((edit) => edit.path)).toEqual(["wiki/concepts/good.md"])
  })
})

describe("computePageEdits: split", () => {
  const split: SplitPlan = {
    op: "split",
    from: "example/alpha",
    into: [INTO("example/one"), INTO("example/two")],
    assignments: {
      "wiki/concepts/one.md": "example/one",
      "wiki/entities/two.md": "example/two",
      "wiki/hypotheses/idea.md": "example/two",
      "wiki/concepts/outside.md": "example/one",
    },
  }

  it("uses the assignment of each page, also for a hypothesis, and for a page that lists the domain in also", () => {
    const pages = [
      source("wiki/concepts/one.md", "---\ndomain: example/alpha\n---\nB\n"),
      source("wiki/entities/two.md", "---\ndomain: example/alpha\nalso: [example/beta]\n---\nB\n"),
      source("wiki/hypotheses/idea.md", "---\ntype: hypothesis\nfrom_domain: example/beta\nto_domain: example/alpha\n---\nB\n"),
      source("wiki/concepts/outside.md", "---\ndomain: example/beta\nalso: [example/alpha, example/zeta]\n---\nB\n"),
      source("wiki/concepts/untouched.md", "---\ndomain: example/beta\nalso: [example/alpha/child]\n---\nB\n"),
    ]
    const result = computePageEdits(split, pages)
    expect(result.problems).toEqual([])
    expect(result.edits.map((edit) => [edit.path, edit.after])).toEqual([
      ["wiki/concepts/one.md", "---\ndomain: example/one\n---\nB\n"],
      ["wiki/entities/two.md", "---\ndomain: example/two\nalso: [example/beta]\n---\nB\n"],
      ["wiki/hypotheses/idea.md", "---\ntype: hypothesis\nfrom_domain: example/beta\nto_domain: example/two\n---\nB\n"],
      ["wiki/concepts/outside.md", "---\ndomain: example/beta\nalso: [example/one, example/zeta]\n---\nB\n"],
    ])
  })

  it("changes only the hypothesis key that names the split domain", () => {
    const both = "---\ntype: hypothesis\nfrom_domain: example/alpha\nto_domain: example/alpha\n---\nB\n"
    const edits = computePageEdits({ ...split, assignments: { "wiki/hypotheses/idea.md": "example/two" } }, [source("wiki/hypotheses/idea.md", both)])
    expect(edits.edits[0].after).toBe("---\ntype: hypothesis\nfrom_domain: example/two\nto_domain: example/two\n---\nB\n")
  })

  it("gives an instance line the domain that its instance page was assigned", () => {
    const mechanism = "---\ntype: mechanism\n---\n\n## Known instances\n- [[one]] (example/alpha): t\n- [[two]] (example/alpha): u\n- [[far-away]] (example/beta): v\n"
    const result = computePageEdits(split, [
      source("wiki/mechanisms/m.md", mechanism),
      source("wiki/concepts/one.md", "---\ndomain: example/alpha\n---\nB\n"),
      source("wiki/entities/two.md", "---\ndomain: example/alpha\n---\nB\n"),
    ])
    expect(result.edits.find((edit) => edit.path === "wiki/mechanisms/m.md")?.after).toBe(
      mechanism.replace("[[one]] (example/alpha)", "[[one]] (example/one)").replace("[[two]] (example/alpha)", "[[two]] (example/two)"),
    )
    expect(result.notes).toEqual([])
  })

  it("leaves an instance line alone when no page with the slug was assigned, and says so", () => {
    const mechanism = "---\ntype: mechanism\n---\n\n## Known instances\n- [[gone]] (example/alpha): t\n"
    const result = computePageEdits(split, [source("wiki/mechanisms/m.md", mechanism)])
    expect(result.edits).toEqual([])
    expect(result.notes).toEqual([
      "wiki/mechanisms/m.md: the instance line [[gone]] (example/alpha) stays as it is, because no page with this slug was assigned.",
    ])
  })

  it("leaves an instance line alone when the slug was assigned to two different domains", () => {
    const mechanism = "---\ntype: mechanism\n---\n\n## Known instances\n- [[twin]] (example/alpha): t\n"
    const plan: SplitPlan = { ...split, assignments: { "wiki/concepts/twin.md": "example/one", "wiki/entities/twin.md": "example/two" } }
    const result = computePageEdits(plan, [
      source("wiki/mechanisms/m.md", mechanism),
      source("wiki/concepts/twin.md", "---\ndomain: example/alpha\n---\nB\n"),
      source("wiki/entities/twin.md", "---\ndomain: example/alpha\n---\nB\n"),
    ])
    expect(result.edits.map((edit) => edit.path)).toEqual(["wiki/concepts/twin.md", "wiki/entities/twin.md"])
    expect(result.notes).toHaveLength(1)
    expect(result.notes[0]).toContain("[[twin]] (example/alpha)")
  })
})

describe("findLeftoverRefs", () => {
  const REMOVED = ["example/alpha", "example/alpha/child"]
  const leftovers = (plan: RecutPlan, pages: PageSource[], removed: readonly string[] = REMOVED): string[] =>
    findLeftoverRefs(pages, computePageEdits(plan, pages), removed)

  it("is empty when every reference was rewritten", () => {
    const pages = [
      source("wiki/concepts/a.md", "---\ndomain: example/alpha\nalso: [example/alpha/child]\n---\nB\n"),
      source("wiki/mechanisms/m.md", "---\ntype: mechanism\n---\n\n## Known instances\n- [[a]] (example/alpha): t\n"),
    ]
    expect(leftovers(rename, pages)).toEqual([])
  })

  it("names a page whose frontmatter the edit could not reach, and the key", () => {
    const indented = source("wiki/concepts/indented.md", "---\n  type: concept\n  domain: example/alpha\n---\nB\n")
    const flow = source("wiki/concepts/flow.md", "---\n{type: concept, also: [example/alpha]}\n---\nB\n")
    expect(leftovers(rename, [indented, flow])).toEqual([
      expect.stringMatching(/^wiki\/concepts\/indented\.md: domain still names example\/alpha, which the recut removes/),
      expect.stringMatching(/^wiki\/concepts\/flow\.md: also still names example\/alpha, which the recut removes/),
    ])
  })

  it("names from_domain and to_domain of a hypothesis page", () => {
    const hypothesis = source("wiki/hypotheses/h.md", "---\n  type: hypothesis\n  from_domain: example/alpha\n  to_domain: example/alpha/child\n---\nB\n")
    expect(leftovers(rename, [hypothesis]).map((problem) => problem.split(" still")[0])).toEqual([
      "wiki/hypotheses/h.md: to_domain",
      "wiki/hypotheses/h.md: from_domain",
    ])
  })

  it("counts a page that the edit left as it was", () => {
    const untouched = source("wiki/concepts/a.md", "---\ndomain: example/beta\n---\nB\n")
    expect(leftovers(rename, [untouched])).toEqual([])
    // The same page with a removed domain and no edit (the edit step was skipped).
    const stale = source("wiki/concepts/b.md", "---\ndomain: example/alpha\n---\nB\n")
    expect(findLeftoverRefs([stale], { edits: [], problems: [], notes: [], unresolved: [] }, REMOVED)).toHaveLength(1)
  })

  it("names an instance line that still names a removed domain", () => {
    const mechanism = source("wiki/mechanisms/m.md", "---\ntype: mechanism\n---\n\n## Known instances\n- [[a]] (example/alpha): t\n")
    const problems = findLeftoverRefs([mechanism], { edits: [], problems: [], notes: [], unresolved: [] }, REMOVED)
    expect(problems).toEqual([expect.stringMatching(/^wiki\/mechanisms\/m\.md: the Known instances line \[\[a\]\] still names example\/alpha/)])
  })

  it("does not count an instance line that a split could not assign, because a note names it", () => {
    const split: SplitPlan = { op: "split", from: "example/alpha", into: [INTO("example/one"), INTO("example/two")], assignments: {} }
    const mechanism = source("wiki/mechanisms/m.md", "---\ntype: mechanism\n---\n\n## Known instances\n- [[gone]] (example/alpha): t\n")
    expect(leftovers(split, [mechanism], ["example/alpha"])).toEqual([])
  })
})
