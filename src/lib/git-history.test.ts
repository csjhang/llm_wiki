import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("@/commands/git", () => ({
  gitInfo: vi.fn(),
  gitInit: vi.fn(),
  gitCommitAll: vi.fn(),
  gitCommitPaths: vi.fn(),
  gitRestorePaths: vi.fn(),
  gitHead: vi.fn(),
}))

// A small in-memory file system for the in-flight record and folder checks.
const diskFiles = new Map<string, string>()
const diskFolders = new Set<string>()
vi.mock("@/commands/fs", () => ({
  readFile: vi.fn(),
  writeFile: vi.fn(),
  deleteFile: vi.fn(),
  fileExists: vi.fn(),
}))
vi.mock("@/commands/file-sync", () => ({ invalidateProjectFileSnapshotPaths: vi.fn() }))
vi.mock("@/lib/ingest", () => ({ clearIngestResumeState: vi.fn() }))

const storeData = new Map<string, unknown>()
const fakeStore = {
  get: vi.fn(async (key: string) => storeData.get(key)),
  set: vi.fn(async (key: string, value: unknown) => {
    storeData.set(key, value)
  }),
  save: vi.fn(async () => {}),
}
vi.mock("@/lib/project-store", () => ({ getStore: vi.fn(async () => fakeStore) }))
vi.mock("@tauri-apps/plugin-dialog", () => ({ ask: vi.fn() }))

import { ask } from "@tauri-apps/plugin-dialog"
import {
  gitCommitAll,
  gitCommitPaths,
  gitHead,
  gitInfo,
  gitInit,
  gitRestorePaths,
  type GitInfo,
} from "@/commands/git"
import { deleteFile, fileExists, readFile, writeFile } from "@/commands/fs"
import { invalidateProjectFileSnapshotPaths } from "@/commands/file-sync"
import { clearIngestResumeState } from "@/lib/ingest"
import { useActivityStore } from "@/stores/activity-store"
import { createDeferred, waitFor } from "@/test-helpers/deferred"
import {
  buildActionCommitMessage,
  commitIngest,
  defaultGitHistoryDeps,
  getCachedGitHistory,
  isGitHistoryOnCached,
  prepareIngestBaseline,
  recoverInterruptedIngest,
  resetGitHistoryCache,
  resetIngestHistoryRuns,
  resolveGitHistory,
  restoreFailedIngest,
  titleFromSourcePath,
  trackIngestPath,
  type GitHistoryDeps,
  type GitHistoryMode,
  type IngestHistoryRun,
} from "./git-history"

const ASK_MESSAGE =
  "Turn on version history for this wiki? Each ingest becomes one git commit that you can undo."
const NESTED_ASK_MESSAGE =
  "This wiki is inside another git repository at /big. Turn on version history and record each ingest there? Commits include only this wiki folder."
const INFLIGHT = "/wiki/.llm-wiki/git-inflight.json"

function gitState(available: boolean, isRepo: boolean, isRoot: boolean, topLevel: string | null = null): GitInfo {
  return { available, isRepo, isRoot, topLevel }
}

function activityDetails(): string[] {
  return useActivityStore.getState().items.map((item) => item.detail)
}

function inflightRecord(): { taskId: string; sourcePath: string; baselineSha: string; paths: string[]; startedAt: number } {
  return JSON.parse(diskFiles.get(INFLIGHT) ?? "null")
}

function makeDeps(mode: GitHistoryMode, answer = true): GitHistoryDeps {
  return {
    loadMode: vi.fn(async () => mode),
    saveMode: vi.fn(async () => {}),
    askUser: vi.fn(async () => answer),
  }
}

