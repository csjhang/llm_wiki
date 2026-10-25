/**
 * commit.test.ts - tests for `wiki-tool fuse commit`.
 *
 * The tests run the command through runCli on a wiki project that is a real temporary git repository. The repository
 * has a local identity, so the tests do not depend on the git config of the machine. Slugs and titles are
 * placeholders.
 */
import { execFileSync } from "node:child_process"
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { runCli } from "../cli"
import { commitPathsLocked } from "../git"
import { GIT_LOCK_BUSY_MESSAGE } from "../git-lock"
import { removeProjects, writeProjectFile } from "../test-project"
import { hypothesisPage, makeWiki, makeWorkWiki, verifyTable } from "./hypothesis-fixture"

// The real helper, except in the one test that makes the lock busy: waiting for a real lock takes 30 s.
vi.mock("../git", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../git")>()
  return { ...actual, commitPathsLocked: vi.fn(actual.commitPathsLocked) }
})

// Each test starts several git processes; a busy machine needs more than the default 5 s.
vi.setConfig({ testTimeout: 30_000 })

const FILE = "wiki/hypotheses/threshold-restocking.md"
const OTHER_FILE = "wiki/hypotheses/second-idea.md"
const TITLE = "Threshold restocking"

afterEach(() => {
  removeProjects()
  vi.mocked(commitPathsLocked).mockClear()
})

function git(repo: string, ...args: string[]): string {
  return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" })
}

/** A wiki project in a git repository with one commit of the wiki as it is. */
function makeRepo(files: Record<string, string> = {}): string {
  const project = makeWiki(files)
  git(project, "init", "--quiet")
  git(project, "config", "user.name", "Test User")
  git(project, "config", "user.email", "test@example.com")
  git(project, "add", "-A")
  git(project, "commit", "--quiet", "--no-verify", "-m", "initial")
  return project
}

interface CommitOutput {
  ok: boolean
  sha?: string | null
  problems?: string[]
}

async function commit(project: string, files: string[], title: string | null = TITLE) {
  const args = ["fuse", "commit", "--project", project, ...(title === null ? [] : ["--title", title])]
  for (const file of files) args.push("--file", file)
  const result = await runCli(args)
  return { exitCode: result.exitCode, output: result.output as CommitOutput }
}

function head(repo: string): string {
  return git(repo, "rev-parse", "HEAD").trim()
}

function commitCount(repo: string): number {
  return Number(git(repo, "rev-list", "--count", "HEAD").trim())
}

function headFiles(repo: string): string[] {
  return git(repo, "show", "--name-only", "--no-renames", "--format=", "HEAD")
    .split("\n")
    .filter((line) => line !== "")
    .sort()
}

