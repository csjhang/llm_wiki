import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("@/commands/git", () => ({
  gitInfo: vi.fn(),
  gitInit: vi.fn(),
  gitCommitAll: vi.fn(),
  gitCommitPaths: vi.fn(),
  gitRestorePaths: vi.fn(),
  gitHead: vi.fn(),
}))
vi.mock("@/commands/fs", () => ({
  readFile: vi.fn(),
  writeFile: vi.fn(),
  deleteFile: vi.fn(),
  fileExists: vi.fn(),
}))
vi.mock("@/commands/file-sync", () => ({ invalidateProjectFileSnapshotPaths: vi.fn() }))
vi.mock("@/lib/ingest", () => ({ clearIngestResumeState: vi.fn() }))
vi.mock("@/lib/project-store", () => ({ getStore: vi.fn() }))
vi.mock("@tauri-apps/plugin-dialog", () => ({ ask: vi.fn() }))

import { gitCommitPaths, gitInfo, gitInit, type GitInfo } from "@/commands/git"
import { fileExists } from "@/commands/fs"
import {
  commitIngest,
  getCachedGitHistory,
  resetGitHistoryCache,
  resetIngestHistoryRuns,
  resolveGitHistory,
  type GitHistoryDeps,
  type GitHistoryMode,
} from "./git-history"
import { loadGitHistoryEnabled, setGitHistoryEnabled } from "./git-history-setting"

const PROJECT_ID = "project-1"
const PROJECT_PATH = "/wiki"

function gitState(available: boolean, isRepo: boolean, isRoot: boolean): GitInfo {
  return { available, isRepo, isRoot, topLevel: null }
}

/** The deps with an in-memory store: what `saveMode` writes, `loadMode` reads. */
function makeDeps(initial: GitHistoryMode = "ask", answer = true) {
  const modes = new Map<string, GitHistoryMode>([[PROJECT_ID, initial]])
  const deps: GitHistoryDeps = {
    loadMode: vi.fn(async (id: string) => modes.get(id) ?? "ask"),
    saveMode: vi.fn(async (id: string, mode: GitHistoryMode) => {
      modes.set(id, mode)
    }),
    askUser: vi.fn(async () => answer),
  }
  return { deps, modes }
}

/** What the ingest queue does before a run: the cached answer, else the question. */
async function ingestDecision(deps: GitHistoryDeps): Promise<boolean> {
  return getCachedGitHistory(PROJECT_ID) ?? (await resolveGitHistory(PROJECT_ID, PROJECT_PATH, deps))
}

beforeEach(() => {
  vi.resetAllMocks()
  resetGitHistoryCache()
  resetIngestHistoryRuns()
  vi.mocked(fileExists).mockResolvedValue(false)
  vi.mocked(gitInfo).mockResolvedValue(gitState(true, false, false))
  vi.mocked(gitInit).mockResolvedValue(undefined)
  vi.mocked(gitCommitPaths).mockResolvedValue("c".repeat(40))
})