beforeEach(() => {
  vi.resetAllMocks()
  storeData.clear()
  fakeStore.get.mockImplementation(async (key: string) => storeData.get(key))
  fakeStore.set.mockImplementation(async (key: string, value: unknown) => {
    storeData.set(key, value)
  })
  fakeStore.save.mockResolvedValue(undefined)
  resetGitHistoryCache()
  resetIngestHistoryRuns()
  diskFiles.clear()
  diskFolders.clear()
  vi.mocked(readFile).mockImplementation(async (path: string) => {
    const text = diskFiles.get(path)
    if (text === undefined) throw new Error(`ENOENT: ${path}`)
    return text
  })
  vi.mocked(writeFile).mockImplementation(async (path: string, contents: string) => {
    diskFiles.set(path, contents)
  })
  vi.mocked(deleteFile).mockImplementation(async (path: string) => {
    diskFiles.delete(path)
  })
  vi.mocked(fileExists).mockImplementation(async (path: string) => diskFiles.has(path) || diskFolders.has(path))
  vi.mocked(gitHead).mockResolvedValue("h".repeat(40))
  vi.mocked(gitCommitAll).mockResolvedValue("b".repeat(40))
  vi.mocked(gitCommitPaths).mockResolvedValue("c".repeat(40))
  vi.mocked(gitRestorePaths).mockResolvedValue()
  vi.mocked(invalidateProjectFileSnapshotPaths).mockResolvedValue()
  vi.mocked(clearIngestResumeState).mockResolvedValue()
  useActivityStore.setState({ items: [] })
})

describe("defaultGitHistoryDeps", () => {
  it("defaults to ask when nothing is stored", async () => {
    await expect(defaultGitHistoryDeps.loadMode("p1")).resolves.toBe("ask")
  })

  it("saves under gitHistoryMode:<projectId> and reads it back", async () => {
    await defaultGitHistoryDeps.saveMode("p1", "on")
    expect(storeData.get("gitHistoryMode:p1")).toBe("on")
    expect(fakeStore.save).toHaveBeenCalled()
    await expect(defaultGitHistoryDeps.loadMode("p1")).resolves.toBe("on")
    await expect(defaultGitHistoryDeps.loadMode("p2")).resolves.toBe("ask")
  })

  it("treats an unknown stored value as ask", async () => {
    storeData.set("gitHistoryMode:p1", "sometimes")
    await expect(defaultGitHistoryDeps.loadMode("p1")).resolves.toBe("ask")
  })

  it("asks through the dialog plugin", async () => {
    vi.mocked(ask).mockResolvedValue(true)
    await expect(defaultGitHistoryDeps.askUser("Question?")).resolves.toBe(true)
    expect(vi.mocked(ask).mock.calls[0][0]).toBe("Question?")
  })
})

describe("re-exports", () => {
  it("exposes the pure commit message helpers", () => {
    expect(typeof buildActionCommitMessage).toBe("function")
    expect(titleFromSourcePath("raw/sources/a.md")).toBe("a")
  })
})