describe("fuse commit", () => {
  it("commits with fuse subject", async () => {
    const project = makeRepo()
    writeProjectFile(project, FILE, hypothesisPage())

    const { exitCode, output } = await commit(project, [FILE])

    expect(exitCode).toBe(0)
    expect(output).toEqual({ ok: true, sha: head(project) })
    expect(git(project, "log", "-1", "--format=%s").trim()).toBe(`fuse: ${TITLE} (1 pages)`)
    expect(git(project, "log", "-1", "--format=%b")).toContain(`- ${FILE}`)
    expect(headFiles(project)).toEqual([FILE])
  })

  it("counts every listed file in the subject and commits only those files", async () => {
    const project = makeRepo({ "wiki/mechanisms/event-driven.md": "---\ntype: mechanism\n---\n# Event driven\n" })
    writeProjectFile(project, FILE, hypothesisPage())
    writeProjectFile(project, "wiki/mechanisms/event-driven.md", "---\ntype: mechanism\n---\n# Event driven\n\nOne more line.\n")
    writeProjectFile(project, "wiki/concepts/unrelated.md", "# Not listed\n")

    const { output } = await commit(project, [FILE, "wiki/mechanisms/event-driven.md"])

    expect(output.ok).toBe(true)
    expect(git(project, "log", "-1", "--format=%s").trim()).toBe(`fuse: ${TITLE} (2 pages)`)
    expect(headFiles(project)).toEqual([FILE, "wiki/mechanisms/event-driven.md"])
    expect(git(project, "status", "--porcelain").trim()).toBe("?? wiki/concepts/unrelated.md")
  })

  it("checks only the files under wiki/hypotheses/", async () => {
    // A page of another folder is committed as it is, even if it would fail the hypothesis check.
    const project = makeRepo()
    writeProjectFile(project, "wiki/concepts/plain.md", "# Plain\n")

    const { output } = await commit(project, ["wiki/concepts/plain.md"])

    expect(output.ok).toBe(true)
    expect(headFiles(project)).toEqual(["wiki/concepts/plain.md"])
  })

  it("does not commit a work wiki page that links the reading mechanism", async () => {
    const library = makeWiki({ "wiki/mechanisms/event-driven.md": "---\ntype: mechanism\n---\n# Event driven\n" })
    const project = makeRepo()
    makeWorkWiki(project, library)
    const before = commitCount(project)
    writeProjectFile(
      project,
      FILE,
      hypothesisPage({
        fields: { mechanism: "reading:event-driven" },
        sections: { gaps: "- Delay. [[restock-policy]] and [[event-driven]]" },
      }),
    )

    const { exitCode, output } = await commit(project, [FILE])

    expect(exitCode).toBe(2)
    expect(output.ok).toBe(false)
    expect(output.problems?.join("\n")).toMatch(new RegExp(`${FILE}: .*\\[\\[event-driven\\]\\].*reading wiki`, "s"))
    expect(commitCount(project)).toBe(before)
  })

  it("commits a page whose check has only warnings", async () => {
    const project = makeRepo()
    writeProjectFile(project, FILE, hypothesisPage({ sections: { gaps: "- Delay. [[no-such-page]]" } }))

    const { exitCode, output } = await commit(project, [FILE])

    expect(exitCode).toBe(0)
    expect(output).toEqual({ ok: true, sha: head(project) })
  })

  it("lists a file once however it is written", async () => {
    const project = makeRepo()
    writeProjectFile(project, FILE, hypothesisPage())

    const { output } = await commit(project, [FILE, `./${FILE}`, `wiki/concepts/../hypotheses/threshold-restocking.md`])

    expect(output.ok).toBe(true)
    expect(git(project, "log", "-1", "--format=%s").trim()).toBe(`fuse: ${TITLE} (1 pages)`)
  })

  it("cuts a long title as the app does", async () => {
    const project = makeRepo()
    writeProjectFile(project, FILE, hypothesisPage())

    await commit(project, [FILE], "A very long title that goes on and on and on and on and on and on and on and on")

    const subject = git(project, "log", "-1", "--format=%s").trim()
    expect([...subject].length).toBeLessThanOrEqual(72)
    expect(subject).toMatch(/^fuse: .+… \(1 pages\)$/)
  })

  it("has nothing to commit for a page that is already committed", async () => {
    const project = makeRepo({ [FILE]: hypothesisPage() })
    const before = commitCount(project)

    const { exitCode, output } = await commit(project, [FILE])

    expect(exitCode).toBe(0)
    expect(output).toEqual({ ok: true, sha: null })
    expect(commitCount(project)).toBe(before)
  })

  it("commits a hypothesis that a later edit changed", async () => {
    const project = makeRepo({ [FILE]: hypothesisPage() })
    writeProjectFile(project, FILE, hypothesisPage({ fields: { status: "draft", strength: "surface" } }))

    const { output } = await commit(project, [FILE])

    expect(output.ok).toBe(true)
    expect(output.sha).toBe(head(project))
  })

  describe("commits under the shared git lock", () => {
    it("commits under the shared git lock", async () => {
      const project = makeRepo()
      writeProjectFile(project, FILE, hypothesisPage())
      // post-commit runs inside git, so it sees whether the lock file exists.
      const hook = join(project, ".git/hooks/post-commit")
      mkdirSync(dirname(hook), { recursive: true })
      writeFileSync(hook, "#!/bin/sh\ncp .llm-wiki/git.lock .git/lock-seen-by-commit\n")
      chmodSync(hook, 0o755)

      const { output } = await commit(project, [FILE])

      expect(output.ok).toBe(true)
      expect(JSON.parse(readFileSync(join(project, ".git/lock-seen-by-commit"), "utf8")).tool).toBe("wiki-tool")
      expect(existsSync(join(project, ".llm-wiki", "git.lock"))).toBe(false)
      expect(commitPathsLocked).toHaveBeenCalledTimes(1)
    })

    it("says that another tool is using git, and commits nothing", async () => {
      const project = makeRepo()
      writeProjectFile(project, FILE, hypothesisPage())
      const before = commitCount(project)
      vi.mocked(commitPathsLocked).mockRejectedValueOnce(new Error(GIT_LOCK_BUSY_MESSAGE))

      const { exitCode, output } = await commit(project, [FILE])

      expect(exitCode).toBe(2)
      expect(output).toEqual({ ok: false, problems: [GIT_LOCK_BUSY_MESSAGE] })
      expect(commitCount(project)).toBe(before)
    })

    it("does not hide another error as a handled problem", async () => {
      const project = makeRepo()
      writeProjectFile(project, FILE, hypothesisPage())
      vi.mocked(commitPathsLocked).mockRejectedValueOnce(new Error("disk is full"))

      const { exitCode, output } = await commit(project, [FILE])

      expect(exitCode).toBe(1)
      expect(output.problems?.join("\n")).toMatch(/disk is full/)
    })

    it("gives the helper the project, the paths, and the message", async () => {
      const project = makeRepo()
      writeProjectFile(project, FILE, hypothesisPage())

      await commit(project, [FILE])

      expect(commitPathsLocked).toHaveBeenCalledWith(project, [FILE], `fuse: ${TITLE} (1 pages)\n\n- ${FILE}`)
    })
  })

  describe("refuses", () => {
    it("refuses a failing page", async () => {
      const project = makeRepo()
      writeProjectFile(project, FILE, hypothesisPage({ fields: { strength: null }, sections: { gaps: null } }))
      const before = head(project)

      const { exitCode, output } = await commit(project, [FILE])

      expect(exitCode).toBe(2)
      expect(output.ok).toBe(false)
      expect(output.problems?.every((problem) => problem.startsWith(`${FILE}: `))).toBe(true)
      expect(output.problems?.join("\n")).toMatch(/strength/)
      expect(output.problems?.join("\n")).toMatch(/Gaps and impact/)
      expect(head(project)).toBe(before)
      expect(git(project, "status", "--porcelain", "--untracked-files=all").trim()).toBe(`?? ${FILE}`)
      expect(commitPathsLocked).not.toHaveBeenCalled()
    })

    it("refuses the whole commit when one of two pages fails", async () => {
      const project = makeRepo()
      writeProjectFile(project, FILE, hypothesisPage())
      writeProjectFile(project, OTHER_FILE, hypothesisPage({ sections: { verify: verifyTable([["A claim", "Records", ""]]) } }))
      const before = head(project)

      const { exitCode, output } = await commit(project, [FILE, OTHER_FILE])

      expect(exitCode).toBe(2)
      expect(output.problems?.every((problem) => problem.startsWith(`${OTHER_FILE}: `))).toBe(true)
      expect(head(project)).toBe(before)
    })

    it("refuses a listed hypothesis that is not there", async () => {
      const project = makeRepo()

      const { exitCode, output } = await commit(project, [FILE])

      expect(exitCode).toBe(2)
      expect(output.problems?.join("\n")).toMatch(/cannot read/)
    })

    it("refuses a file outside the project", async () => {
      const project = makeRepo()

      const { exitCode, output } = await commit(project, ["../outside.md"])

      expect(exitCode).toBe(2)
      expect(output.problems?.join("\n")).toMatch(/outside the project/)
      expect(commitPathsLocked).not.toHaveBeenCalled()
    })

    it("refuses a folder, so no page goes in unchecked", async () => {
      const project = makeRepo()
      writeProjectFile(project, FILE, hypothesisPage({ fields: { strength: null } }))

      const { exitCode, output } = await commit(project, ["wiki"])

      expect(exitCode).toBe(2)
      expect(output.problems?.join("\n")).toMatch(/folder/)
      expect(commitPathsLocked).not.toHaveBeenCalled()
    })

    it("refuses a path under .llm-wiki/", async () => {
      const project = makeRepo()
      writeProjectFile(project, ".llm-wiki/secret.json", "{}")

      const { exitCode, output } = await commit(project, [".llm-wiki/secret.json"])

      expect(exitCode).toBe(2)
      expect(output.problems?.join("\n")).toMatch(/never committed/)
      expect(git(project, "ls-files", ".llm-wiki").trim()).toBe("")
    })

    it("checks a page of the folder written in other letter case", async () => {
      const project = makeRepo()
      writeProjectFile(project, FILE, hypothesisPage({ fields: { strength: null } }))

      const { exitCode } = await commit(project, ["Wiki/Hypotheses/threshold-restocking.md"])

      // On a case-sensitive disk the file is not there; on another disk it is there and fails the check. Either way
      // nothing is committed.
      expect(exitCode).toBe(2)
    })

    it("refuses while a merge is in progress", async () => {
      const project = makeRepo()
      writeProjectFile(project, FILE, hypothesisPage())
      writeFileSync(join(project, ".git", "MERGE_HEAD"), `${head(project)}\n`)
      const before = commitCount(project)

      const { exitCode, output } = await commit(project, [FILE])

      expect(exitCode).toBe(2)
      expect(output.problems?.join("\n")).toMatch(/merge/)
      expect(commitCount(project)).toBe(before)
    })

    it("refuses a project that is not a git repository", async () => {
      const project = makeWiki()
      writeProjectFile(project, FILE, hypothesisPage())

      const { exitCode, output } = await commit(project, [FILE])

      expect(exitCode).toBe(2)
      expect(output.ok).toBe(false)
    })
  })

  describe("arguments", () => {
    it("requires --project, --title, and a --file", async () => {
      const result = await runCli(["fuse", "commit"])
      expect(result.exitCode).toBe(2)
      const text = (result.output.problems as string[]).join("\n")
      expect(text).toMatch(/--project/)
      expect(text).toMatch(/--title/)
      expect(text).toMatch(/--file/)
    })

    it("refuses an empty title", async () => {
      const project = makeRepo()
      writeProjectFile(project, FILE, hypothesisPage())

      const { exitCode, output } = await commit(project, [FILE], "   ")

      expect(exitCode).toBe(2)
      expect(output.problems?.join("\n")).toMatch(/--title/)
    })

    it("refuses a project folder that is not there", async () => {
      const project = makeRepo()

      const { exitCode, output } = await commit(join(project, "missing"), [FILE])

      expect(exitCode).toBe(2)
      expect(output.problems?.join("\n")).toMatch(/project folder not found/)
    })

    it("rejects an option it does not know", async () => {
      const result = await runCli(["fuse", "commit", "--project", "p", "--title", "t", "--file", "f", "--bogus"])
      expect(result.exitCode).toBe(2)
    })
  })
})