describe("setGitHistoryEnabled", () => {
  it("toggle on resets cache and next ingest commits", async () => {
    // The user answered "No" at the first ingest: the answer is stored and cached.
    const { deps, modes } = makeDeps("ask", false)
    expect(await resolveGitHistory(PROJECT_ID, PROJECT_PATH, deps)).toBe(false)
    expect(modes.get(PROJECT_ID)).toBe("off")
    expect(getCachedGitHistory(PROJECT_ID)).toBe(false)
    expect(await ingestDecision(deps)).toBe(false)

    const on = await setGitHistoryEnabled(PROJECT_ID, PROJECT_PATH, true, deps)

    expect(on).toBe(true)
    expect(modes.get(PROJECT_ID)).toBe("on")
    // The "No" is forgotten: the next ingest sees "on" and commits, without a new question.
    expect(getCachedGitHistory(PROJECT_ID)).toBe(true)
    expect(await ingestDecision(deps)).toBe(true)
    expect(deps.askUser).toHaveBeenCalledTimes(1)
    const sha = await commitIngest(PROJECT_PATH, "A source", ["wiki/a.md"])
    expect(sha).toBe("c".repeat(40))
    expect(gitCommitPaths).toHaveBeenCalledTimes(1)
  })

  it("starts the repository through the path of resolveGitHistory when the project has none", async () => {
    const { deps } = makeDeps("off")
    vi.mocked(gitInfo).mockResolvedValue(gitState(true, false, false))

    await setGitHistoryEnabled(PROJECT_ID, PROJECT_PATH, true, deps)

    expect(gitInit).toHaveBeenCalledTimes(1)
    expect(gitInit).toHaveBeenCalledWith(PROJECT_PATH)
  })

  it("does not start a second repository when the project already has one", async () => {
    const { deps } = makeDeps("off")
    vi.mocked(gitInfo).mockResolvedValue(gitState(true, true, true))

    expect(await setGitHistoryEnabled(PROJECT_ID, PROJECT_PATH, true, deps)).toBe(true)

    expect(gitInit).not.toHaveBeenCalled()
  })

  it("keeps the earlier choice and says no when git cannot be used", async () => {
    const { deps, modes } = makeDeps("off")
    vi.mocked(gitInfo).mockResolvedValue(gitState(false, false, false))

    expect(await setGitHistoryEnabled(PROJECT_ID, PROJECT_PATH, true, deps)).toBe(false)

    expect(modes.get(PROJECT_ID)).toBe("off")
    expect(getCachedGitHistory(PROJECT_ID)).toBeUndefined()
    expect(gitInit).not.toHaveBeenCalled()
    expect(await loadGitHistoryEnabled(PROJECT_ID, deps)).toBe(false)
  })

  it("keeps the earlier choice and says no when the repository cannot be started", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const { deps, modes } = makeDeps("ask")
    vi.mocked(gitInit).mockRejectedValue(new Error("permission denied"))

    expect(await setGitHistoryEnabled(PROJECT_ID, PROJECT_PATH, true, deps)).toBe(false)

    expect(modes.get(PROJECT_ID)).toBe("ask")
    warn.mockRestore()
  })

  it("turning off saves off, forgets the cached answer, and the next ingest does not commit", async () => {
    const { deps, modes } = makeDeps("on")
    vi.mocked(gitInfo).mockResolvedValue(gitState(true, true, true))
    expect(await ingestDecision(deps)).toBe(true)
    vi.mocked(gitInfo).mockClear()

    const on = await setGitHistoryEnabled(PROJECT_ID, PROJECT_PATH, false, deps)

    expect(on).toBe(false)
    expect(modes.get(PROJECT_ID)).toBe("off")
    expect(getCachedGitHistory(PROJECT_ID)).toBeUndefined()
    expect(await ingestDecision(deps)).toBe(false)
    // A stored "off" needs no git probe, and no question.
    expect(gitInfo).not.toHaveBeenCalled()
    expect(deps.askUser).not.toHaveBeenCalled()
  })

  it("another project keeps its answer", async () => {
    const { deps } = makeDeps("on")
    vi.mocked(gitInfo).mockResolvedValue(gitState(true, true, true))
    await resolveGitHistory("other-project", "/other", deps)
    expect(getCachedGitHistory("other-project")).toBe(true)

    await setGitHistoryEnabled(PROJECT_ID, PROJECT_PATH, false, deps)

    expect(getCachedGitHistory("other-project")).toBe(true)
  })

  it("rejects when the choice cannot be saved, and changes nothing else", async () => {
    const { deps } = makeDeps("off")
    vi.mocked(deps.saveMode).mockRejectedValue(new Error("disk full"))
    await resolveGitHistory(PROJECT_ID, PROJECT_PATH, deps)
    expect(getCachedGitHistory(PROJECT_ID)).toBe(false)

    await expect(setGitHistoryEnabled(PROJECT_ID, PROJECT_PATH, true, deps)).rejects.toThrow("disk full")

    expect(gitInit).not.toHaveBeenCalled()
    expect(getCachedGitHistory(PROJECT_ID)).toBe(false)
  })
})

describe("loadGitHistoryEnabled", () => {
  it("is true only for a stored on", async () => {
    expect(await loadGitHistoryEnabled(PROJECT_ID, makeDeps("on").deps)).toBe(true)
    expect(await loadGitHistoryEnabled(PROJECT_ID, makeDeps("off").deps)).toBe(false)
    // Nothing stored yet: the first ingest will ask.
    expect(await loadGitHistoryEnabled(PROJECT_ID, makeDeps("ask").deps)).toBe(false)
  })
})