describe("resolveGitHistory", () => {
  it("git unavailable resolves to off", async () => {
    vi.mocked(gitInfo).mockResolvedValue(gitState(false, false, false))
    const deps = makeDeps("ask")
    await expect(resolveGitHistory("p1", "/wiki", deps)).resolves.toBe(false)
    expect(deps.saveMode).not.toHaveBeenCalled()
    expect(deps.askUser).not.toHaveBeenCalled()
    expect(gitInit).not.toHaveBeenCalled()
  })

  it("ask mode at the root of an existing repo saves on silently", async () => {
    vi.mocked(gitInfo).mockResolvedValue(gitState(true, true, true, "/wiki"))
    const deps = makeDeps("ask")
    await expect(resolveGitHistory("p1", "/wiki", deps)).resolves.toBe(true)
    expect(deps.askUser).not.toHaveBeenCalled()
    expect(gitInit).not.toHaveBeenCalled()
    expect(deps.saveMode).toHaveBeenCalledWith("p1", "on")
  })

  it("ask mode in a repo nested in a bigger one names that repository", async () => {
    vi.mocked(gitInfo).mockResolvedValue(gitState(true, true, false, "/big"))
    const deps = makeDeps("ask", true)
    await resolveGitHistory("p1", "/big/wiki", deps)
    expect(deps.askUser).toHaveBeenCalledTimes(1)
    expect(deps.askUser).toHaveBeenCalledWith(NESTED_ASK_MESSAGE)
  })

  it("off mode resolves false without probing git", async () => {
    const deps = makeDeps("off")
    await expect(resolveGitHistory("p1", "/wiki", deps)).resolves.toBe(false)
    expect(deps.loadMode).toHaveBeenCalledWith("p1")
    expect(gitInfo).not.toHaveBeenCalled()
    expect(gitInit).not.toHaveBeenCalled()
  })

  it("ask mode yes in a nested repo uses the enclosing repo without gitInit", async () => {
    vi.mocked(gitInfo).mockResolvedValue(gitState(true, true, false, "/big"))
    const deps = makeDeps("ask", true)
    await expect(resolveGitHistory("p1", "/big/wiki", deps)).resolves.toBe(true)
    expect(gitInit).not.toHaveBeenCalled()
    expect(deps.saveMode).toHaveBeenCalledWith("p1", "on")
  })

  it("ask mode no in a nested repo saves off", async () => {
    vi.mocked(gitInfo).mockResolvedValue(gitState(true, true, false, "/big"))
    const deps = makeDeps("ask", false)
    await expect(resolveGitHistory("p1", "/big/wiki", deps)).resolves.toBe(false)
    expect(gitInit).not.toHaveBeenCalled()
    expect(deps.saveMode).toHaveBeenCalledWith("p1", "off")
  })

  it("on mode in a nested repo returns true without gitInit", async () => {
    vi.mocked(gitInfo).mockResolvedValue(gitState(true, true, false, "/big"))
    const deps = makeDeps("on")
    await expect(resolveGitHistory("p1", "/big/wiki", deps)).resolves.toBe(true)
    expect(gitInit).not.toHaveBeenCalled()
    expect(deps.askUser).not.toHaveBeenCalled()
  })

  it("ask mode yes initializes", async () => {
    vi.mocked(gitInfo).mockResolvedValue(gitState(true, false, false))
    vi.mocked(gitInit).mockResolvedValue()
    const deps = makeDeps("ask", true)
    await expect(resolveGitHistory("p1", "/wiki", deps)).resolves.toBe(true)
    expect(deps.askUser).toHaveBeenCalledWith(ASK_MESSAGE)
    expect(gitInit).toHaveBeenCalledWith("/wiki")
    expect(deps.saveMode).toHaveBeenCalledWith("p1", "on")
  })

  it("ask mode no saves off", async () => {
    vi.mocked(gitInfo).mockResolvedValue(gitState(true, false, false))
    const deps = makeDeps("ask", false)
    await expect(resolveGitHistory("p1", "/wiki", deps)).resolves.toBe(false)
    expect(gitInit).not.toHaveBeenCalled()
    expect(deps.saveMode).toHaveBeenCalledWith("p1", "off")
  })

  it("on mode in an existing repo returns true without asking", async () => {
    vi.mocked(gitInfo).mockResolvedValue(gitState(true, true, true, "/wiki"))
    const deps = makeDeps("on")
    await expect(resolveGitHistory("p1", "/wiki", deps)).resolves.toBe(true)
    expect(gitInit).not.toHaveBeenCalled()
    expect(deps.askUser).not.toHaveBeenCalled()
    expect(deps.saveMode).not.toHaveBeenCalled()
  })

  it("on mode re-initializes a missing repo", async () => {
    vi.mocked(gitInfo).mockResolvedValue(gitState(true, false, false))
    vi.mocked(gitInit).mockResolvedValue()
    const deps = makeDeps("on")
    await expect(resolveGitHistory("p1", "/wiki", deps)).resolves.toBe(true)
    expect(gitInit).toHaveBeenCalledWith("/wiki")
    expect(deps.askUser).not.toHaveBeenCalled()
  })

  it("off mode returns false without asking or initializing", async () => {
    vi.mocked(gitInfo).mockResolvedValue(gitState(true, true, true, "/wiki"))
    const deps = makeDeps("off")
    await expect(resolveGitHistory("p1", "/wiki", deps)).resolves.toBe(false)
    expect(gitInit).not.toHaveBeenCalled()
    expect(deps.askUser).not.toHaveBeenCalled()
    expect(deps.saveMode).not.toHaveBeenCalled()
  })

  it("caches per project", async () => {
    vi.mocked(gitInfo).mockResolvedValue(gitState(true, true, true, "/wiki"))
    const deps = makeDeps("on")
    await resolveGitHistory("p1", "/wiki", deps)
    await resolveGitHistory("p1", "/wiki", deps)
    expect(gitInfo).toHaveBeenCalledTimes(1)
    expect(deps.loadMode).toHaveBeenCalledTimes(1)

    await resolveGitHistory("p2", "/other", deps)
    expect(gitInfo).toHaveBeenCalledTimes(2)
  })

  it("asks only once when two ingests resolve at the same time", async () => {
    vi.mocked(gitInfo).mockResolvedValue(gitState(true, false, false))
    vi.mocked(gitInit).mockResolvedValue()
    const deps = makeDeps("ask", true)
    const [a, b] = await Promise.all([
      resolveGitHistory("p1", "/wiki", deps),
      resolveGitHistory("p1", "/wiki", deps),
    ])
    expect([a, b]).toEqual([true, true])
    expect(deps.askUser).toHaveBeenCalledTimes(1)
    expect(gitInit).toHaveBeenCalledTimes(1)
  })

  it("resetGitHistoryCache(projectId) forgets only that project", async () => {
    vi.mocked(gitInfo).mockResolvedValue(gitState(true, true, true, "/wiki"))
    const deps = makeDeps("on")
    await resolveGitHistory("p1", "/wiki", deps)
    await resolveGitHistory("p2", "/other", deps)
    expect(gitInfo).toHaveBeenCalledTimes(2)

    resetGitHistoryCache("p1")
    await resolveGitHistory("p1", "/wiki", deps)
    await resolveGitHistory("p2", "/other", deps)
    expect(gitInfo).toHaveBeenCalledTimes(3)
  })

  it("resetGitHistoryCache forgets cached results", async () => {
    vi.mocked(gitInfo).mockResolvedValue(gitState(true, true, true, "/wiki"))
    const deps = makeDeps("on")
    await resolveGitHistory("p1", "/wiki", deps)
    resetGitHistoryCache()
    await resolveGitHistory("p1", "/wiki", deps)
    expect(gitInfo).toHaveBeenCalledTimes(2)
  })

  it("resolves to off, warns, and does not cache when git fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    vi.mocked(gitInfo).mockResolvedValue(gitState(true, false, false))
    vi.mocked(gitInit).mockRejectedValueOnce(new Error("boom")).mockResolvedValue()
    const deps = makeDeps("ask", true)

    await expect(resolveGitHistory("p1", "/wiki", deps)).resolves.toBe(false)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0][0])).toContain("[git-history]")
    expect(deps.saveMode).not.toHaveBeenCalled()

    await expect(resolveGitHistory("p1", "/wiki", deps)).resolves.toBe(true)
    warn.mockRestore()
  })
})

