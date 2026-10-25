/**
 * review-types-parity.test.ts - every place that lists the review item types lists the same ones.
 *
 * The types live in four files: the union in the review store, the icon table of the review view, the list that
 * the API route accepts, and the list of the MCP tool. A type that is missing in one of them fails at run time,
 * so this test reads all four.
 */
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

function read(relative: string): string {
  return readFileSync(fileURLToPath(new URL(`../../${relative}`, import.meta.url)), "utf8")
}

function quoted(text: string): string[] {
  return [...text.matchAll(/"([a-z][a-z-]*)"/g)].map((match) => match[1])
}

function storeTypes(): string[] {
  const source = read("src/stores/review-store.ts")
  const union = source.slice(source.indexOf("type:"), source.indexOf("title: string"))
  return quoted(union)
}

function viewTypes(): string[] {
  const source = read("src/components/review/review-view.tsx")
  const table = source.slice(source.indexOf("const typeConfig"), source.indexOf("export function ReviewView"))
  return [...table.matchAll(/^\s+"?([a-z][a-z-]*)"?:\s*\{ icon:/gm)].map((match) => match[1])
}

function rustTypes(): string[] {
  const source = read("src-tauri/src/api_server.rs")
  const start = source.indexOf("const REVIEW_TYPES")
  return quoted(source.slice(start, source.indexOf("];", start)))
}

function mcpTypes(): string[] {
  const source = read("mcp-server/src/review-tools.ts")
  const start = source.indexOf("export const REVIEW_TYPES")
  return quoted(source.slice(start, source.indexOf("] as const", start)))
}

describe("review item types", () => {
  const expected = [...storeTypes()].sort()

  it("include the mirror-edited type of wiki-sync", () => {
    expect(expected).toContain("mirror-edited")
  })

  it("include the fusion-candidate type of the fusion flow", () => {
    expect(expected).toContain("fusion-candidate")
  })

  it("are the same in the icon table of the review view", () => {
    expect([...viewTypes()].sort()).toEqual(expected)
  })

  it("are the same in the list that the API route accepts", () => {
    expect([...rustTypes()].sort()).toEqual(expected)
  })

  it("are the same in the list of the MCP tools", () => {
    expect([...mcpTypes()].sort()).toEqual(expected)
  })
})
