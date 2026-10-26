/**
 * changed-domains.test.ts - tests for `wiki-tool lint changed-domains`.
 *
 * The tests run the command through runCli on temporary git repositories (see lint-fixture.ts).
 */
import { existsSync, mkdirSync } from "node:fs"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { runCli } from "../cli"
import { makeProject, removeProjects, writeProjectFile } from "../test-project"
import {
  BUSINESS,
  commit,
  conceptPage,
  DOMAINS,
  DOMAINS_YAML,
  git,
  HARDWARE,
  head,
  hypothesisPage,
  initRepo,
  makeRepo,
  makeWiki,
  mechanismPage,
  PHYSICS,
  runLint,
  setMarker,
} from "./lint-fixture"

// Each test starts many git processes; a busy machine needs more than the default 5 s.
vi.setConfig({ testTimeout: 30_000 })

afterEach(removeProjects)

interface ChangedOutput {
  ok: boolean
  since?: string | null
  domains?: string[]
  mechanismsChanged?: boolean
  ingestsSince?: number
  note?: string
  problems?: string[]
}

const run = (project: string, ...rest: string[]) => runLint<ChangedOutput>("changed-domains", project, ...rest)

/** A repository with one concept page in each domain, committed as an ingest, and the marker at that commit. */
function markedRepo(): { project: string; marker: string } {
  const project = makeRepo()
  const marker = commit(project, "ingest: first (3 pages)", {
    "wiki/concepts/a.md": conceptPage(HARDWARE),
    "wiki/concepts/b.md": conceptPage(BUSINESS),
    "wiki/concepts/c.md": conceptPage(PHYSICS),
  })
  setMarker(project, marker)
  return { project, marker }
}

describe("lint changed-domains: without a usable marker", () => {
  it("no marker returns every domain", async () => {
    const project = makeRepo()
    commit(project, "ingest: first (1 pages)", { "wiki/concepts/a.md": conceptPage(HARDWARE) })
    const { exitCode, output } = await run(project)
    expect(exitCode).toBe(0)
    // Every domain of domains.yaml, once, in file order (not sorted), also the ones with no page.
    expect(output).toEqual({ ok: true, since: null, domains: [...DOMAINS], mechanismsChanged: false, ingestsSince: 1 })
  })

  it("no marker: mechanismsChanged is true when the wiki has a mechanism page", async () => {
    const project = makeRepo()
    commit(project, "ingest: first (1 pages)", { "wiki/mechanisms/handshake.md": mechanismPage() })
    const { output } = await run(project)
    expect(output.mechanismsChanged).toBe(true)
  })

  it("a repository with no commit returns every domain and no ingest", async () => {
    const project = makeRepo()
    const { exitCode, output } = await run(project)
    expect(exitCode).toBe(0)
    expect(output).toEqual({ ok: true, since: null, domains: [...DOMAINS], mechanismsChanged: false, ingestsSince: 0 })
  })

  it("marker not in history returns every domain", async () => {
    const project = makeRepo()
    commit(project, "ingest: first (1 pages)", { "wiki/concepts/a.md": conceptPage(HARDWARE) })
    const second = commit(project, "ingest: second (1 pages)", { "wiki/concepts/b.md": conceptPage(BUSINESS) })
    setMarker(project, second)
    // The history is rewritten: the marker commit still exists in the object store but is no ancestor of HEAD.
    git(project, "reset", "--hard", "--quiet", "HEAD~1")
    commit(project, "ingest: other (1 pages)", { "wiki/concepts/c.md": conceptPage(PHYSICS) })

    const { exitCode, output } = await run(project)
    expect(exitCode).toBe(0)
    expect(output.since).toBeNull()
    expect(output.domains).toEqual([...DOMAINS])
    expect(output.note).toMatch(/not in the history/)
    expect(output.ingestsSince).toBe(2)
  })

  it("a marker commit that does not exist returns every domain with a note", async () => {
    const project = makeRepo()
    commit(project, "ingest: first (1 pages)", { "wiki/concepts/a.md": conceptPage(HARDWARE) })
    setMarker(project, "0123456789abcdef0123456789abcdef01234567")
    const { exitCode, output } = await run(project)
    expect(exitCode).toBe(0)
    expect(output.since).toBeNull()
    expect(output.domains).toEqual([...DOMAINS])
    expect(output.note).toMatch(/not in the history/)
  })

  it.each([
    ["is not JSON", "this is not json"],
    ["has no commit", JSON.stringify({ at: "2026-10-01T00:00:00.000Z" })],
    ["has a commit that is not a sha", JSON.stringify({ commit: "--output=/tmp/x", at: "2026-10-01T00:00:00.000Z" })],
    ["has a commit that is not text", JSON.stringify({ commit: 12 })],
  ])("a marker that %s returns every domain with a note", async (_name, text) => {
    const project = makeRepo()
    commit(project, "ingest: first (1 pages)", { "wiki/concepts/a.md": conceptPage(HARDWARE) })
    writeProjectFile(project, ".llm-wiki/semantic-lint.json", text)
    const { exitCode, output } = await run(project)
    expect(exitCode).toBe(0)
    expect(output.since).toBeNull()
    expect(output.domains).toEqual([...DOMAINS])
    expect(output.note).toMatch(/marker/)
  })
})

