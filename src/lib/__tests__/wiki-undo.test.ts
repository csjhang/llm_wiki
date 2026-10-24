/**
 * wiki-undo.test.ts — tests for the wiki-undo skill script.
 *
 * Imports plugins/llm-wiki/skills/wiki-undo/scripts/undo.mjs and runs it
 * against real temporary git repositories. Each repo has a local identity, so
 * the tests do not depend on the git config of the machine.
 */
import { execFileSync, spawn, spawnSync } from "node:child_process"
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs"
import { hostname, tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, beforeAll, describe, expect, it } from "vitest"

const SCRIPT_PATH = fileURLToPath(
  new URL("../../../plugins/llm-wiki/skills/wiki-undo/scripts/undo.mjs", import.meta.url),
)

interface Action {
  sha: string
  subject: string
  date: string
}

type RevertResult =
  | { ok: true; sha: string; reverted: string }
  | { ok: false; reason: "conflict"; files: string[] }
  | { ok: false; reason: "not-action" | "dirty" | "not-a-wiki-project" | "protected" }
  | { ok: false; reason: "busy"; message: string }

interface UndoModule {
  ACTION_PREFIXES: string[]
  GENERATED_PATHS: string[]
  listActions: (projectPath: string, limit?: number) => Action[]
  revertAction: (
    projectPath: string,
    sha: string,
    today?: string,
    options?: { lockWaitMs?: number; lockStaleMs?: number },
  ) => RevertResult
}

let undo: UndoModule

beforeAll(async () => {
  undo = (await import(/* @vite-ignore */ SCRIPT_PATH)) as UndoModule
})

const created: string[] = []

afterEach(() => {
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function git(repo: string, ...args: string[]): string {
  return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" })
}

function makeDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "wiki-undo-"))
  created.push(dir)
  return dir
}

function makeRepo(options: { identity?: boolean } = {}): string {
  const repo = makeDir()
  git(repo, "init", "--quiet")
  git(repo, "config", "commit.gpgsign", "false")
  // A project folder has a wiki/ folder. Git does not track an empty folder.
  mkdirSync(join(repo, "wiki"))
  if (options.identity !== false) {
    git(repo, "config", "user.name", "Test User")
    git(repo, "config", "user.email", "test@example.com")
  }
  return repo
}

function write(repo: string, relativePath: string, content: string): void {
  const full = join(repo, relativePath)
  mkdirSync(dirname(full), { recursive: true })
  writeFileSync(full, content)
}

function read(repo: string, relativePath: string): string {
  return readFileSync(join(repo, relativePath), "utf8")
}

/** Write files, stage everything, and commit. Returns the full sha. */
function commitFiles(repo: string, subject: string, files: Record<string, string>): string {
  for (const [path, content] of Object.entries(files)) write(repo, path, content)
  git(repo, "add", "-A")
  git(repo, "commit", "--quiet", "--no-verify", "-m", subject)
  return git(repo, "rev-parse", "HEAD").trim()
}

/** The result of a good undo: the new undo commit is HEAD, and `reverted` is the commit that was undone. */
function expectUndone(result: RevertResult, dir: string, reverted: string): void {
  expect(result).toEqual({ ok: true, sha: git(dir, "rev-parse", "HEAD").trim(), reverted })
}

function headSubject(repo: string): string {
  return git(repo, "log", "-1", "--format=%s").trim()
}

describe("constants", () => {
  it("exports the action prefixes and the generated paths", () => {
    expect(undo.ACTION_PREFIXES).toEqual(["ingest:", "fuse:", "recut:", "lint:", "undo:"])
    expect(undo.GENERATED_PATHS).toEqual(["wiki/index.md", "wiki/log.md", "wiki/overview.md"])
  })
})

describe("listActions", () => {
  it("lists only action commits newest first", () => {
    const repo = makeRepo()
    commitFiles(repo, "chore: x", { "a.txt": "1" })
    const ingest = commitFiles(repo, "ingest: a (1 pages)", { "wiki/concepts/a.md": "a" })
    const fuse = commitFiles(repo, "fuse: b (1 pages)", { "wiki/concepts/b.md": "b" })
    commitFiles(repo, "chore: save changes before ingest", { "c.txt": "c" })

    const actions = undo.listActions(repo)
    expect(actions.map((action) => action.subject)).toEqual([
      "fuse: b (1 pages)",
      "ingest: a (1 pages)",
    ])
    expect(actions.map((action) => action.sha)).toEqual([fuse, ingest])
    expect(actions[0].date).toMatch(/^\d{4}-\d{2}-\d{2}/)
  })

  it("respects the limit", () => {
    const repo = makeRepo()
    for (let i = 1; i <= 5; i++) {
      commitFiles(repo, `ingest: n${i} (1 pages)`, { [`wiki/concepts/n${i}.md`]: String(i) })
    }
    expect(undo.listActions(repo, 2).map((action) => action.subject)).toEqual([
      "ingest: n5 (1 pages)",
      "ingest: n4 (1 pages)",
    ])
    expect(undo.listActions(repo)).toHaveLength(5)
  })

  it("returns an empty list for a repo with no commits", () => {
    expect(undo.listActions(makeRepo())).toEqual([])
  })

  it("does not list a commit only because its body has an action line", () => {
    const repo = makeRepo()
    commitFiles(repo, "chore: y\n\ningest: not a subject", { "a.txt": "1" })
    expect(undo.listActions(repo)).toEqual([])
  })

  it("does not list merge commits", () => {
    const repo = makeRepo()
    commitFiles(repo, "chore: base", { "a.txt": "1" })
    git(repo, "checkout", "--quiet", "-b", "side")
    commitFiles(repo, "side work", { "b.txt": "2" })
    git(repo, "checkout", "--quiet", "-")
    commitFiles(repo, "main work", { "c.txt": "3" })
    git(repo, "merge", "--quiet", "--no-ff", "-m", "ingest: merged (1 pages)", "side")
    expect(undo.listActions(repo)).toEqual([])
  })
})

