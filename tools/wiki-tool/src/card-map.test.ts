/**
 * card-map.test.ts - tests for the card map file and the content hash.
 *
 * Ids are placeholders (00000000-0000-4000-8000-0000000000NN) and titles are generic.
 */
import { createHash } from "node:crypto"
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { type CardMap, contentHash, loadCardMap, saveCardMap } from "./card-map"

const tempDirs: string[] = []

function makeProject(): string {
  const dir = mkdtempSync(join(tmpdir(), "wiki-tool-map-"))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop() as string, { recursive: true, force: true })
  }
})

function id(n: number): string {
  return `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`
}

function sampleMap(): CardMap {
  return {
    version: 1,
    pages: {
      "wiki/mechanisms/page-a.md": {
        card_id: id(21),
        content_hash: contentHash("page a"),
        last_synced_at: "2026-10-01T00:00:00.000Z",
        card_updated_at: "2026-10-01T00:00:05.000Z",
        placements: [id(12)],
        status: "active",
      },
      "wiki/concepts/page-b.md": {
        card_id: id(22),
        content_hash: contentHash("page b"),
        last_synced_at: "2026-10-02T00:00:00.000Z",
        card_updated_at: "2026-10-02T00:00:05.000Z",
        placements: [],
        status: "retired",
      },
    },
    sources: {
      [id(31)]: {
        raw_path: `raw/sources/heptabase/${id(31)}.md`,
        card_updated_at: "2026-10-03T00:00:00.000Z",
        ingest_commit: "0123abc",
      },
      [id(32)]: {
        raw_path: `raw/sources/heptabase/${id(32)}.md`,
        card_updated_at: "2026-10-04T00:00:00.000Z",
        ingest_commit: null,
      },
    },
    whiteboards_cache: {
      updated_at: "2026-10-05T00:00:00.000Z",
      items: [
        { id: id(12), title: "Root A", parentId: null },
        { id: id(3), title: "Board A1", parentId: id(12) },
      ],
    },
  }
}

describe("loadCardMap", () => {
  it("returns an empty map when the file is absent", () => {
    expect(loadCardMap(makeProject())).toEqual({
      version: 1,
      pages: {},
      sources: {},
      whiteboards_cache: { updated_at: "", items: [] },
    })
  })

  it("returns a new empty map on each call", () => {
    const project = makeProject()
    const first = loadCardMap(project)
    first.pages["wiki/a.md"] = sampleMap().pages["wiki/mechanisms/page-a.md"]
    expect(loadCardMap(project).pages).toEqual({})
  })

  it("names the file when the JSON is invalid and says to repair or remove it", () => {
    const project = makeProject()
    writeFileSync(join(project, "heptabase-map.json"), "{nope")
    expect(() => loadCardMap(project)).toThrow(/heptabase-map\.json.*repair or remove heptabase-map\.json/s)
  })

  it("rejects a map of another version", () => {
    const project = makeProject()
    writeFileSync(join(project, "heptabase-map.json"), JSON.stringify({ ...sampleMap(), version: 2 }))
    expect(() => loadCardMap(project)).toThrow(/heptabase-map\.json.*version.*repair or remove/)
  })

  it.each(["pages", "sources", "whiteboards_cache"])("rejects a map without %s", (key) => {
    const project = makeProject()
    const broken: Record<string, unknown> = { ...sampleMap() }
    delete broken[key]
    writeFileSync(join(project, "heptabase-map.json"), JSON.stringify(broken))
    expect(() => loadCardMap(project)).toThrow(new RegExp(`heptabase-map\\.json.*${key}`))
  })

  it("rejects a file that is not an object", () => {
    const project = makeProject()
    writeFileSync(join(project, "heptabase-map.json"), "[]")
    expect(() => loadCardMap(project)).toThrow(/heptabase-map\.json/)
  })

  it("keeps the answers to plan-up questions, which are optional", () => {
    const project = makeProject()
    expect(loadCardMap(project).up_decisions).toBeUndefined()
    const decisions = { [id(9)]: "skip", [id(10)]: id(12) }
    saveCardMap(project, { ...sampleMap(), up_decisions: decisions })
    expect(loadCardMap(project).up_decisions).toEqual(decisions)
  })

  it.each([[[]], ["skip"], [{ [id(9)]: 3 }], [{ [id(9)]: null }]])("rejects up_decisions that is %j", (value) => {
    const project = makeProject()
    writeFileSync(join(project, "heptabase-map.json"), JSON.stringify({ ...sampleMap(), up_decisions: value }))
    expect(() => loadCardMap(project)).toThrow(/heptabase-map\.json.*up_decisions.*repair or remove/)
  })
})

describe("saveCardMap", () => {
  it("round-trips a map", () => {
    const project = makeProject()
    const map = sampleMap()
    saveCardMap(project, map)
    expect(loadCardMap(project)).toEqual(map)
  })

  it("writes indented JSON with a final newline at the project root", () => {
    const project = makeProject()
    saveCardMap(project, sampleMap())
    const text = readFileSync(join(project, "heptabase-map.json"), "utf8")
    expect(text.endsWith("}\n")).toBe(true)
    expect(text).toContain('\n  "version": 1,')
    expect(JSON.parse(text)).toEqual(sampleMap())
  })

  it("replaces the map atomically and leaves no temp file", () => {
    const project = makeProject()
    saveCardMap(project, sampleMap())
    const second = sampleMap()
    second.pages = {}
    saveCardMap(project, second)
    expect(readdirSync(project)).toEqual(["heptabase-map.json"])
    expect(loadCardMap(project).pages).toEqual({})
  })

  it("throws and leaves no temp file when the write fails", () => {
    const project = makeProject()
    // A non-empty folder at the target path makes the final rename fail.
    mkdirSync(join(project, "heptabase-map.json", "child"), { recursive: true })
    expect(() => saveCardMap(project, sampleMap())).toThrow()
    expect(readdirSync(project)).toEqual(["heptabase-map.json"])
  })
})

describe("contentHash", () => {
  it("is the sha256 hex of the UTF-8 text", () => {
    expect(contentHash("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad")
    expect(contentHash("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855")
    const text = "標題 — title\n"
    expect(contentHash(text)).toBe(createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex"))
  })

  it("is stable and changes with the text", () => {
    expect(contentHash("same text")).toBe(contentHash("same text"))
    expect(contentHash("same text")).not.toBe(contentHash("same text "))
    expect(contentHash("same text")).toMatch(/^[0-9a-f]{64}$/)
  })
})