describe("lint changed-domains: a marker that names no usable commit", () => {
  it("a marker that is a directory cannot be read: every domain with a note", async () => {
    const project = makeRepo()
    commit(project, "ingest: first (1 pages)", { "wiki/concepts/a.md": conceptPage(HARDWARE) })
    mkdirSync(join(project, ".llm-wiki/semantic-lint.json"), { recursive: true })
    const { exitCode, output } = await run(project)
    expect(exitCode).toBe(0)
    expect(output.since).toBeNull()
    expect(output.domains).toEqual([...DOMAINS])
    expect(output.note).toMatch(/cannot be read/)
  })

  it("a marker that is not JSON says so", async () => {
    const project = makeRepo()
    commit(project, "ingest: first (1 pages)", { "wiki/concepts/a.md": conceptPage(HARDWARE) })
    writeProjectFile(project, ".llm-wiki/semantic-lint.json", "{ not json")
    const { output } = await run(project)
    expect(output.note).toMatch(/not valid JSON/)
  })

  it("a marker that names an object that is not a commit is no marker", async () => {
    const project = makeRepo()
    commit(project, "ingest: first (1 pages)", { "wiki/concepts/a.md": conceptPage(HARDWARE) })
    const tree = git(project, "rev-parse", "HEAD^{tree}").trim()
    setMarker(project, tree)
    const { exitCode, output } = await run(project)
    expect(exitCode).toBe(0)
    expect(output.since).toBeNull()
    expect(output.domains).toEqual([...DOMAINS])
    expect(output.note).toContain(tree)
    expect(output.note).toMatch(/not in the history/)
  })

  it("a marker that looks like a git option is not given to git", async () => {
    const project = makeRepo()
    commit(project, "ingest: first (1 pages)", { "wiki/concepts/a.md": conceptPage(HARDWARE) })
    const injected = join(project, "injected.txt")
    setMarker(project, `--output=${injected}`)
    const { exitCode, output } = await run(project)
    expect(exitCode).toBe(0)
    expect(output.since).toBeNull()
    expect(output.note).toMatch(/marker/)
    expect(existsSync(injected)).toBe(false)
  })
})