describe("revertAction", () => {
  it("reverts a simple ingest", () => {
    const repo = makeRepo()
    commitFiles(repo, "chore: base", { "wiki/log.md": "# Log\n" })
    const sha = commitFiles(repo, "ingest: a (1 pages)", {
      "wiki/concepts/a.md": "a\n",
      "wiki/log.md": "# Log\n\n## [2026-01-01] ingest | a\n",
    })

    const result = undo.revertAction(repo, sha, "2026-02-03")

    expectUndone(result, repo, sha)
    expect(existsSync(join(repo, "wiki/concepts/a.md"))).toBe(false)
    expect(headSubject(repo)).toBe("undo: ingest: a (1 pages)")
    expect(git(repo, "log", "-1", "--format=%b").trim()).toBe(`Reverts ${sha}.`)
    // The log is append-only history. The ingest line stays, and the undo line follows it.
    expect(read(repo, "wiki/log.md")).toBe(
      "# Log\n\n## [2026-01-01] ingest | a\n## [2026-02-03] undo | ingest: a (1 pages)\n",
    )
    expect(git(repo, "status", "--porcelain")).toBe("")
  })

  it("accepts a short sha and the undo commit appears in the list", () => {
    const repo = makeRepo()
    commitFiles(repo, "chore: base", { "a.txt": "1" })
    const sha = commitFiles(repo, "lint: fix (1 pages)", { "wiki/concepts/a.md": "a\n" })

    const result = undo.revertAction(repo, sha.slice(0, 8), "2026-02-03")

    expectUndone(result, repo, sha)
    expect(undo.listActions(repo)[0].subject).toBe("undo: lint: fix (1 pages)")
  })

  it("keeps the log entry of a reverted commit that created wiki/log.md", () => {
    const repo = makeRepo()
    commitFiles(repo, "chore: base", { "a.txt": "1" })
    const sha = commitFiles(repo, "ingest: a (1 pages)", {
      "wiki/concepts/a.md": "a\n",
      "wiki/log.md": "## [2026-01-01] ingest | a\n",
    })

    expectUndone(undo.revertAction(repo, sha, "2026-02-03"), repo, sha)

    expect(existsSync(join(repo, "wiki/concepts/a.md"))).toBe(false)
    expect(read(repo, "wiki/log.md")).toBe(
      "## [2026-01-01] ingest | a\n## [2026-02-03] undo | ingest: a (1 pages)\n",
    )
    expect(git(repo, "status", "--porcelain")).toBe("")
  })

  it("creates wiki/log.md with only the undo line when the current commit has none", () => {
    const repo = makeRepo()
    commitFiles(repo, "chore: base", { "a.txt": "1" })
    const sha = commitFiles(repo, "ingest: a (1 pages)", { "wiki/concepts/a.md": "a\n" })

    expectUndone(undo.revertAction(repo, sha, "2026-02-03"), repo, sha)

    expect(read(repo, "wiki/log.md")).toBe("## [2026-02-03] undo | ingest: a (1 pages)\n")
    expect(git(repo, "status", "--porcelain")).toBe("")
  })

  it("does not lose log lines when the revert would remove them cleanly", () => {
    const repo = makeRepo()
    commitFiles(repo, "chore: base", { "wiki/log.md": "# Log\n\n## [2026-01-01] ingest | old\n\n" })
    const shaA = commitFiles(repo, "ingest: a (1 pages)", {
      "wiki/concepts/a.md": "a\n",
      "wiki/log.md": "# Log\n\n## [2026-01-01] ingest | old\n\n## [2026-01-02] ingest | a\n",
    })
    commitFiles(repo, "chore: notes", { "notes.txt": "n\n" })

    expectUndone(undo.revertAction(repo, shaA, "2026-02-03"), repo, shaA)

    const log = read(repo, "wiki/log.md")
    expect(log).toContain("## [2026-01-01] ingest | old")
    expect(log).toContain("## [2026-01-02] ingest | a")
    expect(log.trimEnd().split("\n").pop()).toBe("## [2026-02-03] undo | ingest: a (1 pages)")
  })

  it("resolves generated-file conflicts", () => {
    const repo = makeRepo()
    commitFiles(repo, "chore: base", {
      "wiki/index.md": "# Index\n\n- page-0\n",
      "wiki/log.md": "# Log\n",
    })
    const shaA = commitFiles(repo, "ingest: a (1 pages)", {
      "wiki/concepts/a.md": "a\n",
      "wiki/index.md": "# Index\n\n- page-0\n- a\n",
      "wiki/log.md": "# Log\n\n## [2026-01-01] ingest | a\n",
    })
    commitFiles(repo, "ingest: b (1 pages)", {
      "wiki/concepts/b.md": "b\n",
      "wiki/index.md": "# Index\n\n- page-0\n- a\n- b\n",
      "wiki/log.md": "# Log\n\n## [2026-01-01] ingest | a\n## [2026-01-02] ingest | b\n",
    })
    const indexBefore = read(repo, "wiki/index.md")

    const result = undo.revertAction(repo, shaA, "2026-02-03")

    expectUndone(result, repo, shaA)
    expect(existsSync(join(repo, "wiki/concepts/a.md"))).toBe(false)
    expect(existsSync(join(repo, "wiki/concepts/b.md"))).toBe(true)
    expect(read(repo, "wiki/index.md")).toBe(indexBefore)
    const log = read(repo, "wiki/log.md")
    expect(log).not.toContain("<<<<<<<")
    // The log is append-only history: both ingest entries survive.
    expect(log).toContain("## [2026-01-01] ingest | a")
    expect(log).toContain("## [2026-01-02] ingest | b")
    expect(log.trimEnd().split("\n").pop()).toBe("## [2026-02-03] undo | ingest: a (1 pages)")
    expect(headSubject(repo)).toBe("undo: ingest: a (1 pages)")
    expect(git(repo, "status", "--porcelain")).toBe("")
  })

  it("resolves conflicts under wiki/indexes/ and in wiki/overview.md", () => {
    const repo = makeRepo()
    commitFiles(repo, "chore: base", {
      "wiki/indexes/_mechanisms.md": "- m0\n",
      "wiki/overview.md": "overview 0\n",
    })
    const shaA = commitFiles(repo, "ingest: a (1 pages)", {
      "wiki/concepts/a.md": "a\n",
      "wiki/indexes/_mechanisms.md": "- m0\n- ma\n",
      "wiki/overview.md": "overview 0\noverview a\n",
    })
    commitFiles(repo, "ingest: b (1 pages)", {
      "wiki/indexes/_mechanisms.md": "- m0\n- ma\n- mb\n",
      "wiki/overview.md": "overview 0\noverview a\noverview b\n",
    })

    expectUndone(undo.revertAction(repo, shaA, "2026-02-03"), repo, shaA)

    expect(read(repo, "wiki/indexes/_mechanisms.md")).toBe("- m0\n- ma\n- mb\n")
    expect(read(repo, "wiki/overview.md")).toBe("overview 0\noverview a\noverview b\n")
    expect(git(repo, "status", "--porcelain")).toBe("")
  })

  it("keeps a generated file deleted when the current version has no such file", () => {
    const repo = makeRepo()
    commitFiles(repo, "chore: base", { "wiki/overview.md": "overview 0\n" })
    const shaA = commitFiles(repo, "ingest: a (1 pages)", {
      "wiki/concepts/a.md": "a\n",
      "wiki/overview.md": "overview a\n",
    })
    git(repo, "rm", "--quiet", "wiki/overview.md")
    git(repo, "commit", "--quiet", "--no-verify", "-m", "chore: drop overview")

    expectUndone(undo.revertAction(repo, shaA, "2026-02-03"), repo, shaA)

    expect(existsSync(join(repo, "wiki/overview.md"))).toBe(false)
    expect(existsSync(join(repo, "wiki/concepts/a.md"))).toBe(false)
    expect(git(repo, "status", "--porcelain")).toBe("")
  })

  it("reverts a root commit that has an action prefix", () => {
    const repo = makeRepo()
    const root = commitFiles(repo, "ingest: first (1 pages)", { "wiki/concepts/a.md": "a\n" })
    commitFiles(repo, "chore: x", { "other.txt": "1" })

    expectUndone(undo.revertAction(repo, root, "2026-02-03"), repo, root)

    expect(existsSync(join(repo, "wiki/concepts/a.md"))).toBe(false)
    expect(existsSync(join(repo, "other.txt"))).toBe(true)
    expect(headSubject(repo)).toBe("undo: ingest: first (1 pages)")
  })

  it("aborts on content conflict", () => {
    const repo = makeRepo()
    commitFiles(repo, "chore: base", { "wiki/log.md": "# Log\n" })
    const shaA = commitFiles(repo, "ingest: a (1 pages)", {
      "wiki/concepts/x.md": "one\ntwo\nthree\n",
    })
    const shaB = commitFiles(repo, "ingest: b (1 pages)", {
      "wiki/concepts/x.md": "one\ntwo changed\nthree\n",
    })

    const result = undo.revertAction(repo, shaA, "2026-02-03")

    expect(result).toEqual({ ok: false, reason: "conflict", files: ["wiki/concepts/x.md"] })
    expect(git(repo, "status", "--porcelain")).toBe("")
    expect(git(repo, "rev-parse", "HEAD").trim()).toBe(shaB)
    expect(read(repo, "wiki/concepts/x.md")).toBe("one\ntwo changed\nthree\n")
  })

  it("aborts when two actions edit the same lines of a page", () => {
    const repo = makeRepo()
    commitFiles(repo, "chore: base", { "wiki/concepts/x.md": "one\ntwo\nthree\n" })
    const shaA = commitFiles(repo, "ingest: a (1 pages)", {
      "wiki/concepts/x.md": "one\ntwo A\nthree\n",
    })
    const shaB = commitFiles(repo, "ingest: b (1 pages)", {
      "wiki/concepts/x.md": "one\ntwo B\nthree\n",
    })

    const result = undo.revertAction(repo, shaA, "2026-02-03")

    expect(result).toEqual({ ok: false, reason: "conflict", files: ["wiki/concepts/x.md"] })
    expect(git(repo, "status", "--porcelain")).toBe("")
    expect(git(repo, "rev-parse", "HEAD").trim()).toBe(shaB)
  })

  it("lists only the content files when generated files conflict too", () => {
    const repo = makeRepo()
    commitFiles(repo, "chore: base", { "wiki/index.md": "- p0\n" })
    const shaA = commitFiles(repo, "ingest: a (1 pages)", {
      "wiki/concepts/x.md": "one\ntwo\nthree\n",
      "wiki/index.md": "- p0\n- a\n",
    })
    commitFiles(repo, "ingest: b (1 pages)", {
      "wiki/concepts/x.md": "one\ntwo changed\nthree\n",
      "wiki/index.md": "- p0\n- a\n- b\n",
    })

    expect(undo.revertAction(repo, shaA, "2026-02-03")).toEqual({
      ok: false,
      reason: "conflict",
      files: ["wiki/concepts/x.md"],
    })
    expect(git(repo, "status", "--porcelain")).toBe("")
    expect(read(repo, "wiki/index.md")).toBe("- p0\n- a\n- b\n")
  })

  it("refuses a non-action commit", () => {
    const repo = makeRepo()
    const sha = commitFiles(repo, "chore: save changes before ingest", { "a.txt": "1" })
    commitFiles(repo, "ingest: a (1 pages)", { "wiki/concepts/a.md": "a\n" })
    const head = git(repo, "rev-parse", "HEAD").trim()

    expect(undo.revertAction(repo, sha, "2026-02-03")).toEqual({ ok: false, reason: "not-action" })
    expect(git(repo, "rev-parse", "HEAD").trim()).toBe(head)
    expect(git(repo, "status", "--porcelain")).toBe("")
  })

  it("refuses a sha that is not a commit", () => {
    const repo = makeRepo()
    commitFiles(repo, "ingest: a (1 pages)", { "wiki/concepts/a.md": "a\n" })

    expect(undo.revertAction(repo, "deadbeef", "2026-02-03")).toEqual({ ok: false, reason: "not-action" })
    expect(undo.revertAction(repo, "--abort", "2026-02-03")).toEqual({ ok: false, reason: "not-action" })
  })

  it("refuses a merge commit even with an action prefix", () => {
    const repo = makeRepo()
    commitFiles(repo, "chore: base", { "a.txt": "1" })
    git(repo, "checkout", "--quiet", "-b", "side")
    commitFiles(repo, "side work", { "b.txt": "2" })
    git(repo, "checkout", "--quiet", "-")
    commitFiles(repo, "main work", { "c.txt": "3" })
    git(repo, "merge", "--quiet", "--no-ff", "-m", "ingest: merged (1 pages)", "side")
    const merge = git(repo, "rev-parse", "HEAD").trim()

    expect(undo.revertAction(repo, merge, "2026-02-03")).toEqual({ ok: false, reason: "not-action" })
    expect(git(repo, "status", "--porcelain")).toBe("")
  })

  it("refuses a root commit that has no action prefix", () => {
    const repo = makeRepo()
    const root = commitFiles(repo, "chore: start version history", { ".gitignore": ".llm-wiki/\n" })
    commitFiles(repo, "ingest: a (1 pages)", { "wiki/concepts/a.md": "a\n" })

    expect(undo.revertAction(repo, root, "2026-02-03")).toEqual({ ok: false, reason: "not-action" })
  })

  it("refuses a dirty tree", () => {
    const repo = makeRepo()
    const sha = commitFiles(repo, "ingest: a (1 pages)", { "wiki/concepts/a.md": "a\n" })
    write(repo, "wiki/concepts/a.md", "edited by hand\n")

    expect(undo.revertAction(repo, sha, "2026-02-03")).toEqual({ ok: false, reason: "dirty" })
    expect(read(repo, "wiki/concepts/a.md")).toBe("edited by hand\n")
    expect(headSubject(repo)).toBe("ingest: a (1 pages)")
  })

  it("refuses a tree with an untracked file or a staged file", () => {
    const repo = makeRepo()
    const sha = commitFiles(repo, "ingest: a (1 pages)", { "wiki/concepts/a.md": "a\n" })

    write(repo, "wiki/concepts/new.md", "new\n")
    expect(undo.revertAction(repo, sha, "2026-02-03")).toEqual({ ok: false, reason: "dirty" })

    rmSync(join(repo, "wiki/concepts/new.md"))
    write(repo, "notes.txt", "staged\n")
    git(repo, "add", "notes.txt")
    expect(undo.revertAction(repo, sha, "2026-02-03")).toEqual({ ok: false, reason: "dirty" })
  })

  it("ignores untracked files under .llm-wiki/", () => {
    const repo = makeRepo()
    const sha = commitFiles(repo, "ingest: a (1 pages)", { "wiki/concepts/a.md": "a\n" })
    write(repo, ".llm-wiki/cache/state.json", "{}\n")

    expectUndone(undo.revertAction(repo, sha, "2026-02-03"), repo, sha)

    expect(existsSync(join(repo, ".llm-wiki/cache/state.json"))).toBe(true)
    expect(git(repo, "show", "--name-only", "--format=", "HEAD")).not.toContain(".llm-wiki")
  })

  describe("the card map heptabase-map.json", () => {
    it("does not block a revert when it is untracked", () => {
      const repo = makeRepo()
      const sha = commitFiles(repo, "ingest: a (1 pages)", { "wiki/concepts/a.md": "a\n" })
      write(repo, "heptabase-map.json", '{ "version": 1 }\n')

      expectUndone(undo.revertAction(repo, sha, "2026-02-03"), repo, sha)

      expect(read(repo, "heptabase-map.json")).toBe('{ "version": 1 }\n')
      expect(git(repo, "show", "--name-only", "--format=", "HEAD")).not.toContain("heptabase-map.json")
    })

    it("does not block a revert when it is changed and not staged, and keeps the change", () => {
      const repo = makeRepo()
      commitFiles(repo, "chore: base", { "heptabase-map.json": '{ "pages": {} }\n' })
      const sha = commitFiles(repo, "ingest: a (1 pages)", { "wiki/concepts/a.md": "a\n" })
      write(repo, "heptabase-map.json", '{ "pages": { "wiki/a.md": {} } }\n')

      expectUndone(undo.revertAction(repo, sha, "2026-02-03"), repo, sha)

      expect(read(repo, "heptabase-map.json")).toBe('{ "pages": { "wiki/a.md": {} } }\n')
      expect(git(repo, "show", "--name-only", "--format=", "HEAD")).not.toContain("heptabase-map.json")
      // The change is still there, not staged and not committed.
      expect(git(repo, "status", "--porcelain").trimEnd()).toBe(" M heptabase-map.json")
    })

    it("does not block a revert inside a larger repository", () => {
      const outer = makeRepo()
      const project = join(outer, "my-wiki")
      commitFiles(outer, "chore: base", { "my-wiki/wiki/index.md": "- p0\n" })
      const sha = commitFiles(outer, "ingest: a (1 pages)", { "my-wiki/wiki/concepts/a.md": "a\n" })
      write(outer, "my-wiki/heptabase-map.json", "{}\n")

      expectUndone(undo.revertAction(project, sha, "2026-02-03"), project, sha)

      expect(read(outer, "my-wiki/heptabase-map.json")).toBe("{}\n")
    })

    it("still refuses a map that is staged: the undo commit would include it", () => {
      const repo = makeRepo()
      const sha = commitFiles(repo, "ingest: a (1 pages)", { "wiki/concepts/a.md": "a\n" })
      write(repo, "heptabase-map.json", "{}\n")
      git(repo, "add", "heptabase-map.json")

      expect(undo.revertAction(repo, sha, "2026-02-03")).toEqual({ ok: false, reason: "dirty" })
    })

    it("only ignores the map of the project, not another file with that name", () => {
      const repo = makeRepo()
      const sha = commitFiles(repo, "ingest: a (1 pages)", { "wiki/concepts/a.md": "a\n" })
      write(repo, "wiki/heptabase-map.json", "{}\n")

      expect(undo.revertAction(repo, sha, "2026-02-03")).toEqual({ ok: false, reason: "dirty" })
    })
  })

  describe("fallback identity", () => {
    /** A repo with one ingest commit. The commit has an identity. The repo config does not. */
    function makeRepoWithoutIdentity(): { repo: string; sha: string } {
      const repo = makeRepo({ identity: false })
      write(repo, "wiki/concepts/a.md", "a\n")
      execFileSync("git", ["-C", repo, "add", "-A"])
      execFileSync("git", ["-C", repo, "commit", "--quiet", "-m", "ingest: a (1 pages)"], {
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: "T",
          GIT_AUTHOR_EMAIL: "t@example.com",
          GIT_COMMITTER_NAME: "T",
          GIT_COMMITTER_EMAIL: "t@example.com",
        },
      })
      return { repo, sha: git(repo, "rev-parse", "HEAD").trim() }
    }

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

    function lastCommitIdentity(repo: string): string {
      const author = git(repo, "log", "-1", "--format=%an <%ae>")
      const committer = git(repo, "log", "-1", "--format=%cn <%ce>")
      expect(committer).toBe(author)
      return author.trim()
    }

    it("fills both name and email when git has neither", () => {
      const { repo, sha } = makeRepoWithoutIdentity()

      withNoGitConfig(() => expectUndone(undo.revertAction(repo, sha, "2026-02-03"), repo, sha))

      expect(lastCommitIdentity(repo)).toBe("LLM Wiki <llm-wiki@localhost>")
      // The undo never writes the fallback identity to the git config of the repo.
      expect(readFileSync(join(repo, ".git", "config"), "utf8")).not.toContain("llm-wiki@localhost")
    })

    it("fills only the email when the name is set", () => {
      const { repo, sha } = makeRepoWithoutIdentity()
      git(repo, "config", "user.name", "Custom Name")

      withNoGitConfig(() => expectUndone(undo.revertAction(repo, sha, "2026-02-03"), repo, sha))

      expect(lastCommitIdentity(repo)).toBe("Custom Name <llm-wiki@localhost>")
    })

    it("fills only the name when the email is set", () => {
      const { repo, sha } = makeRepoWithoutIdentity()
      git(repo, "config", "user.email", "custom@example.com")

      withNoGitConfig(() => expectUndone(undo.revertAction(repo, sha, "2026-02-03"), repo, sha))

      expect(lastCommitIdentity(repo)).toBe("LLM Wiki <custom@example.com>")
    })

    it("keeps the identity of the user when both are set", () => {
      const { repo, sha } = makeRepoWithoutIdentity()
      git(repo, "config", "user.name", "Custom Name")
      git(repo, "config", "user.email", "custom@example.com")

      withNoGitConfig(() => expectUndone(undo.revertAction(repo, sha, "2026-02-03"), repo, sha))

      expect(lastCommitIdentity(repo)).toBe("Custom Name <custom@example.com>")
    })
  })

  it("works for a project folder inside a larger repository", () => {
    const outer = makeRepo()
    const project = join(outer, "my-wiki")
    commitFiles(outer, "chore: base", { "my-wiki/wiki/index.md": "- p0\n", "other/readme.md": "x\n" })
    const shaA = commitFiles(outer, "ingest: a (1 pages)", {
      "my-wiki/wiki/concepts/a.md": "a\n",
      "my-wiki/wiki/index.md": "- p0\n- a\n",
    })
    commitFiles(outer, "ingest: other (1 pages)", { "other/readme.md": "y\n" })
    commitFiles(outer, "ingest: b (1 pages)", {
      "my-wiki/wiki/concepts/b.md": "b\n",
      "my-wiki/wiki/index.md": "- p0\n- a\n- b\n",
    })

    // Only commits that touch the project are listed.
    expect(undo.listActions(project).map((action) => action.subject)).toEqual([
      "ingest: b (1 pages)",
      "ingest: a (1 pages)",
    ])

    expectUndone(undo.revertAction(project, shaA, "2026-02-03"), project, shaA)
    expect(existsSync(join(project, "wiki/concepts/a.md"))).toBe(false)
    expect(read(outer, "my-wiki/wiki/index.md")).toBe("- p0\n- a\n- b\n")
    expect(git(outer, "status", "--porcelain")).toBe("")
  })

  it("reports project-relative paths for a conflict inside a larger repository", () => {
    const outer = makeRepo()
    const project = join(outer, "my-wiki")
    commitFiles(outer, "chore: base", { "my-wiki/wiki/log.md": "# Log\n" })
    const shaA = commitFiles(outer, "ingest: a (1 pages)", { "my-wiki/wiki/concepts/x.md": "one\ntwo\n" })
    commitFiles(outer, "ingest: b (1 pages)", { "my-wiki/wiki/concepts/x.md": "one\ntwo changed\n" })

    expect(undo.revertAction(project, shaA, "2026-02-03")).toEqual({
      ok: false,
      reason: "conflict",
      files: ["wiki/concepts/x.md"],
    })
    expect(git(outer, "status", "--porcelain")).toBe("")
  })

  it("can undo an undo", () => {
    const repo = makeRepo()
    commitFiles(repo, "chore: base", { "a.txt": "1" })
    const sha = commitFiles(repo, "ingest: a (1 pages)", { "wiki/concepts/a.md": "a\n" })
    const first = undo.revertAction(repo, sha, "2026-02-03")
    expectUndone(first, repo, sha)
    const undoSha = undo.listActions(repo)[0].sha
    // `sha` of a good result is the new undo commit, the first item of the list.
    expect(first.ok && first.sha).toBe(undoSha)

    expectUndone(undo.revertAction(repo, undoSha, "2026-02-04"), repo, undoSha)

    expect(existsSync(join(repo, "wiki/concepts/a.md"))).toBe(true)
    expect(headSubject(repo)).toBe("undo: undo: ingest: a (1 pages)")
  })
})