describe("isGitHistoryOnCached", () => {
  it("reflects the last resolve", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    vi.mocked(gitInfo).mockResolvedValue(gitState(true, true, true, "/wiki"))
    expect(isGitHistoryOnCached("p1")).toBe(false) // never resolved

    expect(getCachedGitHistory("p1")).toBeUndefined()

    const pending = resolveGitHistory("p1", "/wiki", makeDeps("on"))
    expect(isGitHistoryOnCached("p1")).toBe(false) // still pending
    expect(getCachedGitHistory("p1")).toBeUndefined()
    await pending
    expect(isGitHistoryOnCached("p1")).toBe(true)
    expect(getCachedGitHistory("p1")).toBe(true)
    expect(isGitHistoryOnCached("p2")).toBe(false) // per project

    await resolveGitHistory("p2", "/other", makeDeps("off"))
    expect(isGitHistoryOnCached("p2")).toBe(false) // resolved off
    expect(getCachedGitHistory("p2")).toBe(false) // settled, unlike a project never asked about

    resetGitHistoryCache("p1")
    expect(isGitHistoryOnCached("p1")).toBe(false)
    expect(getCachedGitHistory("p1")).toBeUndefined()

    await resolveGitHistory("p1", "/wiki", makeDeps("on"))
    resetGitHistoryCache()
    expect(isGitHistoryOnCached("p1")).toBe(false)
    expect(getCachedGitHistory("p2")).toBeUndefined()

    // A failed resolve is not cached, so it never reads as on.
    vi.mocked(gitInfo).mockRejectedValueOnce(new Error("boom"))
    await resolveGitHistory("p3", "/third", makeDeps("on"))
    expect(isGitHistoryOnCached("p3")).toBe(false)
    expect(getCachedGitHistory("p3")).toBeUndefined()
    warn.mockRestore()
  })

  it("ignores an answer that arrives after the cache was reset", async () => {
    let release!: (info: GitInfo) => void
    vi.mocked(gitInfo).mockReturnValueOnce(
      new Promise((resolve) => {
        release = resolve
      }),
    )
    const stale = resolveGitHistory("p1", "/wiki", makeDeps("on"))
    resetGitHistoryCache("p1")
    release(gitState(true, true, true, "/wiki"))
    await stale
    expect(isGitHistoryOnCached("p1")).toBe(false)
  })
})