describe("lint changed-domains: with a marker", () => {
  it("accepts a short marker sha", async () => {
    const { project, marker } = markedRepo()
    setMarker(project, marker.slice(0, 7))
    commit(project, "ingest: second (1 pages)", { "wiki/concepts/c.md": conceptPage(PHYSICS, { title: "Changed" }) })
    const { output } = await run(project)
    // `since` is the full sha.
    expect(output).toEqual({ ok: true, since: marker, domains: [PHYSICS], mechanismsChanged: false, ingestsSince: 1 })
  })

  it("accepts an upper case marker sha", async () => {
    const { project, marker } = markedRepo()
    setMarker(project, marker.toUpperCase())
    commit(project, "ingest: second (1 pages)", { "wiki/concepts/c.md": conceptPage(PHYSICS, { title: "Changed" }) })
    const { output } = await run(project)
    expect(output).toEqual({ ok: true, since: marker, domains: [PHYSICS], mechanismsChanged: false, ingestsSince: 1 })
  })

  it("a deleted page with a byte order mark counts under its old domain", async () => {
    const project = makeRepo()
    const marker = commit(project, "ingest: first (1 pages)", { "wiki/concepts/a.md": `\uFEFF${conceptPage(HARDWARE)}` })
    setMarker(project, marker)
    commit(project, "ingest: second (0 pages)", { "wiki/concepts/a.md": null })
    const { output } = await run(project)
    expect(output.domains).toEqual([HARDWARE])
  })

  it("returns domains changed since the marker", async () => {
    const { project, marker } = markedRepo()
    commit(project, "ingest: second (2 pages)", {
      "wiki/concepts/c.md": conceptPage(PHYSICS, { title: "Changed" }),
      "wiki/concepts/d.md": conceptPage(PHYSICS),
    })
    const { exitCode, output } = await run(project)
    expect(exitCode).toBe(0)
    expect(output).toEqual({ ok: true, since: marker, domains: [PHYSICS], mechanismsChanged: false, ingestsSince: 1 })
  })

  it("lists the changed domains in the order of domains.yaml", async () => {
    const { project } = markedRepo()
    commit(project, "ingest: second (3 pages)", {
      "wiki/concepts/c.md": conceptPage(PHYSICS, { title: "Changed" }),
      "wiki/concepts/b.md": conceptPage(BUSINESS, { title: "Changed" }),
    })
    const { output } = await run(project)
    expect(output.domains).toEqual([BUSINESS, PHYSICS])
  })

  it("nothing changed since the marker returns no domain", async () => {
    const { project, marker } = markedRepo()
    const { exitCode, output } = await run(project)
    expect(exitCode).toBe(0)
    expect(output).toEqual({ ok: true, since: marker, domains: [], mechanismsChanged: false, ingestsSince: 0 })
  })

  it("includes also domains", async () => {
    const { project } = markedRepo()
    commit(project, "ingest: second (1 pages)", {
      "wiki/concepts/a.md": conceptPage(HARDWARE, { also: [PHYSICS] }),
    })
    const { output } = await run(project)
    expect(output.domains).toEqual([HARDWARE, PHYSICS])
  })

  it("counts ingest commits since the marker", async () => {
    const { project } = markedRepo()
    commit(project, "ingest: second (1 pages)", { "wiki/concepts/a.md": conceptPage(HARDWARE, { title: "Two" }) })
    commit(project, "docs: not an ingest", { "notes.txt": "x" })
    commit(project, "ingest: third (1 pages)", { "wiki/concepts/a.md": conceptPage(HARDWARE, { title: "Three" }) })
    commit(project, "Reingest: not an ingest either", { "notes.txt": "y" })
    const { output } = await run(project)
    // The ingest before the marker (the marker commit itself) does not count.
    expect(output.ingestsSince).toBe(2)
  })

  it("a deleted page counts under its old domain", async () => {
    const { project } = markedRepo()
    commit(project, "ingest: second (0 pages)", { "wiki/concepts/b.md": null })
    const { output } = await run(project)
    expect(output.domains).toEqual([BUSINESS])
  })

  it("a hypothesis counts under to_domain", async () => {
    const { project } = markedRepo()
    commit(project, "ingest: second (1 pages)", { "wiki/hypotheses/h.md": hypothesisPage(HARDWARE, PHYSICS) })
    const { output } = await run(project)
    // Not under its from_domain.
    expect(output.domains).toEqual([PHYSICS])
  })

  it("a page that moves to another domain counts under both", async () => {
    const { project } = markedRepo()
    commit(project, "ingest: second (1 pages)", { "wiki/concepts/a.md": conceptPage(PHYSICS) })
    const { output } = await run(project)
    expect(output.domains).toEqual([HARDWARE, PHYSICS])
  })

  it("a renamed page counts under its domain", async () => {
    const { project } = markedRepo()
    git(project, "mv", "wiki/concepts/b.md", "wiki/concepts/b-renamed.md")
    commit(project, "ingest: second (1 pages)")
    const { output } = await run(project)
    expect(output.domains).toEqual([BUSINESS])
  })

  it("a page moved between folders counts under the old and the new domain", async () => {
    const { project } = markedRepo()
    commit(project, "ingest: second (1 pages)", { "wiki/concepts/a.md": null, "wiki/entities/a.md": conceptPage(BUSINESS) })
    const { output } = await run(project)
    expect(output.domains).toEqual([HARDWARE, BUSINESS])
  })

  it("leaves out a domain that domains.yaml does not list", async () => {
    const { project } = markedRepo()
    commit(project, "ingest: second (1 pages)", {
      "wiki/concepts/a.md": conceptPage("not/listed", { also: [PHYSICS, "also/unlisted"] }),
    })
    const { output } = await run(project)
    // `hardware/async-circuits` lost its page, so it still counts; the two unlisted names are dropped.
    expect(output.domains).toEqual([HARDWARE, PHYSICS])
  })

  it("ignores files that are not pages", async () => {
    const { project } = markedRepo()
    commit(project, "ingest: second (0 pages)", {
      "wiki/index.md": "# Index\n",
      "wiki/log.md": "# Log\n",
      "wiki/overview.md": conceptPage(HARDWARE),
      "wiki/indexes/hardware--async-circuits.md": conceptPage(HARDWARE),
      "wiki/concepts/image.png": "not a page",
      "raw/sources/a.md": conceptPage(BUSINESS),
      "domains.yaml": `${DOMAINS_YAML}\n`,
    })
    const { output } = await run(project)
    expect(output.domains).toEqual([])
    expect(output.mechanismsChanged).toBe(false)
  })

  it("mechanismsChanged is true when a path under wiki/mechanisms/ changed", async () => {
    const { project } = markedRepo()
    commit(project, "ingest: second (1 pages)", { "wiki/mechanisms/handshake.md": mechanismPage() })
    const { output } = await run(project)
    expect(output.mechanismsChanged).toBe(true)
    // A mechanism page has no domain.
    expect(output.domains).toEqual([])
  })

  it("does not count uncommitted changes", async () => {
    const { project } = markedRepo()
    writeProjectFile(project, "wiki/concepts/c.md", conceptPage(PHYSICS, { title: "Not committed" }))
    const { output } = await run(project)
    expect(output.domains).toEqual([])
  })

  it("works for a project in a folder of a larger repository", async () => {
    const outer = makeWiki()
    initRepo(outer)
    const project = `${outer}/wiki-project`
    writeProjectFile(outer, "wiki-project/domains.yaml", DOMAINS_YAML)
    writeProjectFile(outer, "wiki-project/wiki.yaml", "version: 1\nid: test\nrole: reading\n")
    const marker = commit(outer, "ingest: first (1 pages)", { "wiki-project/wiki/concepts/a.md": conceptPage(HARDWARE) })
    setMarker(project, marker)
    commit(outer, "ingest: second (1 pages)", {
      "wiki-project/wiki/concepts/a.md": conceptPage(HARDWARE, { title: "Changed" }),
      "other-project/wiki/concepts/z.md": conceptPage(PHYSICS),
    })
    const { output } = await run(project)
    expect(output.domains).toEqual([HARDWARE])
  })

  it("counts only the ingest commits that touch the project folder", async () => {
    const outer = makeWiki()
    initRepo(outer)
    const project = join(outer, "wiki-project")
    writeProjectFile(outer, "wiki-project/domains.yaml", DOMAINS_YAML)
    writeProjectFile(outer, "wiki-project/wiki.yaml", "version: 1\nid: test\nrole: reading\n")
    const marker = commit(outer, "ingest: first (1 pages)", { "wiki-project/wiki/concepts/a.md": conceptPage(HARDWARE) })
    setMarker(project, marker)
    commit(outer, "ingest: other project (1 pages)", { "other-project/wiki/concepts/z.md": conceptPage(PHYSICS) })
    commit(outer, "ingest: other project again (1 pages)", { "other-project/wiki/concepts/y.md": conceptPage(PHYSICS) })
    expect((await run(project)).output.ingestsSince).toBe(0)

    commit(outer, "ingest: this project (1 pages)", { "wiki-project/wiki/concepts/a.md": conceptPage(HARDWARE, { title: "Changed" }) })
    commit(outer, "docs: this project", { "wiki-project/notes.txt": "x" })
    expect((await run(project)).output.ingestsSince).toBe(1)

    // Without a marker, the commits of the project count: the first one and the one just made.
    writeProjectFile(project, ".llm-wiki/semantic-lint.json", "{}")
    expect((await run(project)).output.ingestsSince).toBe(2)
  })
})