describe("revertAction safety", () => {
  it("refuses a commit that is not in the history of HEAD", () => {
    const repo = makeRepo()
    commitFiles(repo, "chore: base", { "wiki/index.md": "# Index\n" })
    const main = git(repo, "rev-parse", "--abbrev-ref", "HEAD").trim()
    git(repo, "checkout", "--quiet", "-b", "side")
    const sideSha = commitFiles(repo, "ingest: side (1 pages)", { "wiki/concepts/side.md": "s\n" })
    git(repo, "checkout", "--quiet", main)
    const head = git(repo, "rev-parse", "HEAD").trim()

    expect(undo.revertAction(repo, sideSha, "2026-02-03")).toEqual({ ok: false, reason: "not-action" })
    expect(git(repo, "rev-parse", "HEAD").trim()).toBe(head)
    expect(git(repo, "status", "--porcelain")).toBe("")
  })

  it("refuses when a file outside a nested project is staged", () => {
    const outer = makeRepo()
    const project = join(outer, "my-wiki")
    mkdirSync(join(project, "wiki"), { recursive: true })
    commitFiles(outer, "chore: base", { "other/readme.md": "x\n" })
    const sha = commitFiles(outer, "ingest: a (1 pages)", { "my-wiki/wiki/concepts/a.md": "a\n" })
    write(outer, "other/readme.md", "staged edit\n")
    git(outer, "add", "other/readme.md")

    expect(undo.revertAction(project, sha, "2026-02-03")).toEqual({ ok: false, reason: "dirty" })
    expect(headSubject(outer)).toBe("ingest: a (1 pages)")
    expect(git(outer, "diff", "--cached", "--name-only").trim()).toBe("other/readme.md")
  })

  it("leaves a clean tree and the same HEAD when the commit fails after the log append", () => {
    const repo = makeRepo()
    commitFiles(repo, "chore: base", { "a.txt": "1" })
    const sha = commitFiles(repo, "ingest: a (1 pages)", { "wiki/concepts/a.md": "a\n" })
    const head = git(repo, "rev-parse", "HEAD").trim()

    // A garbage author date makes `git commit` fail. The revert and the log append come before it.
    const saved = process.env.GIT_AUTHOR_DATE
    process.env.GIT_AUTHOR_DATE = "garbage"
    try {
      expect(() => undo.revertAction(repo, sha, "2026-02-03")).toThrow()
    } finally {
      if (saved === undefined) delete process.env.GIT_AUTHOR_DATE
      else process.env.GIT_AUTHOR_DATE = saved
    }

    expect(git(repo, "status", "--porcelain")).toBe("")
    expect(git(repo, "rev-parse", "HEAD").trim()).toBe(head)
    expect(existsSync(join(repo, "wiki/concepts/a.md"))).toBe(true)
    expect(existsSync(join(repo, "wiki/log.md"))).toBe(false)
  })
})

