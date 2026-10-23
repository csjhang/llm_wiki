import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { buildActionCommitMessage, titleFromSourcePath } from "./commit-message"

describe("buildActionCommitMessage", () => {
  it("builds an ingest message", () => {
    expect(
      buildActionCommitMessage("ingest", "Async circuits", [
        "wiki/sources/a.md",
        "wiki/concepts/b.md",
      ]),
    ).toBe(
      "ingest: Async circuits (2 pages)\n\n- wiki/sources/a.md\n- wiki/concepts/b.md",
    )
  })

  it("uses the given prefix", () => {
    for (const prefix of ["fuse", "recut", "lint"] as const) {
      expect(buildActionCommitMessage(prefix, "T", ["wiki/a.md"])).toBe(
        `${prefix}: T (1 pages)\n\n- wiki/a.md`,
      )
    }
  })

  it("truncates long titles so the subject is exactly 72 characters", () => {
    const message = buildActionCommitMessage("ingest", "x".repeat(200), [
      "wiki/a.md",
      "wiki/b.md",
      "wiki/c.md",
    ])
    const subject = message.split("\n")[0]
    expect(subject).toHaveLength(72)
    expect(subject.endsWith("… (3 pages)")).toBe(true)
    expect(subject.startsWith("ingest: xxx")).toBe(true)
  })

  it("keeps a subject of exactly 72 characters untouched", () => {
    const suffix = " (1 pages)"
    const title = "y".repeat(72 - "ingest: ".length - suffix.length)
    const subject = buildActionCommitMessage("ingest", title, ["wiki/a.md"]).split("\n")[0]
    expect(subject).toBe(`ingest: ${title}${suffix}`)
    expect(subject).toHaveLength(72)
  })

  it("truncates a subject that is one character over", () => {
    const suffix = " (1 pages)"
    const title = "y".repeat(72 - "ingest: ".length - suffix.length + 1)
    const subject = buildActionCommitMessage("ingest", title, ["wiki/a.md"]).split("\n")[0]
    expect(subject).toHaveLength(72)
    expect(subject).toBe(`ingest: ${"y".repeat(title.length - 1 - 1)}…${suffix}`)
  })

  it("collapses whitespace in the title", () => {
    const subject = buildActionCommitMessage("ingest", "  Async \n\t circuits  ", [
      "wiki/a.md",
    ]).split("\n")[0]
    expect(subject).toBe("ingest: Async circuits (1 pages)")
  })

  it("does not split a surrogate pair when truncating", () => {
    const subject = buildActionCommitMessage("ingest", "😀".repeat(80), [
      "wiki/a.md",
    ]).split("\n")[0]
    expect(subject.length).toBeLessThanOrEqual(72)
    expect(subject).not.toMatch(/[\uD800-\uDBFF]…/)
    expect(subject.endsWith("… (1 pages)")).toBe(true)
  })

  it("normalizes backslashes in paths", () => {
    const message = buildActionCommitMessage("ingest", "T", ["wiki\\sources\\a.md"])
    expect(message).toBe("ingest: T (1 pages)\n\n- wiki/sources/a.md")
  })

  it("uses untitled when the title is empty or only whitespace", () => {
    expect(buildActionCommitMessage("ingest", "", ["wiki/a.md"]).split("\n")[0]).toBe(
      "ingest: untitled (1 pages)",
    )
    expect(buildActionCommitMessage("lint", " \n\t ", []).split("\n")[0]).toBe(
      "lint: untitled (0 pages)",
    )
  })

  it("omits the body when there are no files", () => {
    expect(buildActionCommitMessage("lint", "Fixes", [])).toBe("lint: Fixes (0 pages)")
  })
})

describe("titleFromSourcePath", () => {
  it("returns the file name without extension", () => {
    expect(titleFromSourcePath("raw/sources/franchise-licensing.md")).toBe(
      "franchise-licensing",
    )
  })

  it("keeps the id of a heptabase source", () => {
    expect(titleFromSourcePath("raw/sources/heptabase/9f3a-12bc.md")).toBe("9f3a-12bc")
  })

  it("handles backslash paths and only strips the last extension", () => {
    expect(titleFromSourcePath("raw\\sources\\report.v2.pdf")).toBe("report.v2")
  })

  it("returns untitled when the path has no file name", () => {
    expect(titleFromSourcePath("")).toBe("untitled")
    expect(titleFromSourcePath("raw/sources/")).toBe("untitled")
    expect(titleFromSourcePath("raw\\sources\\")).toBe("untitled")
  })

  it("keeps a name with no extension", () => {
    expect(titleFromSourcePath("raw/sources/README")).toBe("README")
  })
})

describe("commit-message.ts purity", () => {
  it("has no import lines, so the bundled wiki-tool can reuse it", () => {
    const source = readFileSync(new URL("./commit-message.ts", import.meta.url), "utf8")
    expect(source).not.toMatch(/^\s*import[\s{*"']/m)
    expect(source).not.toMatch(/\brequire\s*\(/)
    expect(source).not.toMatch(/\bimport\s*\(/)
  })
})
