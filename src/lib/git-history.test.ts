import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("@/commands/git", () => ({
  gitInfo: vi.fn(),
  gitInit: vi.fn(),
  gitCommitAll: vi.fn(),
  gitRestoreDir: vi.fn(),
}))

const storeData = new Map<string, unknown>()
const fakeStore = {
  get: vi.fn(async (key: string) => storeData.get(key)),
  set: vi.fn(async (key: string, value: unknown) => {
    storeData.set(key, value)
  }),
  save: vi.fn(async () => {}),
}
vi.mock("@tauri-apps/plugin-store", () => ({ load: vi.fn(async () => fakeStore) }))
vi.mock("@tauri-apps/plugin-dialog", () => ({ ask: vi.fn() }))

import { ask } from "@tauri-apps/plugin-dialog"
import { gitCommitAll, gitInfo, gitInit, gitRestoreDir } from "@/commands/git"
import {
  buildActionCommitMessage,
  commitIngest,
  defaultGitHistoryDeps,
  prepareIngestBaseline,
  resetGitHistoryCache,
  resolveGitHistory,
  restoreFailedIngest,
  titleFromSourcePath,
  type GitHistoryDeps,
  type GitHistoryMode,
} from "./git-history"

const ASK_MESSAGE =
  "Turn on version history for this wiki? Each ingest becomes one git commit that you can undo."

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
    vi.mocked(gitInfo).mockResolvedValue({ available: false, isRepo: false })
    const deps = makeDeps("ask")
    await expect(resolveGitHistory("p1", "/wiki", deps)).resolves.toBe(false)
    expect(deps.saveMode).not.toHaveBeenCalled()
    expect(deps.askUser).not.toHaveBeenCalled()
    expect(gitInit).not.toHaveBeenCalled()
  })

  it("ask mode in an existing repo saves on", async () => {
    vi.mocked(gitInfo).mockResolvedValue({ available: true, isRepo: true })
    const deps = makeDeps("ask")
    await expect(resolveGitHistory("p1", "/wiki", deps)).resolves.toBe(true)
    expect(deps.askUser).not.toHaveBeenCalled()
    expect(gitInit).not.toHaveBeenCalled()
    expect(deps.saveMode).toHaveBeenCalledWith("p1", "on")
  })

  it("ask mode yes initializes", async () => {
    vi.mocked(gitInfo).mockResolvedValue({ available: true, isRepo: false })
    vi.mocked(gitInit).mockResolvedValue()
    const deps = makeDeps("ask", true)
    await expect(resolveGitHistory("p1", "/wiki", deps)).resolves.toBe(true)
    expect(deps.askUser).toHaveBeenCalledWith(ASK_MESSAGE)
    expect(gitInit).toHaveBeenCalledWith("/wiki")
    expect(deps.saveMode).toHaveBeenCalledWith("p1", "on")
  })

  it("ask mode no saves off", async () => {
    vi.mocked(gitInfo).mockResolvedValue({ available: true, isRepo: false })
    const deps = makeDeps("ask", false)
    await expect(resolveGitHistory("p1", "/wiki", deps)).resolves.toBe(false)
    expect(gitInit).not.toHaveBeenCalled()
    expect(deps.saveMode).toHaveBeenCalledWith("p1", "off")
  })

  it("on mode in an existing repo returns true without asking", async () => {
    vi.mocked(gitInfo).mockResolvedValue({ available: true, isRepo: true })
    const deps = makeDeps("on")
    await expect(resolveGitHistory("p1", "/wiki", deps)).resolves.toBe(true)
    expect(gitInit).not.toHaveBeenCalled()
    expect(deps.askUser).not.toHaveBeenCalled()
    expect(deps.saveMode).not.toHaveBeenCalled()
  })

  it("on mode re-initializes a missing repo", async () => {
    vi.mocked(gitInfo).mockResolvedValue({ available: true, isRepo: false })
    vi.mocked(gitInit).mockResolvedValue()
    const deps = makeDeps("on")
    await expect(resolveGitHistory("p1", "/wiki", deps)).resolves.toBe(true)
    expect(gitInit).toHaveBeenCalledWith("/wiki")
    expect(deps.askUser).not.toHaveBeenCalled()
  })

  it("off mode returns false without asking or initializing", async () => {
    vi.mocked(gitInfo).mockResolvedValue({ available: true, isRepo: true })
    const deps = makeDeps("off")
    await expect(resolveGitHistory("p1", "/wiki", deps)).resolves.toBe(false)
    expect(gitInit).not.toHaveBeenCalled()
    expect(deps.askUser).not.toHaveBeenCalled()
    expect(deps.saveMode).not.toHaveBeenCalled()
  })

  it("caches per project", async () => {
    vi.mocked(gitInfo).mockResolvedValue({ available: true, isRepo: true })
    const deps = makeDeps("on")
    await resolveGitHistory("p1", "/wiki", deps)
    await resolveGitHistory("p1", "/wiki", deps)
    expect(gitInfo).toHaveBeenCalledTimes(1)
    expect(deps.loadMode).toHaveBeenCalledTimes(1)

    await resolveGitHistory("p2", "/other", deps)
    expect(gitInfo).toHaveBeenCalledTimes(2)
  })

  it("asks only once when two ingests resolve at the same time", async () => {
    vi.mocked(gitInfo).mockResolvedValue({ available: true, isRepo: false })
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

  it("resetGitHistoryCache forgets cached results", async () => {
    vi.mocked(gitInfo).mockResolvedValue({ available: true, isRepo: true })
    const deps = makeDeps("on")
    await resolveGitHistory("p1", "/wiki", deps)
    resetGitHistoryCache()
    await resolveGitHistory("p1", "/wiki", deps)
    expect(gitInfo).toHaveBeenCalledTimes(2)
  })

  it("resolves to off, warns, and does not cache when git fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    vi.mocked(gitInfo).mockResolvedValue({ available: true, isRepo: false })
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

describe("ingest git actions", () => {
  it("baseline commits pre-existing changes", async () => {
    vi.mocked(gitCommitAll).mockResolvedValue("abc")
    await prepareIngestBaseline("/wiki")
    expect(gitCommitAll).toHaveBeenCalledWith("/wiki", "chore: save changes before ingest")
  })

  it("baseline swallows errors", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    vi.mocked(gitCommitAll).mockRejectedValue(new Error("nope"))
    await expect(prepareIngestBaseline("/wiki")).resolves.toBeUndefined()
    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0][0])).toContain("[git-history]")
    warn.mockRestore()
  })

  it("commitIngest commits one message with the written files", async () => {
    vi.mocked(gitCommitAll).mockResolvedValue("deadbeef")
    const sha = await commitIngest("/wiki", "Async circuits", ["wiki/sources/a.md"])
    expect(sha).toBe("deadbeef")
    expect(gitCommitAll).toHaveBeenCalledWith(
      "/wiki",
      "ingest: Async circuits (1 pages)\n\n- wiki/sources/a.md",
    )
  })

  it("commitIngest swallows errors", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    vi.mocked(gitCommitAll).mockRejectedValue(new Error("nope"))
    await expect(commitIngest("/wiki", "T", ["wiki/a.md"])).resolves.toBeNull()
    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0][0])).toContain("[git-history]")
    warn.mockRestore()
  })

  it("restoreFailedIngest restores wiki only", async () => {
    vi.mocked(gitRestoreDir).mockResolvedValue()
    await restoreFailedIngest("/wiki")
    expect(gitRestoreDir).toHaveBeenCalledTimes(1)
    expect(gitRestoreDir).toHaveBeenCalledWith("/wiki", "wiki")
  })

  it("restoreFailedIngest swallows errors", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    vi.mocked(gitRestoreDir).mockRejectedValue(new Error("nope"))
    await expect(restoreFailedIngest("/wiki")).resolves.toBeUndefined()
    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0][0])).toContain("[git-history]")
    warn.mockRestore()
  })
})