describe("revertAction never discards the card map", () => {
  it("keeps an uncommitted map when the undo fails halfway and the tree is put back", () => {
    const repo = makeRepo()
    commitFiles(repo, "chore: base", { "heptabase-map.json": '{ "pages": {} }\n' })
    const sha = commitFiles(repo, "ingest: a (1 pages)", { "wiki/concepts/a.md": "a\n" })
    const head = git(repo, "rev-parse", "HEAD").trim()
    write(repo, "heptabase-map.json", '{ "pages": { "wiki/a.md": {} } }\n')

    // A garbage author date makes `git commit` fail after the revert and the log append.
    const saved = process.env.GIT_AUTHOR_DATE
    process.env.GIT_AUTHOR_DATE = "garbage"
    try {
      expect(() => undo.revertAction(repo, sha, "2026-02-03")).toThrow()
    } finally {
      if (saved === undefined) delete process.env.GIT_AUTHOR_DATE
      else process.env.GIT_AUTHOR_DATE = saved
    }

    expect(git(repo, "rev-parse", "HEAD").trim()).toBe(head)
    expect(existsSync(join(repo, "wiki/concepts/a.md"))).toBe(true)
    expect(read(repo, "heptabase-map.json")).toBe('{ "pages": { "wiki/a.md": {} } }\n')
    expect(git(repo, "status", "--porcelain").trimEnd()).toBe(" M heptabase-map.json")
  })
})

