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

import { loadWhiteboardOptions, parseWhiteboardOptions } from "./whiteboards"

const ID = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`

function mapText(items: unknown, updatedAt = "2026-01-01T00:00:00.000Z"): string {
  return JSON.stringify({ version: 1, pages: {}, sources: {}, whiteboards_cache: { updated_at: updatedAt, items } })
}

describe("parseWhiteboardOptions", () => {
  it("lists the whiteboards of the cache in order, with the path of parent titles", () => {
    const text = mapText([
      { id: ID(1), title: "example/alpha", parentId: null },
      { id: ID(2), title: "beta", parentId: ID(1) },
      { id: ID(3), title: "gamma", parentId: ID(2) },
      { id: ID(4), title: "example/delta", parentId: null },
    ])

    expect(parseWhiteboardOptions(text)).toEqual([
      { id: ID(1), label: "example/alpha" },
      { id: ID(2), label: "example/alpha / beta" },
      { id: ID(3), label: "example/alpha / beta / gamma" },
      { id: ID(4), label: "example/delta" },
    ])
  })

  it("is empty when the cache has no whiteboard", () => {
    expect(parseWhiteboardOptions(mapText([], ""))).toEqual([])
  })

  it("is empty when the text is not a card map", () => {
    expect(parseWhiteboardOptions("")).toEqual([])
    expect(parseWhiteboardOptions("not json")).toEqual([])
    expect(parseWhiteboardOptions("[]")).toEqual([])
    expect(parseWhiteboardOptions("{}")).toEqual([])
    expect(parseWhiteboardOptions(JSON.stringify({ whiteboards_cache: [] }))).toEqual([])
    expect(parseWhiteboardOptions(JSON.stringify({ whiteboards_cache: { items: "x" } }))).toEqual([])
  })

  it("leaves out an item whose id is not a lowercase UUID, because the command would refuse it", () => {
    const text = mapText([
      { id: "not-an-id", title: "bad", parentId: null },
      { id: "0000000a-0000-4000-8000-000000000001".toUpperCase(), title: "upper", parentId: null },
      { id: ID(2), title: "good", parentId: null },
      null,
      "text",
      { title: "no id" },
    ])

    expect(parseWhiteboardOptions(text)).toEqual([{ id: ID(2), label: "good" }])
  })

  it("uses the id for a whiteboard with no title", () => {
    const text = mapText([{ id: ID(1), title: "  ", parentId: null }, { id: ID(2), parentId: null }])

    expect(parseWhiteboardOptions(text)).toEqual([
      { id: ID(1), label: ID(1) },
      { id: ID(2), label: ID(2) },
    ])
  })

  it("treats an unknown parent as no parent, and survives a loop", () => {
    const text = mapText([
      { id: ID(1), title: "orphan", parentId: ID(9) },
      { id: ID(2), title: "loop-a", parentId: ID(3) },
      { id: ID(3), title: "loop-b", parentId: ID(2) },
    ])

    const options = parseWhiteboardOptions(text)

    expect(options.map((option) => option.id)).toEqual([ID(1), ID(2), ID(3)])
    expect(options[0].label).toBe("orphan")
    for (const option of options) expect(option.label.length).toBeLessThan(200)
  })

  it("keeps the first of two items with the same id", () => {
    const text = mapText([
      { id: ID(1), title: "first", parentId: null },
      { id: ID(1), title: "second", parentId: null },
    ])

    expect(parseWhiteboardOptions(text)).toEqual([{ id: ID(1), label: "first" }])
  })
})

describe("loadWhiteboardOptions", () => {
  beforeEach(() => {
    files.map.clear()
  })

  it("reads heptabase-map.json of the project", async () => {
    files.map.set("/home/user/example-wiki/heptabase-map.json", mapText([{ id: ID(1), title: "alpha", parentId: null }]))

    await expect(loadWhiteboardOptions("/home/user/example-wiki")).resolves.toEqual([{ id: ID(1), label: "alpha" }])
  })

  it("accepts a path with a trailing slash", async () => {
    files.map.set("/home/user/example-wiki/heptabase-map.json", mapText([{ id: ID(1), title: "alpha", parentId: null }]))

    await expect(loadWhiteboardOptions("/home/user/example-wiki/")).resolves.toHaveLength(1)
  })

  it("is empty when the map does not exist", async () => {
    await expect(loadWhiteboardOptions("/home/user/example-wiki")).resolves.toEqual([])
  })

  it("is empty when the map cannot be read", async () => {
    const fs = await import("@/commands/fs")
    vi.mocked(fs.fileExists).mockResolvedValueOnce(true)

    await expect(loadWhiteboardOptions("/home/user/example-wiki")).resolves.toEqual([])
  })
})
