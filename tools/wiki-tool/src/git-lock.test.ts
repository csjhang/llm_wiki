/**
 * git-lock.test.ts - tests for the shared git lock (`<project>/.llm-wiki/git.lock`).
 *
 * The app (Rust), wiki-undo, and wiki-tool all use this one file, so the file
 * name, the JSON shape, and the wait and stale rules are part of the contract.
 */
import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { removeLockIfUnchanged, withGitLock } from "./git-lock"

const BUSY = "another wiki tool is using git"
const MINUTE = 60_000

const tempDirs: string[] = []

function makeProject(): string {
  const dir = mkdtempSync(join(tmpdir(), "wiki-tool-lock-"))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop() as string, { recursive: true, force: true })
  }
})

function lockPath(project: string): string {
  return join(project, ".llm-wiki", "git.lock")
}

function writeLock(project: string, text: string): void {
  mkdirSync(join(project, ".llm-wiki"), { recursive: true })
  writeFileSync(lockPath(project), text)
}

/** The text of a lock file. The pid defaults to this process, which is alive. */
function lockText(tool: string, startedAt: Date, pid: number = process.pid): string {
  return JSON.stringify({ pid, started_at: startedAt.toISOString(), tool })
}

/** The pid of a process that has already exited on this machine. */
function deadPid(): number {
  const child = spawnSync(process.execPath, ["-e", "0"])
  if (typeof child.pid !== "number") throw new Error("could not start a process")
  return child.pid
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

describe("withGitLock", () => {
  it("holds a lock file with pid, start time, and tool while the work runs", async () => {
    const project = makeProject()
    const before = Date.now()

    let seen: { pid: number; started_at: string; tool: string } | undefined
    const result = await withGitLock(project, () => {
      seen = JSON.parse(readFileSync(lockPath(project), "utf8"))
      return "done"
    })

    expect(result).toBe("done")
    expect(seen?.pid).toBe(process.pid)
    expect(seen?.tool).toBe("wiki-tool")
    expect(new Date(seen?.started_at ?? "").getTime()).toBeGreaterThanOrEqual(before)
    expect(new Date(seen?.started_at ?? "").toISOString()).toBe(seen?.started_at)
    expect(existsSync(lockPath(project))).toBe(false)
  })

  it("creates .llm-wiki when it is missing", async () => {
    const project = makeProject()
    expect(existsSync(join(project, ".llm-wiki"))).toBe(false)

    await withGitLock(project, () => {
      expect(existsSync(lockPath(project))).toBe(true)
    })
  })

  it("awaits async work", async () => {
    const project = makeProject()
    const result = await withGitLock(project, async () => {
      await sleep(20)
      return 7
    })
    expect(result).toBe(7)
    expect(existsSync(lockPath(project))).toBe(false)
  })

  it("second holder waits then fails with the busy message", async () => {
    const project = makeProject()
    let release: () => void = () => {}
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    let entered: () => void = () => {}
    const holderEntered = new Promise<void>((resolve) => {
      entered = resolve
    })
    const first = withGitLock(project, async () => {
      entered()
      await held
    })
    await holderEntered

    const started = Date.now()
    let secondRan = false
    await expect(
      withGitLock(
        project,
        () => {
          secondRan = true
        },
        { waitMs: 500 },
      ),
    ).rejects.toThrow(BUSY)
    const waited = Date.now() - started

    expect(secondRan).toBe(false)
    expect(waited).toBeGreaterThanOrEqual(450)
    expect(waited).toBeLessThan(5000)
    // The failed waiter did not take the first holder's lock away.
    expect(existsSync(lockPath(project))).toBe(true)
    release()
    await first
    expect(existsSync(lockPath(project))).toBe(false)
  })

  it("takes the lock when the holder releases during the wait", async () => {
    const project = makeProject()
    writeLock(project, lockText("app", new Date()))
    setTimeout(() => rmSync(lockPath(project)), 300)

    const started = Date.now()
    const result = await withGitLock(project, () => "ran", { waitMs: 5000 })

    expect(result).toBe("ran")
    expect(Date.now() - started).toBeGreaterThanOrEqual(250)
    expect(existsSync(lockPath(project))).toBe(false)
  })

  it("stale lock is replaced", async () => {
    const project = makeProject()
    writeLock(project, lockText("app", new Date(Date.now() - 11 * MINUTE)))

    let holder: { pid: number; tool: string } | undefined
    const started = Date.now()
    await withGitLock(project, () => {
      holder = JSON.parse(readFileSync(lockPath(project), "utf8"))
    })

    expect(Date.now() - started).toBeLessThan(1000)
    expect(holder?.pid).toBe(process.pid)
    expect(holder?.tool).toBe("wiki-tool")
    expect(existsSync(lockPath(project))).toBe(false)
  })

  it("does not treat a lock younger than the stale limit as stale", async () => {
    const project = makeProject()
    writeLock(project, lockText("app", new Date(Date.now() - 9 * MINUTE)))

    await expect(withGitLock(project, () => "ran", { waitMs: 300 })).rejects.toThrow(BUSY)
    expect(JSON.parse(readFileSync(lockPath(project), "utf8")).tool).toBe("app")
  })

  it("uses the file time when the lock text cannot be read", async () => {
    const project = makeProject()
    writeLock(project, "not json")
    const old = new Date(Date.now() - 11 * MINUTE)
    utimesSync(lockPath(project), old, old)

    expect(await withGitLock(project, () => "ran")).toBe("ran")

    writeLock(project, "not json")
    await expect(withGitLock(project, () => "ran", { waitMs: 300 })).rejects.toThrow(BUSY)
  })

  it("replaces at once a fresh lock whose process is gone", async () => {
    const project = makeProject()
    writeLock(project, lockText("app", new Date(), deadPid()))

    const started = Date.now()
    expect(await withGitLock(project, () => "ran")).toBe("ran")

    expect(Date.now() - started).toBeLessThan(1000)
    expect(existsSync(lockPath(project))).toBe(false)
  })

  it("keeps a fresh lock whose process is alive", async () => {
    const project = makeProject()
    writeLock(project, lockText("app", new Date(), process.pid))

    await expect(withGitLock(project, () => "ran", { waitMs: 300 })).rejects.toThrow(BUSY)
    expect(JSON.parse(readFileSync(lockPath(project), "utf8")).tool).toBe("app")
  })

  it("judges a lock without a usable pid by its age only", async () => {
    for (const pid of [undefined, 0, -5, 1.5, "abc"]) {
      const project = makeProject()
      writeLock(project, JSON.stringify({ pid, started_at: new Date().toISOString(), tool: "app" }))
      await expect(withGitLock(project, () => "ran", { waitMs: 250 })).rejects.toThrow(BUSY)
    }
  })

  it("takes the stale limit from the options", async () => {
    const project = makeProject()
    writeLock(project, lockText("app", new Date(Date.now() - 2000)))

    expect(await withGitLock(project, () => "ran", { staleMs: 1000 })).toBe("ran")
  })

  it("does not create a project folder that is missing", async () => {
    const parent = makeProject()
    const missing = join(parent, "no-such-project")

    await expect(withGitLock(missing, () => "ran")).rejects.toThrow(/not found/)

    expect(existsSync(missing)).toBe(false)
  })

  it("lock released after a throw", async () => {
    const project = makeProject()

    await expect(
      withGitLock(project, () => {
        throw new Error("boom")
      }),
    ).rejects.toThrow("boom")
    expect(existsSync(lockPath(project))).toBe(false)

    await expect(
      withGitLock(project, async () => {
        throw new Error("async boom")
      }),
    ).rejects.toThrow("async boom")
    expect(existsSync(lockPath(project))).toBe(false)

    // The next holder is not blocked.
    expect(await withGitLock(project, () => "ran", { waitMs: 0 })).toBe("ran")
  })

  it("leaves a lock that another tool took over after this one went stale", async () => {
    const project = makeProject()
    await withGitLock(project, () => {
      // Another tool replaced the lock while this work ran (for example after a long stall).
      writeLock(project, lockText("wiki-undo", new Date()))
    })
    expect(JSON.parse(readFileSync(lockPath(project), "utf8")).tool).toBe("wiki-undo")
  })
})

describe("removeLockIfUnchanged", () => {
  it("removes the lock when it still holds the text that was judged stale", () => {
    const project = makeProject()
    const stale = lockText("app", new Date(Date.now() - 11 * MINUTE))
    writeLock(project, stale)

    expect(removeLockIfUnchanged(lockPath(project), stale)).toBe(true)

    expect(existsSync(lockPath(project))).toBe(false)
  })

  it("leaves a lock that another tool took after the judgment", () => {
    const project = makeProject()
    const judged = lockText("app", new Date(Date.now() - 11 * MINUTE))
    const fresh = lockText("wiki-undo", new Date())
    writeLock(project, fresh)

    // The caller is told to look again; the new lock is not removed.
    expect(removeLockIfUnchanged(lockPath(project), judged)).toBe(true)

    expect(readFileSync(lockPath(project), "utf8")).toBe(fresh)
  })

  it("reports a lock that is already gone", () => {
    const project = makeProject()
    expect(removeLockIfUnchanged(lockPath(project), "anything")).toBe(true)
  })
})