describe("revertAction git lock", () => {
  const BUSY = "another wiki tool is using git"

  function lockFile(repo: string): string {
    return join(repo, ".llm-wiki", "git.lock")
  }

  /**
   * The pid defaults to this process, which is alive. The host and the platform default to this machine: a pid says
   * something only on the machine that wrote it.
   */
  function writeLock(
    repo: string,
    tool: string,
    startedAt: Date,
    pid: number = process.pid,
    where: { host?: string; platform?: string } = { host: hostname(), platform: process.platform },
  ): void {
    mkdirSync(join(repo, ".llm-wiki"), { recursive: true })
    writeFileSync(lockFile(repo), JSON.stringify({ pid, started_at: startedAt.toISOString(), tool, ...where }))
  }

  /** A repo with one undoable ingest commit. */
  function makeUndoableRepo(): { repo: string; sha: string } {
    const repo = makeRepo()
    commitFiles(repo, "chore: base", { "a.txt": "1" })
    return { repo, sha: commitFiles(repo, "ingest: a (1 pages)", { "wiki/concepts/a.md": "a\n" }) }
  }

  it("undo waits for the lock", () => {
    const { repo, sha } = makeUndoableRepo()
    writeLock(repo, "wiki-tool", new Date())
    // The undo blocks this process while it waits, so another process lets go of the lock.
    const holder = spawn(
      process.execPath,
      ["-e", "setTimeout(() => require('node:fs').rmSync(process.argv[1], { force: true }), 500)", lockFile(repo)],
      { stdio: "ignore" },
    )
    holder.unref()
    const head = git(repo, "rev-parse", "HEAD").trim()

    const started = Date.now()
    const result = undo.revertAction(repo, sha, "2026-02-03")
    const waited = Date.now() - started

    expectUndone(result, repo, sha)
    expect(waited).toBeGreaterThanOrEqual(400)
    expect(git(repo, "rev-parse", "HEAD~1").trim()).toBe(head)
    expect(existsSync(lockFile(repo))).toBe(false)
  })

  it("fails with the busy message when the lock stays taken, and changes nothing", () => {
    const { repo, sha } = makeUndoableRepo()
    writeLock(repo, "app", new Date())
    const head = git(repo, "rev-parse", "HEAD").trim()

    const started = Date.now()
    const result = undo.revertAction(repo, sha, "2026-02-03", { lockWaitMs: 400 })

    expect(result).toEqual({ ok: false, reason: "busy", message: BUSY })
    expect(Date.now() - started).toBeGreaterThanOrEqual(350)
    expect(git(repo, "rev-parse", "HEAD").trim()).toBe(head)
    expect(existsSync(join(repo, "wiki/concepts/a.md"))).toBe(true)
    // The lock of the other tool is still there.
    expect(JSON.parse(readFileSync(lockFile(repo), "utf8")).tool).toBe("app")
  })

  it("replaces a stale lock", () => {
    const { repo, sha } = makeUndoableRepo()
    writeLock(repo, "app", new Date(Date.now() - 11 * 60_000))

    expectUndone(undo.revertAction(repo, sha, "2026-02-03"), repo, sha)

    expect(existsSync(lockFile(repo))).toBe(false)
  })

  it("replaces at once a fresh lock whose process is gone", () => {
    const { repo, sha } = makeUndoableRepo()
    const exited = spawnSync(process.execPath, ["-e", "0"])
    writeLock(repo, "app", new Date(), exited.pid)

    const started = Date.now()
    expectUndone(undo.revertAction(repo, sha, "2026-02-03"), repo, sha)

    expect(Date.now() - started).toBeLessThan(2000)
    expect(existsSync(lockFile(repo))).toBe(false)
  })

  it("keeps a fresh lock of a dead pid that was written on another machine or another platform", () => {
    const exited = spawnSync(process.execPath, ["-e", "0"])
    const wrote = {
      "another host": { host: `${hostname()}-other`, platform: process.platform },
      "another platform": { host: hostname(), platform: process.platform === "linux" ? "win32" : "linux" },
      "no host": { platform: process.platform },
      "no platform": { host: hostname() },
      neither: {},
    }
    for (const [name, where] of Object.entries(wrote)) {
      const { repo, sha } = makeUndoableRepo()
      writeLock(repo, "app", new Date(), exited.pid, where)
      const result = undo.revertAction(repo, sha, "2026-02-03", { lockWaitMs: 300 })
      expect(result, name).toEqual({ ok: false, reason: "busy", message: BUSY })
      expect(JSON.parse(readFileSync(lockFile(repo), "utf8")).tool, name).toBe("app")
    }
  })

  it("counts a lock that exists but cannot be read as held: busy within the wait, no spin", () => {
    const { repo, sha } = makeUndoableRepo()
    // A folder at the place of the lock file: it exists, and reading it fails.
    mkdirSync(lockFile(repo), { recursive: true })
    const head = git(repo, "rev-parse", "HEAD").trim()

    const started = Date.now()
    const result = undo.revertAction(repo, sha, "2026-02-03", { lockWaitMs: 300 })
    const elapsed = Date.now() - started

    expect(result).toEqual({ ok: false, reason: "busy", message: BUSY })
    expect(elapsed).toBeGreaterThanOrEqual(250)
    expect(elapsed).toBeLessThan(3000)
    expect(git(repo, "rev-parse", "HEAD").trim()).toBe(head)
    expect(existsSync(lockFile(repo))).toBe(true)
  })

  it("holds the lock from the revert through the undo commit", () => {
    const { repo, sha } = makeUndoableRepo()
    // post-commit runs even with --no-verify. It copies the lock while the commit is made.
    const hook = join(repo, ".git/hooks/post-commit")
    mkdirSync(dirname(hook), { recursive: true })
    writeFileSync(hook, "#!/bin/sh\ncp .llm-wiki/git.lock .git/lock-seen-by-commit\n")
    chmodSync(hook, 0o755)

    expectUndone(undo.revertAction(repo, sha, "2026-02-03"), repo, sha)

    const seen = JSON.parse(readFileSync(join(repo, ".git/lock-seen-by-commit"), "utf8"))
    expect(seen.tool).toBe("wiki-undo")
    expect(seen.pid).toBe(process.pid)
    expect(seen.host).toBe(hostname())
    expect(seen.platform).toBe(process.platform)
    expect(new Date(seen.started_at).toISOString()).toBe(seen.started_at)
    expect(existsSync(lockFile(repo))).toBe(false)
  })

  it("releases the lock after a conflict and after a refusal", () => {
    const repo = makeRepo()
    commitFiles(repo, "chore: base", { "wiki/concepts/p.md": "line\n" })
    const shaA = commitFiles(repo, "ingest: a (1 pages)", { "wiki/concepts/p.md": "from a\n" })
    commitFiles(repo, "ingest: b (1 pages)", { "wiki/concepts/p.md": "from b\n" })

    expect(undo.revertAction(repo, shaA, "2026-02-03")).toMatchObject({ ok: false, reason: "conflict" })
    expect(existsSync(lockFile(repo))).toBe(false)

    expect(undo.revertAction(repo, "deadbeef", "2026-02-03")).toEqual({ ok: false, reason: "not-action" })
    expect(existsSync(lockFile(repo))).toBe(false)

    write(repo, "wiki/concepts/p.md", "dirty\n")
    expect(undo.revertAction(repo, shaA, "2026-02-03")).toEqual({ ok: false, reason: "dirty" })
    expect(existsSync(lockFile(repo))).toBe(false)
  })

  it("releases the lock when the undo throws", () => {
    const { repo, sha } = makeUndoableRepo()
    const saved = process.env.GIT_AUTHOR_DATE
    process.env.GIT_AUTHOR_DATE = "garbage"
    try {
      expect(() => undo.revertAction(repo, sha, "2026-02-03")).toThrow()
    } finally {
      if (saved === undefined) delete process.env.GIT_AUTHOR_DATE
      else process.env.GIT_AUTHOR_DATE = saved
    }
    expect(existsSync(lockFile(repo))).toBe(false)
  })

  it("does not create .llm-wiki for a project that is not a wiki project", () => {
    const repo = makeDir()
    git(repo, "init", "--quiet")
    expect(undo.revertAction(repo, "deadbeef", "2026-02-03")).toEqual({ ok: false, reason: "not-a-wiki-project" })
    expect(existsSync(join(repo, ".llm-wiki"))).toBe(false)
  })
})