const RUN: IngestHistoryRun = { taskId: "task-1", sourcePath: "raw/sources/report.pdf" }

describe("prepareIngestBaseline", () => {
  it("commits pre-existing changes and resolves true", async () => {
    await expect(prepareIngestBaseline("/wiki")).resolves.toBe(true)
    expect(gitCommitAll).toHaveBeenCalledWith("/wiki", "chore: save changes before ingest")
  })

  it("resolves true when there is nothing to commit", async () => {
    vi.mocked(gitCommitAll).mockResolvedValue(null)
    await expect(prepareIngestBaseline("/wiki")).resolves.toBe(true)
  })

  it("resolves false and shows git's reason in the activity panel when the baseline fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    vi.mocked(gitCommitAll).mockRejectedValue(
      "fatal: Unable to create '/wiki/.git/index.lock': File exists.\n\nAnother git process seems to be running.",
    )
    await expect(prepareIngestBaseline("/wiki", RUN)).resolves.toBe(false)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0][0])).toContain("[git-history]")
    expect(activityDetails()).toEqual([
      "Version history could not record this ingest: fatal: Unable to create '/wiki/.git/index.lock': File exists.",
    ])
    expect(useActivityStore.getState().items[0]).toMatchObject({ type: "ingest", status: "error", title: "report.pdf" })
    // No in-flight record without a good baseline.
    expect(diskFiles.has(INFLIGHT)).toBe(false)
    warn.mockRestore()
  })

  it("writes the in-flight record after a good baseline", async () => {
    await prepareIngestBaseline("/wiki", RUN)
    expect(inflightRecord()).toEqual({
      taskId: "task-1",
      sourcePath: "raw/sources/report.pdf",
      baselineSha: "b".repeat(40),
      paths: [],
      startedAt: expect.any(Number),
    })
  })

  it("records HEAD as the baseline when there was nothing to commit", async () => {
    vi.mocked(gitCommitAll).mockResolvedValue(null)
    vi.mocked(gitHead).mockResolvedValue("d".repeat(40))
    await prepareIngestBaseline("/wiki", RUN)
    expect(inflightRecord().baselineSha).toBe("d".repeat(40))
  })
})

