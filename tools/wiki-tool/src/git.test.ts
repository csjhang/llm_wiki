/**
 * git.test.ts - tests for commitPaths, the commit helper of wiki-tool.
 *
 * The tests run against real temporary git repositories. A repo has a local
 * identity unless a test says otherwise, so the tests do not depend on the git
 * config of the machine.
 */
import { execFileSync } from "node:child_process"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { commitPaths } from "./git"

const tempDirs: string[] = []

function makeDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "wiki-tool-git-"))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop() as string, { recursive: true, force: true })
  }
})

function git(repo: string, ...args: string[]): string {
  return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" })
}

function makeRepo(options: { identity?: boolean } = {}): string {
  const repo = makeDir()
  git(repo, "init", "--quiet")
  if (options.identity !== false) {
    git(repo, "config", "user.name", "Test User")
    git(repo, "config", "user.email", "test@example.com")
  }
  return repo
}

function write(repo: string, relativePath: string, text: string): void {
  const full = join(repo, relativePath)
  mkdirSync(dirname(full), { recursive: true })
  writeFileSync(full, text)
}

/** Write files, stage everything, and commit with a fixed identity. */
function commitAll(repo: string, subject: string, files: Record<string, string>): string {
  for (const [path, text] of Object.entries(files)) write(repo, path, text)
  git(repo, "add", "-A")
  execFileSync("git", ["-C", repo, "commit", "--quiet", "--no-verify", "-m", subject], {
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "T",
      GIT_AUTHOR_EMAIL: "t@example.com",
      GIT_COMMITTER_NAME: "T",
      GIT_COMMITTER_EMAIL: "t@example.com",
    },
  })
  return git(repo, "rev-parse", "HEAD").trim()
}

/** The files changed by HEAD, sorted. */
function headFiles(repo: string): string[] {
  return git(repo, "show", "--name-only", "--format=", "HEAD")
    .split("\n")
    .filter((line) => line !== "")
    .sort()
}

function commitCount(repo: string): number {
  return Number(git(repo, "rev-list", "--count", "HEAD").trim())
}

function expectSha(result: ReturnType<typeof commitPaths>, repo: string): void {
  expect(result.ok).toBe(true)
  if (!result.ok) return
  expect(result.sha).toMatch(/^[0-9a-f]{40}$/)
  expect(result.sha).toBe(git(repo, "rev-parse", "HEAD").trim())
}

function expectProblem(result: ReturnType<typeof commitPaths>, pattern: RegExp): void {
  expect(result.ok).toBe(false)
  if (result.ok) return
  expect(result.problem).toMatch(pattern)
}

/** A repo whose last commit holds `.gitignore`, `wiki/a.md`, and `wiki/b.md`. */
function makeCommittedRepo(): string {
  const repo = makeRepo()
  commitAll(repo, "chore: start", {
    ".gitignore": ".llm-wiki/\n",
    "wiki/a.md": "a committed\n",
    "wiki/b.md": "b committed\n",
  })
  return repo
}