describe("revertAction never changes raw/ or .gitignore", () => {
  it("keeps a raw source that an ingest commit swept in", () => {
    const repo = makeRepo()
    commitFiles(repo, "chore: base", { "wiki/log.md": "# Log\n" })
    const sha = commitFiles(repo, "ingest: a (1 pages)", {
      "wiki/concepts/a.md": "a\n",
      "raw/sources/new.pdf": "a source the user added during the ingest\n",
    })

    expectUndone(undo.revertAction(repo, sha, "2026-02-03"), repo, sha)

    expect(existsSync(join(repo, "wiki/concepts/a.md"))).toBe(false)
    expect(read(repo, "raw/sources/new.pdf")).toBe("a source the user added during the ingest\n")
    expect(git(repo, "ls-files", "raw/sources/new.pdf").trim()).toBe("raw/sources/new.pdf")
    expect(git(repo, "show", "--name-only", "--format=", "HEAD")).not.toContain("raw/")
    expect(git(repo, "status", "--porcelain")).toBe("")
  })

  it("does not bring back a raw source that the reverted commit deleted", () => {
    const repo = makeRepo()
    commitFiles(repo, "chore: base", { "raw/sources/old.md": "old source\n", "wiki/log.md": "# Log\n" })
    write(repo, "wiki/concepts/a.md", "a\n")
    rmSync(join(repo, "raw/sources/old.md"))
    git(repo, "add", "-A")
    git(repo, "commit", "--quiet", "--no-verify", "-m", "ingest: a (1 pages)")
    const sha = git(repo, "rev-parse", "HEAD").trim()

    expectUndone(undo.revertAction(repo, sha, "2026-02-03"), repo, sha)

    expect(existsSync(join(repo, "wiki/concepts/a.md"))).toBe(false)
    expect(existsSync(join(repo, "raw/sources/old.md"))).toBe(false)
    expect(git(repo, "status", "--porcelain")).toBe("")
  })

  it("keeps the current raw/ version when the revert conflicts there", () => {
    const repo = makeRepo()
    commitFiles(repo, "chore: base", { "raw/sources/s.md": "one\ntwo\n", "wiki/log.md": "# Log\n" })
    const shaA = commitFiles(repo, "ingest: a (1 pages)", {
      "wiki/concepts/a.md": "a\n",
      "raw/sources/s.md": "one\ntwo by a\n",
    })
    commitFiles(repo, "chore: save changes before ingest", { "raw/sources/s.md": "one\ntwo by the user\n" })

    expectUndone(undo.revertAction(repo, shaA, "2026-02-03"), repo, shaA)

    expect(existsSync(join(repo, "wiki/concepts/a.md"))).toBe(false)
    expect(read(repo, "raw/sources/s.md")).toBe("one\ntwo by the user\n")
    expect(git(repo, "status", "--porcelain")).toBe("")
  })

  it("keeps raw/ in a project folder inside a larger repository", () => {
    const outer = makeRepo()
    const project = join(outer, "my-wiki")
    commitFiles(outer, "chore: base", { "my-wiki/wiki/log.md": "# Log\n", "raw/outer.md": "outer\n" })
    const sha = commitFiles(outer, "ingest: a (1 pages)", {
      "my-wiki/wiki/concepts/a.md": "a\n",
      "my-wiki/raw/sources/new.md": "new source\n",
    })

    expectUndone(undo.revertAction(project, sha, "2026-02-03"), project, sha)

    expect(existsSync(join(project, "wiki/concepts/a.md"))).toBe(false)
    expect(read(project, "raw/sources/new.md")).toBe("new source\n")
    expect(git(outer, "status", "--porcelain")).toBe("")
  })
})