describe("trackIngestPath", () => {
  it("adds each written path to the in-flight record once", async () => {
    await prepareIngestBaseline("/wiki", RUN)
    trackIngestPath("/wiki", RUN, "wiki/concepts/a.md")
    trackIngestPath("/wiki", RUN, "wiki/index.md")
    trackIngestPath("/wiki", RUN, "wiki/concepts/a.md")
    await waitFor(() => inflightRecord().paths.length === 2)
    expect(inflightRecord().paths).toEqual(["wiki/concepts/a.md", "wiki/index.md"])
  })

  it("does nothing for a run without a good baseline", async () => {
    trackIngestPath("/wiki", RUN, "wiki/concepts/a.md")
    await Promise.resolve()
    expect(writeFile).not.toHaveBeenCalled()
  })
})

describe("commitIngest", () => {
  it("commits the run's paths, its media folder, its source, its parsed copy, and .gitignore", async () => {
    diskFolders.add("/wiki/wiki/media/report")
    await prepareIngestBaseline("/wiki", RUN)
    trackIngestPath("/wiki", RUN, "wiki/sources/old-name.md")

    const sha = await commitIngest(
      "/wiki",
      "Report",
      ["wiki/sources/report.md", "wiki/concepts/rope.md"],
      RUN,
      ["wiki/concepts/rope.md", "wiki/index.md"],
    )

    expect(sha).toBe("c".repeat(40))
    expect(gitCommitPaths).toHaveBeenCalledTimes(1)
    expect(gitCommitPaths).toHaveBeenCalledWith(
      "/wiki",
      [
        "wiki/sources/report.md",
        "wiki/concepts/rope.md",
        "wiki/index.md",
        "wiki/sources/old-name.md",
        "wiki/media/report/",
        "raw/sources/report.pdf",
        "raw/parsed/report.pdf.md",
        ".gitignore",
      ],
      "ingest: Report (2 pages)\n\n- wiki/sources/report.md\n- wiki/concepts/rope.md",
    )
    expect(gitCommitAll).toHaveBeenCalledTimes(1) // the baseline only
  })

  it("leaves out a media folder that does not exist and a parsed copy for a text source", async () => {
    await commitIngest("/wiki", "Notes", ["wiki/sources/notes.md"], {
      taskId: "t",
      sourcePath: "/wiki/raw/sources/notes.md",
    })
    expect(gitCommitPaths).toHaveBeenCalledWith(
      "/wiki",
      ["wiki/sources/notes.md", "raw/sources/notes.md", ".gitignore"],
      "ingest: Notes (1 pages)\n\n- wiki/sources/notes.md",
    )
  })

  it("commits a saved query page as the source", async () => {
    await commitIngest("/wiki", "q", ["wiki/concepts/a.md"], { taskId: "t", sourcePath: "wiki/queries/q.md" })
    expect(vi.mocked(gitCommitPaths).mock.calls[0][1]).toEqual([
      "wiki/concepts/a.md",
      "wiki/queries/q.md",
      ".gitignore",
    ])
  })

  it("never commits a source outside the project", async () => {
    await commitIngest("/wiki", "x", ["wiki/sources/x.md"], { taskId: "t", sourcePath: "/elsewhere/x.md" })
    expect(vi.mocked(gitCommitPaths).mock.calls[0][1]).toEqual(["wiki/sources/x.md", ".gitignore"])
  })

  it("deletes the in-flight record after the commit", async () => {
    await prepareIngestBaseline("/wiki", RUN)
    expect(diskFiles.has(INFLIGHT)).toBe(true)
    await commitIngest("/wiki", "Report", ["wiki/sources/report.md"], RUN)
    expect(diskFiles.has(INFLIGHT)).toBe(false)
  })

  it("swallows errors, deletes the in-flight record, and shows git's reason in the activity panel", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    await prepareIngestBaseline("/wiki", RUN)
    vi.mocked(gitCommitPaths).mockRejectedValue(new Error("error: insufficient permission\nfatal: failed"))

    await expect(commitIngest("/wiki", "Report", ["wiki/sources/report.md"], RUN)).resolves.toBeNull()

    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0][0])).toContain("[git-history]")
    expect(activityDetails()).toEqual([
      "Version history could not record this ingest: error: insufficient permission",
    ])
    // The ingest itself succeeded: a later baseline must not undo it.
    expect(diskFiles.has(INFLIGHT)).toBe(false)
    warn.mockRestore()
  })
})