describe("commitPaths", () => {
  it("commits only the listed paths and returns the new sha", () => {
    const repo = makeCommittedRepo()
    write(repo, "wiki/a.md", "a edited\n")
    write(repo, "wiki/new.md", "new page\n")
    write(repo, "wiki/b.md", "b edited by someone else\n")

    const result = commitPaths(repo, ["wiki/a.md", "wiki/new.md"], "fuse: a (2 pages)\n\n- wiki/a.md")

    expectSha(result, repo)
    expect(headFiles(repo)).toEqual(["wiki/a.md", "wiki/new.md"])
    expect(git(repo, "log", "-1", "--format=%B").trim()).toBe("fuse: a (2 pages)\n\n- wiki/a.md")
    expect(git(repo, "status", "--porcelain").trim()).toBe("M wiki/b.md")
  })

  it("returns a null sha and adds no commit when the paths did not change", () => {
    const repo = makeCommittedRepo()
    write(repo, "wiki/b.md", "b edited, but not listed\n")
    const before = commitCount(repo)

    expect(commitPaths(repo, ["wiki/a.md"], "fuse: nothing")).toEqual({ ok: true, sha: null })
    expect(commitPaths(repo, ["wiki/never-written.md"], "fuse: nothing")).toEqual({ ok: true, sha: null })
    expect(commitPaths(repo, [], "fuse: nothing")).toEqual({ ok: true, sha: null })

    expect(commitCount(repo)).toBe(before)
    expect(git(repo, "status", "--porcelain").trim()).toBe("M wiki/b.md")
  })

  it("records a deleted path", () => {
    const repo = makeCommittedRepo()
    rmSync(join(repo, "wiki/b.md"))

    expectSha(commitPaths(repo, ["wiki/b.md"], "recut: drop b"), repo)

    expect(git(repo, "ls-files")).not.toContain("wiki/b.md")
    expect(headFiles(repo)).toEqual(["wiki/b.md"])
  })

  it("records a deletion that is already staged", () => {
    const repo = makeCommittedRepo()
    git(repo, "rm", "--quiet", "wiki/b.md")

    expectSha(commitPaths(repo, ["wiki/b.md"], "recut: drop b"), repo)

    expect(headFiles(repo)).toEqual(["wiki/b.md"])
  })

  it("commits the new and changed files of a listed folder", () => {
    const repo = makeCommittedRepo()
    write(repo, "wiki/media/s/1.png", "one")
    write(repo, "wiki/media/s/deep/2.png", "two")
    write(repo, "wiki/media/other/x.png", "not listed")

    expectSha(commitPaths(repo, ["wiki/media/s/"], "ingest: media"), repo)

    expect(headFiles(repo)).toEqual(["wiki/media/s/1.png", "wiki/media/s/deep/2.png"])
  })

  it("commits the first commit of a repo that has none", () => {
    const repo = makeRepo()
    write(repo, "wiki/a.md", "a\n")
    write(repo, "wiki/b.md", "b\n")

    expectSha(commitPaths(repo, ["wiki/a.md"], "chore: first"), repo)

    expect(headFiles(repo)).toEqual(["wiki/a.md"])
  })

  it("skips missing, ignored, and empty-folder paths instead of failing", () => {
    const repo = makeCommittedRepo()
    write(repo, ".gitignore", ".llm-wiki/\nwiki/private/\n*.tmp\n")
    git(repo, "add", ".gitignore")
    git(repo, "commit", "--quiet", "--no-verify", "-m", "chore: ignore")
    write(repo, "wiki/a.md", "a edited\n")
    write(repo, "wiki/private/notes.md", "ignored")
    write(repo, "wiki/x.tmp", "ignored")
    mkdirSync(join(repo, "wiki/empty"))

    const result = commitPaths(
      repo,
      ["wiki/a.md", "wiki/missing.md", "wiki/private/notes.md", "wiki/x.tmp", "wiki/empty"],
      "ingest: a",
    )

    expectSha(result, repo)
    expect(headFiles(repo)).toEqual(["wiki/a.md"])
  })

  it("leaves other staged changes staged", () => {
    const repo = makeCommittedRepo()
    write(repo, "wiki/b.md", "b staged\n")
    git(repo, "add", "wiki/b.md")
    write(repo, "wiki/a.md", "a edited\n")

    expectSha(commitPaths(repo, ["wiki/a.md"], "ingest: a"), repo)

    expect(headFiles(repo)).toEqual(["wiki/a.md"])
    expect(git(repo, "diff", "--cached", "--name-only").trim()).toBe("wiki/b.md")
  })

  it("reads paths literally", () => {
    const repo = makeCommittedRepo()
    write(repo, "wiki/a.md", "a edited\n")
    write(repo, "wiki/*.md", "a page whose name is a glob\n")

    expectSha(commitPaths(repo, ["wiki/*.md"], "ingest: glob"), repo)

    expect(headFiles(repo)).toEqual(["wiki/*.md"])
    expect(git(repo, "status", "--porcelain").trim()).toBe("M wiki/a.md")
  })

  it("rejects unsafe paths before it changes anything", () => {
    const repo = makeCommittedRepo()
    write(repo, "wiki/a.md", "a edited\n")
    const before = commitCount(repo)

    for (const bad of ["", " ", ".", "./", "..", "../x", "/abs", "C:\\abs", "\\abs", ":(top)wiki/a.md", "wiki/../../x"]) {
      expectProblem(commitPaths(repo, ["wiki/a.md", bad], "ingest: a"), /invalid path/i)
    }

    expect(commitCount(repo)).toBe(before)
    expect(git(repo, "status", "--porcelain").trim()).toBe("M wiki/a.md")
  })

  it("reports a problem outside a git repository", () => {
    const dir = makeDir()
    write(dir, "wiki/a.md", "a\n")
    expectProblem(commitPaths(dir, ["wiki/a.md"], "ingest: a"), /git/i)
  })

  it("commits a project folder inside a larger repository and nothing outside it", () => {
    const outer = makeRepo()
    commitAll(outer, "chore: start", { "other/readme.md": "x\n", "my-wiki/wiki/seed.md": "seed\n" })
    const project = join(outer, "my-wiki")
    write(outer, "other/readme.md", "changed outside the project\n")
    write(project, "wiki/a.md", "a\n")

    expectSha(commitPaths(project, ["wiki/a.md"], "ingest: a"), outer)

    expect(headFiles(outer)).toEqual(["my-wiki/wiki/a.md"])
    expect(git(outer, "status", "--porcelain").trim()).toBe("M other/readme.md")
  })

  it("commitPaths never commits .llm-wiki", () => {
    const repo = makeRepo()
    // An older version of the app committed .llm-wiki, and the file is tracked.
    commitAll(repo, "chore: start", { ".llm-wiki/secret": "old key\n", "wiki/a.md": "a\n" })
    write(repo, ".llm-wiki/secret", "new key\n")
    write(repo, ".llm-wiki/cache/new.json", "{}\n")
    write(repo, "wiki/a.md", "a edited\n")
    const before = commitCount(repo)

    // Asking for it is refused, whatever the case of the folder name, and nothing is committed.
    for (const path of [".llm-wiki/secret", ".llm-wiki/", ".llm-wiki", ".LLM-WIKI/secret", ".git/config", "./.llm-wiki/cache/new.json"]) {
      expectProblem(commitPaths(repo, ["wiki/a.md", path], "ingest: a"), /never committed/)
    }
    expect(commitCount(repo)).toBe(before)

    // A normal commit leaves it out as well.
    expectSha(commitPaths(repo, ["wiki/a.md"], "ingest: a"), repo)
    expect(headFiles(repo)).toEqual(["wiki/a.md"])
    expect(git(repo, "show", "HEAD:.llm-wiki/secret")).toBe("old key\n")
    expect(git(repo, "status", "--porcelain")).toContain(".llm-wiki/")
  })

  it("commitPaths keeps .gitignore out unless listed", () => {
    const repo = makeCommittedRepo()
    write(repo, ".gitignore", ".llm-wiki/\nnode_modules/\n")
    write(repo, "wiki/a.md", "a edited\n")

    expectSha(commitPaths(repo, ["wiki/a.md"], "ingest: a"), repo)
    expect(headFiles(repo)).toEqual(["wiki/a.md"])
    expect(git(repo, "status", "--porcelain").trim()).toBe("M .gitignore")

    write(repo, "wiki/a.md", "a edited again\n")
    expectSha(commitPaths(repo, ["wiki/a.md", ".gitignore"], "chore: ignore"), repo)
    expect(headFiles(repo)).toEqual([".gitignore", "wiki/a.md"])
    expect(git(repo, "status", "--porcelain").trim()).toBe("")
  })

  it("does not write .gitignore itself", () => {
    const repo = makeRepo()
    write(repo, "wiki/a.md", "a\n")

    expectSha(commitPaths(repo, ["wiki/a.md"], "ingest: a"), repo)

    expect(existsSync(join(repo, ".gitignore"))).toBe(false)
  })

  describe("while another git operation is in progress", () => {
    it("commitPaths refuses during a merge", () => {
      const repo = makeRepo()
      commitAll(repo, "chore: base", { "wiki/a.md": "base\n" })
      const main = git(repo, "rev-parse", "--abbrev-ref", "HEAD").trim()
      git(repo, "checkout", "--quiet", "-b", "side")
      commitAll(repo, "side change", { "wiki/a.md": "side\n" })
      git(repo, "checkout", "--quiet", main)
      commitAll(repo, "main change", { "wiki/a.md": "main\n" })
      // A conflicting merge stops half way and leaves MERGE_HEAD.
      expect(() => git(repo, "merge", "--no-edit", "side")).toThrow()
      expect(existsSync(join(repo, ".git/MERGE_HEAD"))).toBe(true)
      write(repo, "wiki/other.md", "other\n")
      const head = git(repo, "rev-parse", "HEAD").trim()

      expectProblem(commitPaths(repo, ["wiki/other.md"], "ingest: other"), /merge/i)

      expect(git(repo, "rev-parse", "HEAD").trim()).toBe(head)
      expect(existsSync(join(repo, ".git/MERGE_HEAD"))).toBe(true)
    })

    it("refuses during a rebase, a cherry-pick, and a revert", () => {
      const cases: [string, boolean, RegExp][] = [
        ["MERGE_HEAD", false, /merge/i],
        ["REBASE_HEAD", false, /rebase/i],
        ["CHERRY_PICK_HEAD", false, /cherry-pick/i],
        ["REVERT_HEAD", false, /revert/i],
        ["rebase-merge", true, /rebase/i],
        ["rebase-apply", true, /rebase/i],
      ]
      for (const [marker, isFolder, pattern] of cases) {
        const repo = makeCommittedRepo()
        const head = git(repo, "rev-parse", "HEAD").trim()
        if (isFolder) mkdirSync(join(repo, ".git", marker))
        else writeFileSync(join(repo, ".git", marker), `${head}\n`)
        write(repo, "wiki/a.md", "a edited\n")

        expectProblem(commitPaths(repo, ["wiki/a.md"], "ingest: a"), pattern)

        expect(git(repo, "rev-parse", "HEAD").trim()).toBe(head)
      }
    })

    it("looks in the git folder of a linked work tree", () => {
      const repo = makeCommittedRepo()
      const linked = join(makeDir(), "linked")
      git(repo, "worktree", "add", "--quiet", "-b", "other", linked)
      const gitDir = git(linked, "rev-parse", "--absolute-git-dir").trim()
      writeFileSync(join(gitDir, "MERGE_HEAD"), `${git(linked, "rev-parse", "HEAD").trim()}\n`)
      write(linked, "wiki/a.md", "a edited\n")

      expectProblem(commitPaths(linked, ["wiki/a.md"], "ingest: a"), /merge/i)
    })
  })

  describe("commit flags", () => {
    it("ignores gpgsign and a failing pre-commit hook", () => {
      const repo = makeCommittedRepo()
      git(repo, "config", "commit.gpgsign", "true")
      git(repo, "config", "gpg.program", "false")
      const hook = join(repo, ".git/hooks/pre-commit")
      mkdirSync(dirname(hook), { recursive: true })
      writeFileSync(hook, "#!/bin/sh\necho 'hook says no' >&2\nexit 1\n")
      chmodSync(hook, 0o755)
      write(repo, "wiki/a.md", "a edited\n")

      expectSha(commitPaths(repo, ["wiki/a.md"], "ingest: a"), repo)
    })

    /** Run `fn` with no global or system git config and no identity in the environment. */
    function withNoGitConfig<T>(fn: () => T): T {
      const emptyHome = makeDir()
      const keys = [
        "HOME",
        "XDG_CONFIG_HOME",
        "GIT_CONFIG_NOSYSTEM",
        "GIT_CONFIG_GLOBAL",
        "GIT_AUTHOR_NAME",
        "GIT_AUTHOR_EMAIL",
        "GIT_COMMITTER_NAME",
        "GIT_COMMITTER_EMAIL",
        "EMAIL",
      ]
      const saved = keys.map((key) => [key, process.env[key]] as const)
      for (const key of keys) delete process.env[key]
      process.env.HOME = emptyHome
      process.env.XDG_CONFIG_HOME = emptyHome
      process.env.GIT_CONFIG_NOSYSTEM = "1"
      try {
        return fn()
      } finally {
        for (const [key, value] of saved) {
          if (value === undefined) delete process.env[key]
          else process.env[key] = value
        }
      }
    }

    function identityOfHead(repo: string): string {
      const author = git(repo, "log", "-1", "--format=%an <%ae>").trim()
      expect(git(repo, "log", "-1", "--format=%cn <%ce>").trim()).toBe(author)
      return author
    }

    function commitWithConfig(config: Record<string, string>): { repo: string; identity: string } {
      const repo = makeRepo({ identity: false })
      for (const [key, value] of Object.entries(config)) git(repo, "config", key, value)
      write(repo, "wiki/a.md", "a\n")
      const result = withNoGitConfig(() => commitPaths(repo, ["wiki/a.md"], "ingest: a"))
      expectSha(result, repo)
      return { repo, identity: identityOfHead(repo) }
    }

    it("commitPaths uses fallback identity per missing field", () => {
      expect(commitWithConfig({}).identity).toBe("LLM Wiki <llm-wiki@localhost>")
      expect(commitWithConfig({ "user.name": "Custom Name" }).identity).toBe("Custom Name <llm-wiki@localhost>")
      expect(commitWithConfig({ "user.email": "custom@example.com" }).identity).toBe("LLM Wiki <custom@example.com>")
      expect(commitWithConfig({ "user.name": "Custom Name", "user.email": "custom@example.com" }).identity).toBe(
        "Custom Name <custom@example.com>",
      )
    })

    it("never writes the fallback identity to the git config", () => {
      const { repo } = commitWithConfig({})
      expect(readFileSync(join(repo, ".git", "config"), "utf8")).not.toContain("llm-wiki@localhost")
    })
  })
})