describe("lint changed-domains: a work wiki", () => {
  const LIBRARY_DOMAINS_YAML = [
    "version: 1",
    "domains:",
    "  ai/agents:",
    "    lens: ai",
    "    description: Placeholder library domain",
    "",
  ].join("\n")

  /** A work wiki (a git repository) whose reading wiki has the given `domains.yaml`. */
  function makeWorkRepo(libraryDomainsYaml: string): string {
    const project = makeRepo()
    const library = makeWiki({ "domains.yaml": libraryDomainsYaml })
    writeProjectFile(project, "wiki.yaml", `version: 1\nid: work\nrole: work\nmechanism_library: ${library}\n`)
    return project
  }

  it("keeps a domain of the reading wiki that a hypothesis names as to_domain", async () => {
    const project = makeWorkRepo(LIBRARY_DOMAINS_YAML)
    const marker = commit(project, "ingest: first (1 pages)", { "wiki/concepts/a.md": conceptPage(HARDWARE) })
    setMarker(project, marker)
    commit(project, "ingest: second (2 pages)", {
      "wiki/hypotheses/h.md": hypothesisPage(HARDWARE, "ai/agents"),
      "wiki/concepts/a.md": conceptPage(HARDWARE, { title: "Changed" }),
    })
    const { exitCode, output } = await run(project)
    expect(exitCode).toBe(0)
    // The domains of this wiki first, then the domains of the reading wiki.
    expect(output.domains).toEqual([HARDWARE, "ai/agents"])
  })

  it("no marker: adds a domain of the reading wiki that a page names", async () => {
    const project = makeWorkRepo(LIBRARY_DOMAINS_YAML)
    commit(project, "ingest: first (1 pages)", { "wiki/hypotheses/h.md": hypothesisPage(HARDWARE, "ai/agents") })
    const { output } = await run(project)
    expect(output.domains).toEqual([...DOMAINS, "ai/agents"])
  })

  it("no marker: a domain of the reading wiki that no page names is not in the list", async () => {
    const project = makeWorkRepo(LIBRARY_DOMAINS_YAML)
    commit(project, "ingest: first (1 pages)", { "wiki/concepts/a.md": conceptPage(HARDWARE) })
    const { output } = await run(project)
    expect(output.domains).toEqual([...DOMAINS])
  })

  it("a reading wiki without a usable domains.yaml is a handled problem", async () => {
    const project = makeWorkRepo("version: 1\ndomains:\n  Bad Name:\n    lens: ai\n    description: x\n")
    commit(project, "ingest: first (1 pages)", { "wiki/concepts/a.md": conceptPage(HARDWARE) })
    const { exitCode, output } = await run(project)
    expect(exitCode).toBe(2)
    expect(output.ok).toBe(false)
    expect(output.problems?.join("\n")).toMatch(/reading wiki domains\.yaml/)
  })
})

