/**
 * mark.test.ts - tests for `wiki-tool lint mark`.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { runCli } from "../cli"
import { makeProject, removeProjects } from "../test-project"
import { commit, conceptPage, git, HARDWARE, head, initRepo, makeRepo, makeWiki, runLint } from "./lint-fixture"

vi.setConfig({ testTimeout: 30_000 })

afterEach(removeProjects)

interface MarkOutput {
  ok: boolean
  commit?: string
  at?: string
  problems?: string[]
}

const MARKER = ".llm-wiki/semantic-lint.json"

const mark = (project: string) => runLint<MarkOutput>("mark", project)

function readMarker(project: string): { commit: string; at: string } {
  return JSON.parse(readFileSync(join(project, MARKER), "utf8")) as { commit: string; at: string }
}

describe("lint mark", () => {
  it("mark writes HEAD", async () => {
    const project = makeRepo()
    const sha = commit(project, "ingest: first (1 pages)", { "wiki/concepts/a.md": conceptPage(HARDWARE) })
    const before = Date.now()
    const { exitCode, output } = await mark(project)
    expect(exitCode).toBe(0)
    expect(output.ok).toBe(true)
    expect(output.commit).toBe(sha)

    const marker = readMarker(project)
    expect(marker.commit).toBe(sha)
    expect(marker.commit).toBe(head(project))
    // `at` is an ISO time of now.
    expect(marker.at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
    expect(Date.parse(marker.at)).toBeGreaterThanOrEqual(before - 1000)
    expect(Date.parse(marker.at)).toBeLessThanOrEqual(Date.now() + 1000)
    expect(output.at).toBe(marker.at)
  })

  it("writes the marker again at a later HEAD", async () => {
    const project = makeRepo()
    commit(project, "ingest: first (1 pages)", { "wiki/concepts/a.md": conceptPage(HARDWARE) })
    await mark(project)
    const second = commit(project, "ingest: second (1 pages)", { "wiki/concepts/a.md": conceptPage(HARDWARE, { title: "Two" }) })
    const { exitCode } = await mark(project)
    expect(exitCode).toBe(0)
    expect(readMarker(project).commit).toBe(second)
  })

  it("creates .llm-wiki/ and leaves no temporary file", async () => {
    const project = makeRepo()
    commit(project, "ingest: first (1 pages)")
    expect(existsSync(join(project, ".llm-wiki"))).toBe(false)
    await mark(project)
    expect(readdirSync(join(project, ".llm-wiki"))).toEqual(["semantic-lint.json"])
  })

  it("never commits the marker", async () => {
    // `.llm-wiki/` is not ignored here, so a `git add -A` after the write would take the marker.
    const project = makeRepo({}, { ignoreLlmWiki: false })
    const sha = commit(project, "ingest: first (1 pages)")
    const commitsBefore = git(project, "rev-list", "--all")
    await mark(project)
    expect(existsSync(join(project, MARKER))).toBe(true)
    expect(git(project, "rev-list", "--all")).toBe(commitsBefore)
    expect(head(project)).toBe(sha)
    expect(git(project, "ls-files")).not.toContain(".llm-wiki")
    expect(git(project, "diff", "--cached", "--name-only")).toBe("")
    // The marker is an untracked file, nothing more.
    expect(git(project, "status", "--porcelain")).toBe("?? .llm-wiki/\n")
  })

  // Final review, M5: the app can commit an ingest at any time during a long lint. The skill marks the commit that it
  // noted at the start, and everything after it counts as changed at the next lint.
  describe("--commit", () => {
    const markAt = (project: string, sha: string) => runLint<MarkOutput>("mark", project, "--commit", sha)

    it("writes the commit that is given, also when HEAD has moved", async () => {
      const project = makeRepo()
      const noted = commit(project, "ingest: first (1 pages)", { "wiki/concepts/a.md": conceptPage(HARDWARE) })
      const moved = commit(project, "ingest: second (1 pages)", { "wiki/concepts/b.md": conceptPage(HARDWARE) })
      const { exitCode, output } = await markAt(project, noted)
      expect(exitCode).toBe(0)
      expect(output.commit).toBe(noted)
      expect(readMarker(project).commit).toBe(noted)
      expect(head(project)).toBe(moved)
    })

    it("takes HEAD itself", async () => {
      const project = makeRepo()
      const sha = commit(project, "ingest: first (1 pages)")
      expect((await markAt(project, sha)).output.commit).toBe(sha)
      expect(readMarker(project).commit).toBe(sha)
    })

    it("takes a short sha and an upper-case sha, and writes the full sha in lower case", async () => {
      const project = makeRepo()
      const sha = commit(project, "ingest: first (1 pages)")
      commit(project, "ingest: second (1 pages)")
      expect((await markAt(project, sha.slice(0, 10))).output.commit).toBe(sha)
      expect((await markAt(project, sha.toUpperCase())).output.commit).toBe(sha)
      expect(readMarker(project).commit).toBe(sha)
    })

    it("the changed domains follow the commit that was marked", async () => {
      const project = makeRepo({ "wiki/concepts/a.md": conceptPage(HARDWARE) })
      const noted = commit(project, "ingest: first (1 pages)")
      commit(project, "ingest: second (1 pages)", { "wiki/concepts/b.md": conceptPage(HARDWARE) })
      await markAt(project, noted)
      const changed = await runLint<{ domains: string[] }>("changed-domains", project)
      expect(changed.output.domains).toEqual([HARDWARE])
    })

    it("refuses a commit that is not in the repository, and a text that is not a sha", async () => {
      const project = makeRepo()
      commit(project, "ingest: first (1 pages)")
      const unknown = await markAt(project, "0123456789abcdef0123456789abcdef01234567")
      expect(unknown.exitCode).toBe(2)
      expect(unknown.output.problems).toEqual(["--commit 0123456789abcdef0123456789abcdef01234567 is not a commit of this repository"])
      for (const text of ["HEAD", "main", "xyz1234", "abc"]) {
        const bad = await markAt(project, text)
        expect(bad.exitCode, text).toBe(2)
        expect(bad.output.problems, text).toEqual([`--commit must be the sha of a commit (7 to 64 hex digits): ${JSON.stringify(text)}`])
      }
      // An option is never a value: the option parser refuses it before git sees it.
      expect((await markAt(project, "--output=x")).exitCode).toBe(2)
      expect(existsSync(join(project, MARKER))).toBe(false)
    })

    it("refuses a commit that is not an ancestor of HEAD, and keeps the old marker", async () => {
      const project = makeRepo()
      const base = commit(project, "ingest: first (1 pages)")
      await mark(project)
      git(project, "checkout", "--quiet", "-b", "side")
      const side = commit(project, "ingest: on a side branch (1 pages)", { "wiki/concepts/s.md": conceptPage(HARDWARE) })
      git(project, "checkout", "--quiet", "-")
      commit(project, "ingest: second (1 pages)", { "wiki/concepts/b.md": conceptPage(HARDWARE) })

      const result = await markAt(project, side)
      expect(result.exitCode).toBe(2)
      expect(result.output.problems).toEqual([`--commit ${side} is not an ancestor of HEAD, so it cannot be a baseline`])
      expect(readMarker(project).commit).toBe(base)
    })

    it("still needs a mechanism wiki, a repository, and a commit", async () => {
      const plain = makeProject({}, { noHeptabaseYaml: true })
      initRepo(plain)
      const sha = commit(plain, "ingest: first (0 pages)")
      expect((await markAt(plain, sha)).output.problems?.join("\n")).toMatch(/not a mechanism wiki/)
      expect((await markAt(makeWiki(), sha)).output.problems?.join("\n")).toMatch(/git/)
      expect((await markAt(makeRepo(), sha)).output.problems?.join("\n")).toMatch(/no commit/)
    })
  })

  it("refuses a project that is not a mechanism wiki", async () => {
    const project = makeProject({}, { noHeptabaseYaml: true })
    initRepo(project)
    commit(project, "ingest: first (0 pages)")
    const { exitCode, output } = await mark(project)
    expect(exitCode).toBe(2)
    expect(output.ok).toBe(false)
    expect(output.problems?.join("\n")).toMatch(/not a mechanism wiki.*domains\.yaml/)
    expect(existsSync(join(project, MARKER))).toBe(false)
  })

  it("refuses a repository with no commit", async () => {
    const project = makeRepo()
    const { exitCode, output } = await mark(project)
    expect(exitCode).toBe(2)
    expect(output.ok).toBe(false)
    expect(output.problems?.join("\n")).toMatch(/no commit/)
    expect(existsSync(join(project, MARKER))).toBe(false)
  })

  it("refuses a project that is not a git repository", async () => {
    const project = makeWiki()
    const { exitCode, output } = await mark(project)
    expect(exitCode).toBe(2)
    expect(output.problems?.join("\n")).toMatch(/git/)
    expect(existsSync(join(project, MARKER))).toBe(false)
  })

  it("a missing --project exits 2", async () => {
    const result = await runCli(["lint", "mark"])
    expect(result.exitCode).toBe(2)
    expect(result.output.problems).toContain("missing option: --project")
  })

  it("an unknown option exits 2", async () => {
    const project = makeRepo()
    commit(project, "ingest: first (1 pages)")
    const { exitCode, output } = await runLint<MarkOutput>("mark", project, "--now", "2026-10-24")
    expect(exitCode).toBe(2)
    expect(output.problems?.join("\n")).toMatch(/unknown option: --now/)
  })
})