describe("restoreFailedIngest", () => {
  it("restores only the paths of the failed run and its media folder", async () => {
    diskFolders.add("/wiki/wiki/media/report")
    await prepareIngestBaseline("/wiki", RUN)
    trackIngestPath("/wiki", RUN, "wiki/concepts/new.md")

    await restoreFailedIngest("/wiki", ["wiki/concepts/edited.md", "wiki/concepts/new.md"], RUN)

    expect(gitRestorePaths).toHaveBeenCalledTimes(1)
    expect(gitRestorePaths).toHaveBeenCalledWith("/wiki", [
      "wiki/concepts/edited.md",
      "wiki/concepts/new.md",
      "wiki/media/report/",
    ])
  })

  it("never asks git to restore wiki/ as a whole, raw/, or .llm-wiki/", async () => {
    await restoreFailedIngest(
      "/wiki",
      ["wiki", "wiki/", "raw/sources/report.pdf", ".llm-wiki/cache.json", "../x", "/abs/wiki/a.md", "wiki/ok.md"],
      RUN,
    )
    expect(gitRestorePaths).toHaveBeenCalledWith("/wiki", ["wiki/ok.md"])
  })

  it("does not call git when there is nothing to restore", async () => {
    await restoreFailedIngest("/wiki", [], RUN)
    expect(gitRestorePaths).not.toHaveBeenCalled()
    expect(invalidateProjectFileSnapshotPaths).not.toHaveBeenCalled()
  })

  it("tells the file watcher about the restored paths before it restores them", async () => {
    await restoreFailedIngest("/wiki", ["wiki/concepts/new.md", "wiki/index.md"], RUN)
    expect(invalidateProjectFileSnapshotPaths).toHaveBeenCalledWith("/wiki", [
      "wiki/concepts/new.md",
      "wiki/index.md",
    ])
    expect(vi.mocked(invalidateProjectFileSnapshotPaths).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(gitRestorePaths).mock.invocationCallOrder[0],
    )
  })

  it("clears the resume state of the source and deletes the in-flight record", async () => {
    await prepareIngestBaseline("/wiki", RUN)
    await restoreFailedIngest("/wiki", ["wiki/concepts/new.md"], RUN)
    expect(clearIngestResumeState).toHaveBeenCalledWith("/wiki", "raw/sources/report.pdf")
    expect(diskFiles.has(INFLIGHT)).toBe(false)
  })

  it("swallows errors and shows a warning in the activity panel", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    vi.mocked(gitRestorePaths).mockRejectedValue(new Error("nope"))
    await expect(restoreFailedIngest("/wiki", ["wiki/a.md"], RUN)).resolves.toBeUndefined()
    expect(warn).toHaveBeenCalled()
    expect(String(warn.mock.calls[0][0])).toContain("[git-history]")
    expect(activityDetails()).toEqual([
      "Version history could not put back the files of this ingest: nope",
    ])
    warn.mockRestore()
  })

  it("skips a run whose files a newer baseline already put back", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const stale: IngestHistoryRun = { taskId: "task-1", sourcePath: "raw/sources/a.md" }
    const fresh: IngestHistoryRun = { taskId: "task-1", sourcePath: "raw/sources/a.md" }
    vi.mocked(gitHead).mockResolvedValue("b".repeat(40))
    await prepareIngestBaseline("/wiki", stale)
    trackIngestPath("/wiki", stale, "wiki/concepts/a.md")

    await prepareIngestBaseline("/wiki", fresh)
    expect(gitRestorePaths).toHaveBeenCalledTimes(1)
    expect(gitRestorePaths).toHaveBeenCalledWith("/wiki", ["wiki/concepts/a.md"])

    await restoreFailedIngest("/wiki", ["wiki/concepts/a.md"], stale)
    expect(gitRestorePaths).toHaveBeenCalledTimes(1)
    // The fresh run still owns the in-flight record.
    expect(inflightRecord().paths).toEqual([])
    warn.mockRestore()
  })
})

