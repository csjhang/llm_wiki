/**
 * source-hygiene.test.ts - guards for the source of the lint commands.
 */
import { readdirSync, readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

const SOURCES = [
  ...readdirSync(fileURLToPath(new URL(".", import.meta.url)))
    .filter((name) => name.endsWith(".ts"))
    .map((name) => fileURLToPath(new URL(name, import.meta.url))),
  fileURLToPath(new URL("../../../../src/lib/mechanism-wiki/lint-structure.ts", import.meta.url)),
  fileURLToPath(new URL("../../../../src/lib/mechanism-wiki/lint-run.ts", import.meta.url)),
]

describe("source of the lint commands", () => {
  it("lists the files it checks", () => {
    expect(SOURCES.some((path) => path.endsWith("/lint/structure.ts"))).toBe(true)
    expect(SOURCES.some((path) => path.endsWith("/lint-structure.ts"))).toBe(true)
  })

  it.each(SOURCES)("%s has no byte order mark character; a regex writes it as \\uFEFF", (path) => {
    // The character is invisible in an editor, so a regex must use the escape.
    expect(readFileSync(path, "utf8").includes("\uFEFF")).toBe(false)
  })
})