describe("revertAction refuses protected commits", () => {
  it("refuses a commit that changed .llm-wiki/", () => {
    const repo = makeRepo()
    commitFiles(repo, "chore: base", { "wiki/log.md": "# Log\n" })
    const sha = commitFiles(repo, "ingest: a (1 pages)", {
      "wiki/concepts/a.md": "a\n",
      ".llm-wiki/cache.json": "{}\n",
    })
    const head = git(repo, "rev-parse", "HEAD").trim()

    expect(undo.revertAction(repo, sha, "2026-02-03")).toEqual({ ok: false, reason: "protected" })
    expect(git(repo, "rev-parse", "HEAD").trim()).toBe(head)
    expect(git(repo, "status", "--porcelain")).toBe("")
  })

  it("refuses a commit that changed .gitignore", () => {
    const repo = makeRepo()
    commitFiles(repo, "chore: base", { "wiki/log.md": "# Log\n" })
    const sha = commitFiles(repo, "ingest: a (1 pages)", {
      "wiki/concepts/a.md": "a\n",
      ".gitignore": ".llm-wiki/\n",
    })

    expect(undo.revertAction(repo, sha, "2026-02-03")).toEqual({ ok: false, reason: "protected" })
  })

  it("refuses a root commit that added .llm-wiki/", () => {
    const repo = makeRepo()
    const sha = commitFiles(repo, "ingest: a (1 pages)", {
      "wiki/concepts/a.md": "a\n",
      ".llm-wiki/secret": "key\n",
    })

    expect(undo.revertAction(repo, sha, "2026-02-03")).toEqual({ ok: false, reason: "protected" })
  })

  it("looks only inside the project folder of a larger repository", () => {
    const outer = makeRepo()
    const project = join(outer, "my-wiki")
    commitFiles(outer, "chore: base", { "my-wiki/wiki/log.md": "# Log\n" })
    const sha = commitFiles(outer, "ingest: a (1 pages)", {
      "my-wiki/wiki/concepts/a.md": "a\n",
      ".gitignore": "node_modules/\n",
    })

    expectUndone(undo.revertAction(project, sha, "2026-02-03"), project, sha)
    // The outer .gitignore is not part of the project; it is reverted with the rest.
    expect(existsSync(join(outer, ".gitignore"))).toBe(false)
  })
})

