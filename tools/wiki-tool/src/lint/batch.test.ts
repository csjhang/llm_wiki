/**
 * batch.test.ts - tests for `wiki-tool lint batch`.
 *
 * Page sizes are set with filler text; a batch is judged by the total characters of its files.
 */
import { readFileSync, rmSync } from "node:fs"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { runCli } from "../cli"
import { removeProjects } from "../test-project"
import { BUSINESS, conceptPage, HARDWARE, hypothesisPage, makeWiki, mechanismPage, PHYSICS, page, runLint } from "./lint-fixture"

afterEach(removeProjects)

interface BatchOutput {
  ok: boolean
  batches?: string[][]
  notes?: string[]
  problems?: string[]
}

const batch = (project: string, domain: string, ...rest: string[]) =>
  runLint<BatchOutput>("batch", project, "--domain", domain, ...rest)

/** A page of the given type and domain whose file is exactly `size` characters long. */
function pageOfSize(type: string, domain: string, size: number): string {
  const head = page({ type, title: "Placeholder", domain })
  if (head.length > size) throw new Error(`size ${size} is smaller than the frontmatter (${head.length})`)
  return head + "x".repeat(size - head.length)
}

function sizeOf(project: string, path: string): number {
  return readFileSync(join(project, path), "utf8").length
}