describe("recoverInterruptedIngest", () => {
  function writeRecord(record: Record<string, unknown>): void {
    diskFiles.set(INFLIGHT, JSON.stringify(record))
  }
  const RECORD = {
    taskId: "task-9",
    sourcePath: "raw/sources/crashed.md",
    baselineSha: "b".repeat(40),
    paths: ["wiki/concepts/partial.md", "wiki/index.md"],
    startedAt: 1,
  }

  it("puts back the paths of an interrupted ingest when HEAD is still its baseline", async () => {
    writeRecord(RECORD)
    vi.mocked(gitHead).mockResolvedValue("b".repeat(40))

    await recoverInterruptedIngest("/wiki")

    expect(invalidateProjectFileSnapshotPaths).toHaveBeenCalledWith("/wiki", RECORD.paths)
    expect(gitRestorePaths).toHaveBeenCalledWith("/wiki", RECORD.paths)
    expect(clearIngestResumeState).toHaveBeenCalledWith("/wiki", "raw/sources/crashed.md")
    expect(diskFiles.has(INFLIGHT)).toBe(false)
    expect(activityDetails()).toEqual([
      "Version history put back 2 files of an ingest that was interrupted.",
    ])
  })

  it("only deletes the record when HEAD moved on", async () => {
    writeRecord(RECORD)
    vi.mocked(gitHead).mockResolvedValue("e".repeat(40))

    await recoverInterruptedIngest("/wiki")

    expect(gitRestorePaths).not.toHaveBeenCalled()
    expect(clearIngestResumeState).not.toHaveBeenCalled()
    expect(diskFiles.has(INFLIGHT)).toBe(false)
  })

  it("does nothing without a record", async () => {
    await recoverInterruptedIngest("/wiki")
    expect(gitHead).not.toHaveBeenCalled()
    expect(gitRestorePaths).not.toHaveBeenCalled()
  })

  it("deletes a record it cannot read", async () => {
    diskFiles.set(INFLIGHT, "{not json")
    await recoverInterruptedIngest("/wiki")
    expect(gitRestorePaths).not.toHaveBeenCalled()
    expect(diskFiles.has(INFLIGHT)).toBe(false)
  })

  it("runs before the next baseline", async () => {
    writeRecord(RECORD)
    vi.mocked(gitHead).mockResolvedValue("b".repeat(40))

    await prepareIngestBaseline("/wiki", RUN)

    expect(vi.mocked(gitRestorePaths).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(gitCommitAll).mock.invocationCallOrder[0],
    )
    expect(inflightRecord().taskId).toBe("task-1")
  })
})

describe("git action order", () => {
  it("runs the git actions of one project one at a time, in call order", async () => {
    const restore = createDeferred<void>()
    vi.mocked(gitRestorePaths).mockImplementationOnce(() => restore.promise)

    const stale = restoreFailedIngest("/wiki", ["wiki/a.md"], RUN)
    const baseline = prepareIngestBaseline("/wiki", { taskId: "task-2", sourcePath: "raw/sources/b.md" })
    const other = prepareIngestBaseline("/other")
    await other
    await waitFor(() => vi.mocked(gitRestorePaths).mock.calls.length === 1)
    // Another project is not held up, but this project's baseline waits for the restore.
    expect(vi.mocked(gitCommitAll).mock.calls.map((call) => call[0])).toEqual(["/other"])

    restore.resolve()
    await stale
    await expect(baseline).resolves.toBe(true)
    expect(vi.mocked(gitCommitAll).mock.calls.map((call) => call[0])).toEqual(["/other", "/wiki"])
  })

  it("keeps going after a failed action", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    vi.mocked(gitRestorePaths).mockRejectedValueOnce(new Error("boom"))
    await restoreFailedIngest("/wiki", ["wiki/a.md"], RUN)
    await expect(prepareIngestBaseline("/wiki")).resolves.toBe(true)
    warn.mockRestore()
  })
})
