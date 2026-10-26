/**
 * marker.test.ts - tests for the marker file of the semantic lint (`.llm-wiki/semantic-lint.json`).
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { makeProject, removeProjects, writeProjectFile } from "../test-project"
import { MARKER_FILE, readMarker, writeMarker } from "./marker"

afterEach(removeProjects)

const SHA = "0123456789abcdef0123456789abcdef01234567"

function projectWithMarker(text: string | null): string {
  const project = makeProject({}, { noHeptabaseYaml: true })
  if (text !== null) writeProjectFile(project, MARKER_FILE, text)
  return project
}

describe("readMarker", () => {
  it("a missing file is no marker", () => {
    expect(readMarker(projectWithMarker(null))).toEqual({ kind: "none" })
  })

  it("reads the commit, in lower case", () => {
    expect(readMarker(projectWithMarker(JSON.stringify({ commit: SHA, at: "2026-10-01T00:00:00.000Z" })))).toEqual({
      kind: "commit",
      commit: SHA,
    })
    expect(readMarker(projectWithMarker(JSON.stringify({ commit: SHA.toUpperCase() })))).toEqual({ kind: "commit", commit: SHA })
    expect(readMarker(projectWithMarker(JSON.stringify({ commit: SHA.slice(0, 7) })))).toEqual({
      kind: "commit",
      commit: SHA.slice(0, 7),
    })
  })

  it("ignores a byte order mark", () => {
    expect(readMarker(projectWithMarker(`\uFEFF${JSON.stringify({ commit: SHA })}`))).toEqual({ kind: "commit", commit: SHA })
  })

  it("text that is not JSON is bad, and says so", () => {
    const state = readMarker(projectWithMarker("{ not json"))
    expect(state).toEqual({ kind: "bad", reason: "it is not valid JSON" })
  })

  it("a file that cannot be read is bad, and says so", () => {
    const project = projectWithMarker(null)
    // A folder in the place of the file: reading it fails with EISDIR, not with a parse error.
    mkdirSync(join(project, MARKER_FILE), { recursive: true })
    expect(readMarker(project)).toEqual({ kind: "bad", reason: "it cannot be read" })
  })

  it("a file in the place of the folder .llm-wiki/ cannot be read", () => {
    const project = projectWithMarker(null)
    writeFileSync(join(project, ".llm-wiki"), "not a folder")
    expect(readMarker(project)).toEqual({ kind: "bad", reason: "it cannot be read" })
  })

  it.each([
    ["JSON null", "null"],
    ["a list", "[]"],
    ["a number", "5"],
    ["an object without a commit", JSON.stringify({ at: "2026-10-01T00:00:00.000Z" })],
    ["a commit that is not text", JSON.stringify({ commit: 12 })],
    ["a commit that is not hex", JSON.stringify({ commit: "main" })],
    ["a commit that looks like an option", JSON.stringify({ commit: "--output=x" })],
    ["a commit that is too short", JSON.stringify({ commit: "abc123" })],
    ["a commit that is too long", JSON.stringify({ commit: `${SHA}${SHA}` })],
    ["a commit with a revision suffix", JSON.stringify({ commit: `${SHA}~1` })],
  ])("%s is bad", (_name, text) => {
    expect(readMarker(projectWithMarker(text))).toEqual({ kind: "bad", reason: "it has no commit sha" })
  })
})

describe("writeMarker", () => {
  it("writes the commit and the time, and readMarker reads them back", () => {
    const project = projectWithMarker(null)
    writeMarker(project, SHA, "2026-10-01T00:00:00.000Z")
    expect(JSON.parse(readFileSync(join(project, MARKER_FILE), "utf8"))).toEqual({ commit: SHA, at: "2026-10-01T00:00:00.000Z" })
    expect(readMarker(project)).toEqual({ kind: "commit", commit: SHA })
  })

  it("replaces an earlier marker", () => {
    const project = projectWithMarker(JSON.stringify({ commit: "f".repeat(40) }))
    writeMarker(project, SHA, "2026-10-01T00:00:00.000Z")
    expect(readMarker(project)).toEqual({ kind: "commit", commit: SHA })
  })
})