describe("lint batch", () => {
  it("batches stay under the size limit", async () => {
    const files: Record<string, string> = {}
    for (let index = 0; index < 9; index += 1) {
      files[`wiki/concepts/page-${index}.md`] = pageOfSize("concept", HARDWARE, 250 + index * 10)
    }
    const project = makeWiki(files)
    const limit = 700
    const { exitCode, output } = await batch(project, HARDWARE, "--max-chars", String(limit))
    expect(exitCode).toBe(0)
    expect(output.ok).toBe(true)

    const batches = output.batches ?? []
    expect(batches.length).toBeGreaterThan(1)
    for (const paths of batches) {
      const total = paths.reduce((sum, path) => sum + sizeOf(project, path), 0)
      expect(total, JSON.stringify(paths)).toBeLessThanOrEqual(limit)
    }
    // Every page is in a batch, once, in path order.
    expect(batches.flat()).toEqual(Object.keys(files).sort())
    expect(output.notes).toBeUndefined()
  })

  it("fills a batch up to the limit", async () => {
    const project = makeWiki({
      "wiki/concepts/a.md": pageOfSize("concept", HARDWARE, 300),
      "wiki/concepts/b.md": pageOfSize("concept", HARDWARE, 300),
      "wiki/concepts/c.md": pageOfSize("concept", HARDWARE, 301),
    })
    // 300 + 300 = 600 fits a limit of 600. The next file (301) does not.
    const { output } = await batch(project, HARDWARE, "--max-chars", "600")
    expect(output).toEqual({
      ok: true,
      batches: [["wiki/concepts/a.md", "wiki/concepts/b.md"], ["wiki/concepts/c.md"]],
    })
  })

  it("the default limit is 60000 characters", async () => {
    const project = makeWiki({
      "wiki/concepts/a.md": pageOfSize("concept", HARDWARE, 25_000),
      "wiki/concepts/b.md": pageOfSize("concept", HARDWARE, 25_000),
      "wiki/concepts/c.md": pageOfSize("concept", HARDWARE, 25_000),
    })
    const { output } = await batch(project, HARDWARE)
    expect(output.batches).toEqual([["wiki/concepts/a.md", "wiki/concepts/b.md"], ["wiki/concepts/c.md"]])
  })

  it("a new batch starts when the type changes", async () => {
    const project = makeWiki({
      "wiki/concepts/a.md": pageOfSize("concept", HARDWARE, 200),
      "wiki/entities/b.md": pageOfSize("entity", HARDWARE, 200),
      "wiki/sources/c.md": pageOfSize("source", HARDWARE, 200),
      "wiki/concepts/d.md": pageOfSize("concept", HARDWARE, 200),
    })
    const { output } = await batch(project, HARDWARE)
    // Sorted by type (concept, entity, source), then by path.
    expect(output.batches).toEqual([
      ["wiki/concepts/a.md", "wiki/concepts/d.md"],
      ["wiki/entities/b.md"],
      ["wiki/sources/c.md"],
    ])
  })

  it("sorts by type, then by path", async () => {
    const project = makeWiki({
      "wiki/concepts/zeta.md": pageOfSize("concept", HARDWARE, 200),
      "wiki/concepts/alpha.md": pageOfSize("concept", HARDWARE, 200),
      "wiki/queries/mid.md": pageOfSize("query", HARDWARE, 200),
    })
    const { output } = await batch(project, HARDWARE)
    expect(output.batches).toEqual([["wiki/concepts/alpha.md", "wiki/concepts/zeta.md"], ["wiki/queries/mid.md"]])
  })

  it("a file larger than the limit gets its own batch", async () => {
    const project = makeWiki({
      "wiki/concepts/a.md": pageOfSize("concept", HARDWARE, 200),
      "wiki/concepts/b-big.md": pageOfSize("concept", HARDWARE, 900),
      "wiki/concepts/c.md": pageOfSize("concept", HARDWARE, 200),
      "wiki/concepts/d.md": pageOfSize("concept", HARDWARE, 200),
    })
    const { exitCode, output } = await batch(project, HARDWARE, "--max-chars", "500")
    expect(exitCode).toBe(0)
    expect(output.batches).toEqual([["wiki/concepts/a.md"], ["wiki/concepts/b-big.md"], ["wiki/concepts/c.md", "wiki/concepts/d.md"]])
    expect(output.notes).toHaveLength(1)
    expect(output.notes?.[0]).toContain("wiki/concepts/b-big.md")
    expect(output.notes?.[0]).toContain("900")
    expect(output.notes?.[0]).toContain("500")
  })

  it("a large first file gets its own batch too", async () => {
    const project = makeWiki({
      "wiki/concepts/a-big.md": pageOfSize("concept", HARDWARE, 900),
      "wiki/concepts/b.md": pageOfSize("concept", HARDWARE, 100),
    })
    const { output } = await batch(project, HARDWARE, "--max-chars", "500")
    expect(output.batches).toEqual([["wiki/concepts/a-big.md"], ["wiki/concepts/b.md"]])
    expect(output.notes).toHaveLength(1)
  })

  it("holds the pages of the domain: domain, or to_domain of a hypothesis; not also pages, not mechanisms", async () => {
    const project = makeWiki({
      "wiki/concepts/own.md": conceptPage(HARDWARE),
      "wiki/concepts/other.md": conceptPage(BUSINESS),
      "wiki/concepts/also.md": conceptPage(BUSINESS, { also: [HARDWARE] }),
      "wiki/hypotheses/to-here.md": hypothesisPage(PHYSICS, HARDWARE),
      "wiki/hypotheses/from-here.md": hypothesisPage(HARDWARE, PHYSICS),
      "wiki/mechanisms/handshake.md": mechanismPage({ domain: HARDWARE }),
      "wiki/index.md": "# Index\n",
      "wiki/indexes/hardware--async-circuits.md": conceptPage(HARDWARE),
    })
    const { output } = await batch(project, HARDWARE)
    expect(output.batches?.flat().sort()).toEqual(["wiki/concepts/own.md", "wiki/hypotheses/to-here.md"])
  })

  it("a domain with no page has no batch", async () => {
    const project = makeWiki({ "wiki/concepts/a.md": conceptPage(HARDWARE) })
    const { exitCode, output } = await batch(project, PHYSICS)
    expect(exitCode).toBe(0)
    expect(output).toEqual({ ok: true, batches: [] })
  })

  it("an unknown domain exits 2 and names it", async () => {
    const project = makeWiki({ "wiki/concepts/a.md": conceptPage(HARDWARE) })
    const { exitCode, output } = await batch(project, "not/listed")
    expect(exitCode).toBe(2)
    expect(output.ok).toBe(false)
    expect(output.problems?.join("\n")).toContain("not/listed")
  })

  it("a domain of the reading wiki is known in a work wiki", async () => {
    const library = makeWiki({
      "domains.yaml": "version: 1\ndomains:\n  ai/agents:\n    lens: ai\n    description: Placeholder library domain\n",
    })
    const project = makeWiki({
      "wiki.yaml": `version: 1\nid: work\nrole: work\nmechanism_library: ${library}\n`,
      "wiki/hypotheses/h.md": hypothesisPage(HARDWARE, "ai/agents"),
    })
    const { exitCode, output } = await batch(project, "ai/agents")
    expect(exitCode).toBe(0)
    expect(output.batches).toEqual([["wiki/hypotheses/h.md"]])
  })

  it.each(["0", "-5", "abc", "1.5", "", "1e3", "007x"])("--max-chars %j exits 2", async (value) => {
    const project = makeWiki({ "wiki/concepts/a.md": conceptPage(HARDWARE) })
    const { exitCode, output } = await batch(project, HARDWARE, `--max-chars=${value}`)
    expect(exitCode).toBe(2)
    expect(output.problems?.join("\n")).toMatch(/--max-chars must be a positive integer/)
  })

  it("--domain is required", async () => {
    const project = makeWiki()
    const { exitCode, output } = await runLint<BatchOutput>("batch", project)
    expect(exitCode).toBe(2)
    expect(output.problems).toContain("missing option: --domain")
  })

  it("--project is required", async () => {
    const result = await runCli(["lint", "batch", "--domain", HARDWARE])
    expect(result.exitCode).toBe(2)
    expect(result.output.problems).toContain("missing option: --project")
  })

  it("a domains.yaml that is not valid exits 2 and names the file", async () => {
    const project = makeWiki({ "domains.yaml": "version: 1\ndomains:\n  Bad Name:\n    lens: ai\n    description: x\n" })
    const { exitCode, output } = await batch(project, HARDWARE)
    expect(exitCode).toBe(2)
    expect(output.problems?.join("\n")).toMatch(/domains\.yaml/)
  })

  it("a project without domains.yaml exits 2", async () => {
    const project = makeWiki({ "wiki/concepts/a.md": conceptPage(HARDWARE) })
    rmSync(join(project, "domains.yaml"))
    const { exitCode, output } = await batch(project, HARDWARE)
    expect(exitCode).toBe(2)
    expect(output.problems?.join("\n")).toMatch(/domains\.yaml/)
  })
})
