/**
 * mark.test.ts - tests for `wiki-tool lint mark`.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { runCli } from "../cli"
import { removeProjects } from "../test-project"
import { commit, conceptPage, git, HARDWARE, head, makeRepo, makeWiki, runLint } from "./lint-fixture"

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
    const project = makeRepo()
    const sha = commit(project, "ingest: first (1 pages)")
    await mark(project)
    expect(head(project)).toBe(sha)
    expect(git(project, "ls-files")).not.toContain(".llm-wiki")
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
