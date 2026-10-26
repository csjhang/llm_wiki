import { beforeEach, describe, expect, it, vi } from "vitest"

const files = vi.hoisted(() => ({ map: new Map<string, string>() }))

vi.mock("@/commands/fs", () => ({
  fileExists: vi.fn(async (path: string) => files.map.has(path)),
  readFile: vi.fn(async (path: string) => {
    const text = files.map.get(path)
    if (text === undefined) throw new Error(`No such file: ${path}`)
    return text
  }),
}))
vi.mock("@/commands/git", () => ({ gitCountSubjects: vi.fn() }))

import { gitCountSubjects } from "@/commands/git"
import {
  INGEST_SUBJECT_PREFIX,
  ingestsSinceSemanticLint,
  loadLintReminder,
  parseMarkerCommit,
  reminderDue,
} from "./lint-reminder"

const PROJECT = "/projects/wiki"
const MARKER_PATH = `${PROJECT}/.llm-wiki/semantic-lint.json`
const SHA = "0123456789abcdef0123456789abcdef01234567"

function markerText(commit: unknown): string {
  return JSON.stringify({ commit, at: "2026-10-01T00:00:00.000Z" })
}

beforeEach(() => {
  vi.resetAllMocks()
  files.map.clear()
  vi.mocked(gitCountSubjects).mockResolvedValue(0)
})

describe("parseMarkerCommit", () => {
  it("returns the commit of the marker in lower case", () => {
    expect(parseMarkerCommit(markerText(SHA))).toBe(SHA)
    expect(parseMarkerCommit(markerText(SHA.toUpperCase()))).toBe(SHA)
  })

  it("accepts 7 to 64 hex digits", () => {
    expect(parseMarkerCommit(markerText("abcdef0"))).toBe("abcdef0")
    expect(parseMarkerCommit(markerText("a".repeat(64)))).toBe("a".repeat(64))
    expect(parseMarkerCommit(markerText("abcdef"))).toBeNull()
    expect(parseMarkerCommit(markerText("a".repeat(65)))).toBeNull()
  })

  it("reads a marker with a byte order mark", () => {
    expect(parseMarkerCommit(`\uFEFF${markerText(SHA)}`)).toBe(SHA)
  })

  it("returns null for a marker that git must not see", () => {
    for (const bad of ["HEAD", "main", "--output=x", "-p", "abcdef0 -p", "abcdef0\n", "", 42, null]) {
      expect(parseMarkerCommit(markerText(bad)), JSON.stringify(bad)).toBeNull()
    }
  })

  it("returns null for text that is not a marker", () => {
    expect(parseMarkerCommit("not json")).toBeNull()
    expect(parseMarkerCommit("")).toBeNull()
    expect(parseMarkerCommit("[]")).toBeNull()
    expect(parseMarkerCommit("null")).toBeNull()
    expect(parseMarkerCommit(JSON.stringify({ at: "2026-10-01T00:00:00.000Z" }))).toBeNull()
  })
})

describe("ingestsSinceSemanticLint", () => {
  it("no marker counts all ingests", async () => {
    vi.mocked(gitCountSubjects).mockResolvedValue(7)

    expect(await ingestsSinceSemanticLint(PROJECT)).toBe(7)
    expect(gitCountSubjects).toHaveBeenCalledWith(PROJECT, null, INGEST_SUBJECT_PREFIX)
    expect(INGEST_SUBJECT_PREFIX).toBe("ingest:")
  })

  it("counts the ingests after the commit of the marker", async () => {
    files.map.set(MARKER_PATH, markerText(SHA))
    vi.mocked(gitCountSubjects).mockResolvedValue(3)

    expect(await ingestsSinceSemanticLint(PROJECT)).toBe(3)
    expect(gitCountSubjects).toHaveBeenCalledWith(PROJECT, SHA, "ingest:")
  })

  it("a marker that cannot be used counts all ingests", async () => {
    for (const text of ["not json", markerText("--output=x"), markerText("HEAD"), "{}"]) {
      files.map.set(MARKER_PATH, text)
      vi.mocked(gitCountSubjects).mockClear()

      await ingestsSinceSemanticLint(PROJECT)

      expect(gitCountSubjects, text).toHaveBeenCalledWith(PROJECT, null, "ingest:")
    }
  })

  it("reads the marker in a project path with a trailing slash or backslashes", async () => {
    files.map.set(MARKER_PATH, markerText(SHA))

    await ingestsSinceSemanticLint(`${PROJECT}/`)
    expect(gitCountSubjects).toHaveBeenLastCalledWith(`${PROJECT}/`, SHA, "ingest:")

    files.map.clear()
    files.map.set("C:/wikis/one/.llm-wiki/semantic-lint.json", markerText(SHA))
    await ingestsSinceSemanticLint("C:\\wikis\\one")
    expect(gitCountSubjects).toHaveBeenLastCalledWith("C:\\wikis\\one", SHA, "ingest:")
  })

  it("passes a git error on", async () => {
    vi.mocked(gitCountSubjects).mockRejectedValue(new Error("not a git repository"))

    await expect(ingestsSinceSemanticLint(PROJECT)).rejects.toThrow("not a git repository")
  })
})

describe("reminderDue", () => {
  it("reminder appears at threshold", () => {
    expect(reminderDue(9, 10)).toBe(false)
    expect(reminderDue(10, 10)).toBe(true)
    expect(reminderDue(11, 10)).toBe(true)
  })

  it("never appears for an unknown count or no ingest", () => {
    expect(reminderDue(null, 10)).toBe(false)
    expect(reminderDue(0, 10)).toBe(false)
    expect(reminderDue(0, 0)).toBe(false)
  })
})

describe("loadLintReminder", () => {
  function setThreshold(lines: string): void {
    files.map.set(`${PROJECT}/wiki.yaml`, `version: 1\nid: test\nrole: reading\n${lines}`)
  }

  it("uses the threshold of wiki.yaml", async () => {
    setThreshold("lint:\n  semantic_reminder_ingests: 3\n")
    vi.mocked(gitCountSubjects).mockResolvedValue(3)

    expect(await loadLintReminder(PROJECT)).toEqual({ count: 3, threshold: 3, due: true })

    vi.mocked(gitCountSubjects).mockResolvedValue(2)
    expect(await loadLintReminder(PROJECT)).toEqual({ count: 2, threshold: 3, due: false })
  })

  it("uses the default threshold of 10 without a wiki.yaml, or with a broken one", async () => {
    vi.mocked(gitCountSubjects).mockResolvedValue(10)
    expect(await loadLintReminder(PROJECT)).toEqual({ count: 10, threshold: 10, due: true })

    files.map.set(`${PROJECT}/wiki.yaml`, "version: 1\nid: Not Valid\nrole: nobody\n")
    vi.mocked(gitCountSubjects).mockResolvedValue(9)
    expect(await loadLintReminder(PROJECT)).toEqual({ count: 9, threshold: 10, due: false })
  })

  it("uses the default for a bad threshold and keeps the file valid", async () => {
    setThreshold("lint:\n  semantic_reminder_ingests: soon\n")
    vi.mocked(gitCountSubjects).mockResolvedValue(10)

    expect(await loadLintReminder(PROJECT)).toEqual({ count: 10, threshold: 10, due: true })
  })

  it("no reminder, and a logged error, when git fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    vi.mocked(gitCountSubjects).mockRejectedValue(new Error("git is not installed or not runnable"))

    expect(await loadLintReminder(PROJECT)).toBeNull()
    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0].join(" "))).toContain("git is not installed or not runnable")
    warn.mockRestore()
  })
})
