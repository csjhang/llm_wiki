/**
 * wiki-undo.test.ts — tests for the wiki-undo skill script.
 *
 * Imports plugins/llm-wiki/skills/wiki-undo/scripts/undo.mjs and runs it
 * against real temporary git repositories. Each repo has a local identity, so
 * the tests do not depend on the git config of the machine.
 */
import { execFileSync, spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
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
  | { ok: true; sha: string }
  | { ok: false; reason: "conflict"; files: string[] }
  | { ok: false; reason: "not-action" | "dirty" }

interface UndoModule {
  ACTION_PREFIXES: string[]
  GENERATED_PATHS: string[]
  listActions: (projectPath: string, limit?: number) => Action[]
  revertAction: (projectPath: string, sha: string, today?: string) => RevertResult
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

    expect(result).toEqual({ ok: true, sha })
    expect(existsSync(join(repo, "wiki/concepts/a.md"))).toBe(false)
    expect(headSubject(repo)).toBe("undo: ingest: a (1 pages)")
    expect(git(repo, "log", "-1", "--format=%b").trim()).toBe(`Reverts ${sha}.`)
    expect(read(repo, "wiki/log.md").trimEnd().split("\n").pop()).toBe(
      "## [2026-02-03] undo | ingest: a (1 pages)",
    )
    expect(git(repo, "status", "--porcelain")).toBe("")
  })

  it("accepts a short sha and the undo commit appears in the list", () => {
    const repo = makeRepo()
    commitFiles(repo, "chore: base", { "a.txt": "1" })
    const sha = commitFiles(repo, "lint: fix (1 pages)", { "wiki/concepts/a.md": "a\n" })

    const result = undo.revertAction(repo, sha.slice(0, 8), "2026-02-03")

    expect(result).toEqual({ ok: true, sha })
    expect(undo.listActions(repo)[0].subject).toBe("undo: lint: fix (1 pages)")
  })

  it("creates wiki/log.md when the reverted commit created it", () => {
    const repo = makeRepo()
    commitFiles(repo, "chore: base", { "a.txt": "1" })
    const sha = commitFiles(repo, "ingest: a (1 pages)", {
      "wiki/concepts/a.md": "a\n",
      "wiki/log.md": "## [2026-01-01] ingest | a\n",
    })

    expect(undo.revertAction(repo, sha, "2026-02-03")).toEqual({ ok: true, sha })

    expect(read(repo, "wiki/log.md")).toBe("## [2026-02-03] undo | ingest: a (1 pages)\n")
    expect(git(repo, "status", "--porcelain")).toBe("")
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

    expect(result).toEqual({ ok: true, sha: shaA })
    expect(existsSync(join(repo, "wiki/concepts/a.md"))).toBe(false)
    expect(existsSync(join(repo, "wiki/concepts/b.md"))).toBe(true)
    expect(read(repo, "wiki/index.md")).toBe(indexBefore)
    const log = read(repo, "wiki/log.md")
    expect(log).not.toContain("<<<<<<<")
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

    expect(undo.revertAction(repo, shaA, "2026-02-03")).toEqual({ ok: true, sha: shaA })

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

    expect(undo.revertAction(repo, shaA, "2026-02-03")).toEqual({ ok: true, sha: shaA })

    expect(existsSync(join(repo, "wiki/overview.md"))).toBe(false)
    expect(existsSync(join(repo, "wiki/concepts/a.md"))).toBe(false)
    expect(git(repo, "status", "--porcelain")).toBe("")
  })

  it("reverts a root commit that has an action prefix", () => {
    const repo = makeRepo()
    const root = commitFiles(repo, "ingest: first (1 pages)", { "wiki/concepts/a.md": "a\n" })
    commitFiles(repo, "chore: x", { "other.txt": "1" })

    expect(undo.revertAction(repo, root, "2026-02-03")).toEqual({ ok: true, sha: root })

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

    expect(undo.revertAction(repo, sha, "2026-02-03")).toEqual({ ok: true, sha })

    expect(existsSync(join(repo, ".llm-wiki/cache/state.json"))).toBe(true)
    expect(git(repo, "show", "--name-only", "--format=", "HEAD")).not.toContain(".llm-wiki")
  })

  it("commits with a fallback identity when git has none", () => {
    const repo = makeRepo({ identity: false })
    // Make the commits with an explicit identity, then undo with none.
    const env = {
      GIT_AUTHOR_NAME: "T",
      GIT_AUTHOR_EMAIL: "t@example.com",
      GIT_COMMITTER_NAME: "T",
      GIT_COMMITTER_EMAIL: "t@example.com",
    }
    write(repo, "wiki/concepts/a.md", "a\n")
    execFileSync("git", ["-C", repo, "add", "-A"])
    execFileSync("git", ["-C", repo, "commit", "--quiet", "-m", "ingest: a (1 pages)"], {
      env: { ...process.env, ...env },
    })
    const sha = git(repo, "rev-parse", "HEAD").trim()

    const saved = {
      GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL,
      GIT_CONFIG_NOSYSTEM: process.env.GIT_CONFIG_NOSYSTEM,
      GIT_AUTHOR_NAME: process.env.GIT_AUTHOR_NAME,
      GIT_AUTHOR_EMAIL: process.env.GIT_AUTHOR_EMAIL,
      GIT_COMMITTER_NAME: process.env.GIT_COMMITTER_NAME,
      GIT_COMMITTER_EMAIL: process.env.GIT_COMMITTER_EMAIL,
    }
    process.env.GIT_CONFIG_GLOBAL = join(repo, "no-such-global-config")
    process.env.GIT_CONFIG_NOSYSTEM = "1"
    delete process.env.GIT_AUTHOR_NAME
    delete process.env.GIT_AUTHOR_EMAIL
    delete process.env.GIT_COMMITTER_NAME
    delete process.env.GIT_COMMITTER_EMAIL
    try {
      expect(undo.revertAction(repo, sha, "2026-02-03")).toEqual({ ok: true, sha })
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
    }

    expect(git(repo, "log", "-1", "--format=%an <%ae>")).toBe("LLM Wiki <llm-wiki@localhost>\n")
    expect(git(repo, "log", "-1", "--format=%cn <%ce>")).toBe("LLM Wiki <llm-wiki@localhost>\n")
    // The undo never writes the fallback identity to the git config of the repo.
    expect(readFileSync(join(repo, ".git", "config"), "utf8")).not.toContain("llm-wiki@localhost")
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

    expect(undo.revertAction(project, shaA, "2026-02-03")).toEqual({ ok: true, sha: shaA })
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
    expect(undo.revertAction(repo, sha, "2026-02-03")).toEqual({ ok: true, sha })
    const undoSha = undo.listActions(repo)[0].sha

    expect(undo.revertAction(repo, undoSha, "2026-02-04")).toEqual({ ok: true, sha: undoSha })

    expect(existsSync(join(repo, "wiki/concepts/a.md"))).toBe(true)
    expect(headSubject(repo)).toBe("undo: undo: ingest: a (1 pages)")
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
    expect(JSON.parse(result.stdout)).toEqual({ ok: true, sha })
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

  it("exits 1 with json on an unexpected error", () => {
    const notRepo = makeDir()

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