describe("lint changed-domains: handled problems", () => {
  it("a project without domains.yaml exits 2", async () => {
    const project = makeProject({}, { noHeptabaseYaml: true })
    initRepo(project)
    commit(project, "ingest: first (0 pages)")
    const { exitCode, output } = await run(project)
    expect(exitCode).toBe(2)
    expect(output.problems?.join("\n")).toMatch(/domains\.yaml/)
  })

  it("a domains.yaml that is not valid exits 2 and names the file", async () => {
    const project = makeRepo({ "domains.yaml": "version: 1\ndomains:\n  Bad Name:\n    lens: ai\n    description: x\n" })
    commit(project, "ingest: first (0 pages)")
    const { exitCode, output } = await run(project)
    expect(exitCode).toBe(2)
    expect(output.ok).toBe(false)
    expect(output.problems?.join("\n")).toMatch(/domains\.yaml/)
  })

  it("a wiki.yaml that is not valid exits 2 and names the file", async () => {
    const project = makeRepo({ "wiki.yaml": "version: 1\nid: x\nrole: nonsense\n" })
    commit(project, "ingest: first (0 pages)")
    const { exitCode, output } = await run(project)
    expect(exitCode).toBe(2)
    expect(output.problems?.join("\n")).toMatch(/wiki\.yaml/)
  })

  it("a project that is not a git repository exits 2", async () => {
    const project = makeWiki()
    const { exitCode, output } = await run(project)
    expect(exitCode).toBe(2)
    expect(output.problems?.join("\n")).toMatch(/git/)
  })

  it("a missing --project exits 2", async () => {
    const result = await runCli(["lint", "changed-domains"])
    expect(result.exitCode).toBe(2)
    expect(result.output.problems).toContain("missing option: --project")
  })

  it("a project folder that does not exist exits 2", async () => {
    const { exitCode, output } = await run("/nonexistent/wiki-tool-lint-project")
    expect(exitCode).toBe(2)
    expect(output.problems?.join("\n")).toMatch(/project folder not found/)
  })

  it("leaves the repository as it was", async () => {
    const { project } = markedRepo()
    commit(project, "ingest: second (1 pages)", { "wiki/concepts/a.md": conceptPage(HARDWARE, { title: "Changed" }) })
    const before = head(project)
    await run(project)
    expect(head(project)).toBe(before)
    expect(git(project, "status", "--porcelain")).toBe("")
  })
})
