/**
 * pages.test.ts - tests for `wiki-tool recut pages`: the pages that a recut of one domain concerns, as input for
 * the assignment of a split. Domains, slugs, and titles are placeholders.
 */
import { afterEach, describe, expect, it } from "vitest"
import { removeProjects } from "../test-project"
import { ALPHA, BETA, CHILD, makeRecutRepo, runRecut, status, ZETA } from "./recut-fixture"

afterEach(removeProjects)

interface PagesOutput {
  ok: boolean
  pages?: Array<{ path: string; title: string; type: string; key: string; excerpt: string }>
  problems?: string[]
}

function pagesOf(project: string, domain: string) {
  return runRecut<PagesOutput>("pages", project, "--domain", domain)
}

function page(fields: Record<string, string>, body: string): string {
  return `---\n${Object.entries(fields).map(([key, value]) => `${key}: ${value}`).join("\n")}\n---\n${body}`
}

describe("recut pages", () => {
  it("lists the pages of a domain with title, type, key, and the start of the body", async () => {
    const project = makeRecutRepo()
    const result = await pagesOf(project, ALPHA)
    expect(result.exitCode).toBe(0)
    expect(result.output.pages).toEqual([
      { path: "wiki/concepts/one.md", title: "One: a placeholder", type: "concept", key: "domain", excerpt: "# One\n\nBody with trailing spaces.  \n" },
      // The entity lists alpha in `also`; the hypothesis starts in alpha.
      { path: "wiki/entities/three.md", title: "Three", type: "entity", key: "also", excerpt: "# Three\n" },
      { path: "wiki/hypotheses/idea.md", title: "Idea", type: "hypothesis", key: "from_domain", excerpt: "# Idea\n" },
    ])
  })

  it("names the key of a hypothesis page for each side", async () => {
    const project = makeRecutRepo()
    const beta = await pagesOf(project, BETA)
    expect(beta.output.pages?.map((entry) => [entry.path, entry.key])).toEqual([
      ["wiki/entities/three.md", "domain"],
      ["wiki/hypotheses/idea.md", "to_domain"],
    ])
  })

  it("does not list the pages of a child domain, nor a mechanism page", async () => {
    const project = makeRecutRepo()
    expect((await pagesOf(project, CHILD)).output.pages?.map((entry) => entry.path)).toEqual(["wiki/concepts/two.md"])
    expect((await pagesOf(project, ZETA)).output.pages?.map((entry) => entry.path)).toEqual(["wiki/concepts/four.md"])
  })

  it("lists a page once for each key that names the domain", async () => {
    const project = makeRecutRepo({
      "wiki/concepts/both.md": page({ type: "concept", title: "Both", domain: ALPHA, also: `[${ALPHA}]` }, "Text.\n"),
      "wiki/hypotheses/loop.md": page({ type: "hypothesis", title: "Loop", from_domain: ALPHA, to_domain: ALPHA }, "Text.\n"),
    })
    const result = await pagesOf(project, ALPHA)
    expect(result.output.pages?.map((entry) => [entry.path, entry.key])).toEqual([
      ["wiki/concepts/both.md", "domain"],
      ["wiki/concepts/both.md", "also"],
      ["wiki/concepts/one.md", "domain"],
      ["wiki/entities/three.md", "also"],
      ["wiki/hypotheses/idea.md", "from_domain"],
      ["wiki/hypotheses/loop.md", "to_domain"],
      ["wiki/hypotheses/loop.md", "from_domain"],
    ])
  })

  it("cuts the excerpt at 300 characters, after the frontmatter, without cutting a character in two", async () => {
    const long = `${"x".repeat(299)}😀${"y".repeat(50)}`
    const project = makeRecutRepo({
      "wiki/concepts/long.md": page({ type: "concept", title: "Long", domain: ALPHA }, `\n\n${long}\n`),
      "wiki/concepts/exact.md": page({ type: "concept", title: "Exact", domain: ALPHA }, "z".repeat(300)),
      "wiki/concepts/plain.md": "No frontmatter here.\n",
    })
    const entries = (await pagesOf(project, ALPHA)).output.pages ?? []
    const byPath = (path: string) => entries.find((entry) => entry.path === path)
    expect(byPath("wiki/concepts/long.md")?.excerpt).toBe(`${"x".repeat(299)}😀`)
    expect(Array.from(byPath("wiki/concepts/long.md")?.excerpt ?? "")).toHaveLength(300)
    expect(byPath("wiki/concepts/exact.md")?.excerpt).toBe("z".repeat(300))
    expect(byPath("wiki/concepts/plain.md")).toBeUndefined()
  })

  it("falls back to the first heading, then the file name, for a title", async () => {
    const project = makeRecutRepo({
      "wiki/concepts/headed.md": page({ type: "concept", domain: ALPHA }, "# From the heading\n\nText.\n"),
      "wiki/concepts/bare.md": page({ type: "concept", domain: ALPHA }, "Text only.\n"),
    })
    const entries = (await pagesOf(project, ALPHA)).output.pages ?? []
    expect(entries.find((entry) => entry.path === "wiki/concepts/headed.md")?.title).toBe("From the heading")
    expect(entries.find((entry) => entry.path === "wiki/concepts/bare.md")?.title).toBe("bare")
  })

  it("has an empty list for a domain without pages", async () => {
    const project = makeRecutRepo({ "wiki/concepts/four.md": null })
    expect(await pagesOf(project, ZETA)).toEqual({ exitCode: 0, output: { ok: true, pages: [] } })
  })

  it("does not change the project", async () => {
    const project = makeRecutRepo()
    await pagesOf(project, ALPHA)
    expect(status(project)).toBe("")
  })

  it("needs a domain that domains.yaml lists, and a mechanism wiki", async () => {
    const project = makeRecutRepo()
    expect((await runRecut<PagesOutput>("pages", project)).output.problems).toEqual(["missing option: --domain"])
    expect((await pagesOf(project, "example/missing")).output.problems).toEqual(["unknown domain: example/missing"])
    expect((await runRecut<PagesOutput>("pages", "/nonexistent/project", "--domain", ALPHA)).output.problems).toEqual([
      "project folder not found: /nonexistent/project",
    ])
  })
})