describe("project folder guard", () => {
  it("refuses a folder that has no wiki/ folder", () => {
    const repo = makeRepo()
    const sha = commitFiles(repo, "ingest: a (1 pages)", { "wiki/concepts/a.md": "a\n" })
    const wikiFolder = join(repo, "wiki")

    expect(undo.revertAction(wikiFolder, sha, "2026-02-03")).toEqual({
      ok: false,
      reason: "not-a-wiki-project",
    })
    expect(headSubject(repo)).toBe("ingest: a (1 pages)")
    expect(git(repo, "status", "--porcelain")).toBe("")
  })

  it("refuses a folder that does not exist", () => {
    const missing = join(makeDir(), "missing")
    expect(undo.revertAction(missing, "deadbeef", "2026-02-03")).toEqual({
      ok: false,
      reason: "not-a-wiki-project",
    })
  })
})

describe("SKILL.md", () => {
  const skill = readFileSync(join(dirname(SCRIPT_PATH), "..", "SKILL.md"), "utf8")

  it("names the project folder and never the wiki folder", () => {
    expect(skill).toContain("the project folder (the folder that contains `wiki/` and `raw/`)")
    expect(skill).not.toMatch(/wiki folder/i)
    expect(skill).not.toContain("`wiki/` folder")
  })

  it("tells the agent how to read exit code 2 and each result", () => {
    expect(skill).toMatch(/exit code 2/i)
    for (const reason of ["conflict", "dirty", "not-action", "not-a-wiki-project", "protected", "error"]) {
      expect(skill, reason).toContain(`"reason": "${reason}"`)
    }
  })
})

describe("cli", () => {
  function run(args: string[], cwd?: string): { status: number | null; stdout: string; stderr: string } {
    const result = spawnSync(process.execPath, [SCRIPT_PATH, ...args], { encoding: "utf8", cwd })
    return { status: result.status, stdout: result.stdout, stderr: result.stderr }
  }

  it("cli prints json", () => {
    const repo = makeRepo()
    const sha = commitFiles(repo, "ingest: a (1 pages)", { "wiki/concepts/a.md": "a\n" })

    const result = run(["list", "--project", repo])

    expect(result.status).toBe(0)
    const parsed = JSON.parse(result.stdout) as Action[]
    expect(Array.isArray(parsed)).toBe(true)
    expect(parsed).toHaveLength(1)
    expect(parsed[0].sha).toBe(sha)
    expect(parsed[0].subject).toBe("ingest: a (1 pages)")
  })

  it("uses the current directory when --project is missing and honors --limit", () => {
    const repo = makeRepo()
    commitFiles(repo, "ingest: a (1 pages)", { "wiki/concepts/a.md": "a\n" })
    commitFiles(repo, "ingest: b (1 pages)", { "wiki/concepts/b.md": "b\n" })

    const result = run(["list", "--limit", "1"], repo)

    expect(result.status).toBe(0)
    expect((JSON.parse(result.stdout) as Action[]).map((action) => action.subject)).toEqual([
      "ingest: b (1 pages)",
    ])
  })

  it("revert exits 0 and prints ok json", () => {
    const repo = makeRepo()
    const sha = commitFiles(repo, "ingest: a (1 pages)", { "wiki/concepts/a.md": "a\n" })

    const result = run(["revert", sha, "--project", repo])

    expect(result.status).toBe(0)
    expect(JSON.parse(result.stdout)).toEqual({
      ok: true,
      sha: git(repo, "rev-parse", "HEAD").trim(),
      reverted: sha,
    })
    expect(headSubject(repo)).toBe("undo: ingest: a (1 pages)")
    expect(read(repo, "wiki/log.md")).toMatch(/^## \[\d{4}-\d{2}-\d{2}\] undo \| ingest: a \(1 pages\)\n$/)
  })

  it("revert exits 2 on a handled failure", () => {
    const repo = makeRepo()
    const sha = commitFiles(repo, "chore: x", { "a.txt": "1" })

    const result = run(["revert", sha, "--project", repo])

    expect(result.status).toBe(2)
    expect(JSON.parse(result.stdout)).toEqual({ ok: false, reason: "not-action" })
  })

  it("exits 2 for list and revert when the project is not a project folder", () => {
    const repo = makeRepo()
    const sha = commitFiles(repo, "ingest: a (1 pages)", { "wiki/concepts/a.md": "a\n" })
    const wikiFolder = join(repo, "wiki")

    for (const args of [
      ["list", "--project", wikiFolder],
      ["revert", sha, "--project", wikiFolder],
    ]) {
      const result = run(args)
      expect(result.status, args.join(" ")).toBe(2)
      expect(JSON.parse(result.stdout)).toEqual({ ok: false, reason: "not-a-wiki-project" })
    }
    expect(headSubject(repo)).toBe("ingest: a (1 pages)")
  })

  it("exits 1 with json on an unexpected error", () => {
    const notRepo = makeDir()
    mkdirSync(join(notRepo, "wiki"))

    const result = run(["list", "--project", notRepo])

    expect(result.status).toBe(1)
    const parsed = JSON.parse(result.stdout) as { ok: boolean; reason: string; message: string }
    expect(parsed.ok).toBe(false)
    expect(parsed.reason).toBe("error")
    expect(parsed.message.length).toBeGreaterThan(0)
  })

  it("exits 1 on bad usage", () => {
    expect(run(["frobnicate"]).status).toBe(1)
    expect(run(["revert"]).status).toBe(1)
    expect(run(["list", "--limit", "zero"]).status).toBe(1)
  })

  it("does not run the cli when the module is imported", () => {
    const result = spawnSync(
      process.execPath,
      ["--input-type=module", "-e", `import(${JSON.stringify(SCRIPT_PATH)}).then((m) => console.log(typeof m.listActions))`],
      { encoding: "utf8", cwd: makeDir() },
    )
    expect(result.status).toBe(0)
    expect(result.stdout.trim()).toBe("function")
  })
})
