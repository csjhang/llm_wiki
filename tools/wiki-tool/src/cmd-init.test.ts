/**
 * cmd-init.test.ts - tests for `wiki-tool hepta init`.
 *
 * The tests run the command through runCli, so they also cover the registration of
 * the hepta group. Ids are placeholders (00000000-0000-4000-8000-0000000000NN) and
 * titles are generic; the inputs are the files of tools/wiki-tool/fixtures.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, describe, expect, it } from "vitest"
import { parseHeptabaseYaml } from "@/lib/wiki-config/heptabase-config"
import { loadCardMap, saveCardMap } from "./card-map"
import { runCli } from "./cli"
import type { CommandResult } from "./io"
import { parseListWhiteboards } from "./parse-mcp"

const FIXTURES = fileURLToPath(new URL("../fixtures/", import.meta.url))
const DATABASE = join(FIXTURES, "read_database.json")
const DATABASE_MISSING_STATUS = join(FIXTURES, "read_database_missing_status.json")
const WHITEBOARDS = join(FIXTURES, "list_whiteboards.txt")

function id(n: number): string {
  return `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`
}

const MIRROR_TAG = id(4)
const INGEST_TAG = id(5)
const ROOT_A = id(12)
const ROOT_B = id(13)
const SOURCE_BOARD = id(1)
const ARCHIVE_BOARD = id(11)

/** The property ids of the fixture database, by the key of heptabase.yaml. */
const FIXTURE_PROPERTIES = {
  domain: id(42),
  page_type: id(45),
  wiki: id(50),
  status: id(54),
  wiki_page: id(57),
  last_synced: id(58),
  hypothesis_status: id(59),
  strength: id(64),
}

const tempDirs: string[] = []

function makeDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "wiki-tool-init-"))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop() as string, { recursive: true, force: true })
  }
})

interface InitOptions {
  database?: string
  /** One list_whiteboards file, or one per page. */
  whiteboards?: string | string[]
  ingestTag?: string
  mirrorTag?: string
  roots?: string[]
  sourceBoards?: string[]
  archiveBoards?: string[]
  extra?: string[]
}

/** The command line of `hepta init`; the defaults are valid for the fixtures. */
function initArgs(project: string, options: InitOptions = {}): string[] {
  const args = [
    "hepta",
    "init",
    "--project",
    project,
    "--database",
    options.database ?? DATABASE,
    "--ingest-tag",
    options.ingestTag ?? INGEST_TAG,
    "--mirror-tag",
    options.mirrorTag ?? MIRROR_TAG,
  ]
  for (const path of [options.whiteboards ?? WHITEBOARDS].flat()) args.push("--whiteboards", path)
  for (const root of options.roots ?? [ROOT_A, ROOT_B]) args.push("--root", root)
  for (const board of options.sourceBoards ?? [SOURCE_BOARD]) args.push("--source-board", board)
  for (const board of options.archiveBoards ?? [ARCHIVE_BOARD]) args.push("--archive-board", board)
  return [...args, ...(options.extra ?? [])]
}

type Schema = Record<string, { type: string; name: string; options?: unknown[] }>

/** Write a copy of the fixture database after `change` edited its schema. */
function writeDatabase(dir: string, change: (schema: Schema) => void, keepContentOnly = false): string {
  const database = JSON.parse(readFileSync(DATABASE, "utf8")) as {
    configuration: { schema: Schema }
    content?: string
  }
  change(database.configuration.schema)
  const path = join(dir, "database.json")
  if (keepContentOnly) {
    const { configuration, ...rest } = database
    writeFileSync(path, JSON.stringify({ ...rest, content: JSON.stringify({ configuration }) }))
  } else {
    writeFileSync(path, JSON.stringify(database))
  }
  return path
}

function problemsOf(output: CommandResult): string[] {
  return output.problems as string[]
}

describe("hepta init", () => {
  it("writes a valid heptabase.yaml from the fixtures", async () => {
    const project = makeDir()
    const result = await runCli(initArgs(project))
    expect(result.exitCode).toBe(0)
    expect(result.output.ok).toBe(true)

    const text = readFileSync(join(project, "heptabase.yaml"), "utf8")
    expect(text.split("\n")[0]).toMatch(/^# .*wiki-tool hepta init/)
    const parsed = parseHeptabaseYaml(text)
    if (!parsed.ok) throw new Error(JSON.stringify(parsed.issues))
    expect(parsed.value).toEqual({
      version: 1,
      roots: [ROOT_A, ROOT_B],
      whiteboards: {
        [SOURCE_BOARD]: { kind: "source", auto_ingest: false },
        [ARCHIVE_BOARD]: { kind: "archive", auto_ingest: false },
      },
      tags: { ingest: INGEST_TAG, mirror: MIRROR_TAG },
      properties: FIXTURE_PROPERTIES,
    })
    expect(result.output.properties).toEqual(FIXTURE_PROPERTIES)
  })

  it("stores the whiteboard tree in the card map", async () => {
    const project = makeDir()
    const before = Date.now()
    const result = await runCli(initArgs(project))
    expect(result.exitCode).toBe(0)

    const tree = parseListWhiteboards(readFileSync(WHITEBOARDS, "utf8"))
    expect(tree).toHaveLength(9)
    const map = loadCardMap(project)
    expect(map.whiteboards_cache.items).toEqual(tree)
    expect(map.pages).toEqual({})
    expect(map.sources).toEqual({})
    const updatedAt = Date.parse(map.whiteboards_cache.updated_at)
    expect(updatedAt).toBeGreaterThanOrEqual(before)
    expect(updatedAt).toBeLessThanOrEqual(Date.now())
    expect(map.whiteboards_cache.updated_at).toBe(new Date(updatedAt).toISOString())
    expect(result.output.written).toEqual(["heptabase-map.json", "heptabase.yaml"])
    expect(result.output.whiteboards_cached).toBe(9)
  })

  it("writes a source board with auto_ingest off and an archive board without it", async () => {
    const project = makeDir()
    await runCli(initArgs(project))
    const text = readFileSync(join(project, "heptabase.yaml"), "utf8")
    expect(text).toContain(`${SOURCE_BOARD}: { kind: source, auto_ingest: false }`)
    expect(text).toContain(`${ARCHIVE_BOARD}: { kind: archive }`)
  })

  it("accepts no source or archive board", async () => {
    const project = makeDir()
    const result = await runCli(initArgs(project, { sourceBoards: [], archiveBoards: [], roots: [ROOT_A] }))
    expect(result.exitCode).toBe(0)
    const parsed = parseHeptabaseYaml(readFileSync(join(project, "heptabase.yaml"), "utf8"))
    expect(parsed.ok && parsed.value.whiteboards).toEqual({})
    expect(parsed.ok && parsed.value.roots).toEqual([ROOT_A])
  })

  it("lists a repeated id once", async () => {
    const project = makeDir()
    const result = await runCli(
      initArgs(project, { roots: [ROOT_A, ROOT_A], sourceBoards: [SOURCE_BOARD, SOURCE_BOARD] }),
    )
    expect(result.exitCode).toBe(0)
    const parsed = parseHeptabaseYaml(readFileSync(join(project, "heptabase.yaml"), "utf8"))
    expect(parsed.ok && parsed.value.roots).toEqual([ROOT_A])
  })

  it("reads the schema from content when the parsed object is absent", async () => {
    const project = makeDir()
    const database = writeDatabase(makeDir(), () => {}, true)
    const result = await runCli(initArgs(project, { database }))
    expect(result.exitCode).toBe(0)
    expect(result.output.properties).toEqual(FIXTURE_PROPERTIES)
  })

  it("matches property names without regard to case or surrounding spaces", async () => {
    const project = makeDir()
    const database = writeDatabase(makeDir(), (schema) => {
      schema[id(54)].name = " Status "
      schema[id(45)].name = "Page Type"
    })
    const result = await runCli(initArgs(project, { database }))
    expect(result.exitCode).toBe(0)
    expect(result.output.properties).toEqual(FIXTURE_PROPERTIES)
  })

  it("reports a missing status property and writes nothing", async () => {
    const project = makeDir()
    const result = await runCli(initArgs(project, { database: DATABASE_MISSING_STATUS }))
    expect(result.exitCode).toBe(2)
    expect(result.output.ok).toBe(false)
    expect(problemsOf(result.output)).toEqual(['required property "status" is missing from the database'])
    expect(existsSync(join(project, "heptabase.yaml"))).toBe(false)
    expect(existsSync(join(project, "heptabase-map.json"))).toBe(false)
  })

  it("reports every missing required property", async () => {
    const project = makeDir()
    const database = writeDatabase(makeDir(), (schema) => {
      delete schema[id(42)]
      delete schema[id(50)]
    })
    const result = await runCli(initArgs(project, { database }))
    expect(result.exitCode).toBe(2)
    expect(problemsOf(result.output)).toEqual([
      'required property "domain" is missing from the database',
      'required property "wiki" is missing from the database',
    ])
  })

  it("warns about a missing optional property and leaves its key out", async () => {
    const project = makeDir()
    const database = writeDatabase(makeDir(), (schema) => {
      delete schema[id(64)]
    })
    const whiteboards = writeWhiteboardsWithoutTrailer(makeDir())
    const result = await runCli(initArgs(project, { database, whiteboards }))
    expect(result.exitCode).toBe(0)
    expect(result.output.warnings).toEqual([
      'optional property "strength" is missing from the database; left out of heptabase.yaml',
    ])
    const parsed = parseHeptabaseYaml(readFileSync(join(project, "heptabase.yaml"), "utf8"))
    const { strength: _strength, ...expected } = FIXTURE_PROPERTIES
    expect(parsed.ok && parsed.value.properties).toEqual(expected)
  })

  it("reports a property with the wrong type", async () => {
    const project = makeDir()
    const database = writeDatabase(makeDir(), (schema) => {
      schema[id(57)].type = "select"
      schema[id(54)].type = "text"
    })
    const result = await runCli(initArgs(project, { database }))
    expect(result.exitCode).toBe(2)
    expect(problemsOf(result.output)).toEqual([
      'property "status" has type "text"; expected "select"',
      'property "wiki page" has type "select"; expected "text"',
    ])
    expect(existsSync(join(project, "heptabase.yaml"))).toBe(false)
  })

  it("reports a property name that two database properties share", async () => {
    const project = makeDir()
    const database = writeDatabase(makeDir(), (schema) => {
      schema[id(70)] = { type: "select", name: "Status" }
    })
    const result = await runCli(initArgs(project, { database }))
    expect(result.exitCode).toBe(2)
    expect(problemsOf(result.output)).toEqual(['property "status" appears 2 times in the database'])
  })

  it("rejects a property whose id is not a lowercase UUID", async () => {
    const project = makeDir()
    const database = writeDatabase(makeDir(), (schema) => {
      schema["not-a-uuid"] = schema[id(54)]
      delete schema[id(54)]
    })
    const result = await runCli(initArgs(project, { database }))
    expect(result.exitCode).toBe(2)
    expect(problemsOf(result.output)).toEqual([
      "invalid heptabase.yaml: properties.status: must be a lowercase UUID (8-4-4-4-12 hex digits)",
    ])
    expect(existsSync(join(project, "heptabase.yaml"))).toBe(false)
  })

  it("rejects a tag id that is not a lowercase UUID", async () => {
    const project = makeDir()
    const result = await runCli(initArgs(project, { ingestTag: "Not a UUID\nversion: 1" }))
    expect(result.exitCode).toBe(2)
    expect(problemsOf(result.output)).toEqual([
      "invalid heptabase.yaml: tags.ingest: must be a lowercase UUID (8-4-4-4-12 hex digits)",
    ])
    expect(existsSync(join(project, "heptabase.yaml"))).toBe(false)
  })

  it("rejects an unknown root id", async () => {
    const project = makeDir()
    const unknown = id(99)
    const whiteboards = writeWhiteboardsWithoutTrailer(makeDir())
    const result = await runCli(initArgs(project, { roots: [ROOT_A, unknown], whiteboards }))
    expect(result.exitCode).toBe(2)
    expect(problemsOf(result.output)).toEqual([`--root ${unknown} is not in the whiteboard list`])
    expect(existsSync(join(project, "heptabase.yaml"))).toBe(false)
    expect(existsSync(join(project, "heptabase-map.json"))).toBe(false)
  })

  it("rejects an unknown source board and an unknown archive board", async () => {
    const project = makeDir()
    const whiteboards = writeWhiteboardsWithoutTrailer(makeDir())
    const result = await runCli(initArgs(project, { sourceBoards: [id(98)], archiveBoards: [id(97)], whiteboards }))
    expect(result.exitCode).toBe(2)
    expect(problemsOf(result.output)).toEqual([
      `--source-board ${id(98)} is not in the whiteboard list`,
      `--archive-board ${id(97)} is not in the whiteboard list`,
    ])
  })

  it("rejects a board that is both a source and an archive", async () => {
    const project = makeDir()
    const result = await runCli(initArgs(project, { sourceBoards: [SOURCE_BOARD], archiveBoards: [SOURCE_BOARD] }))
    expect(result.exitCode).toBe(2)
    expect(problemsOf(result.output)).toEqual([`${SOURCE_BOARD} is given as both --source-board and --archive-board`])
  })

  it("says the whiteboard list is partial when an id is not found and the list has more pages", async () => {
    const project = makeDir()
    const result = await runCli(initArgs(project, { roots: [id(99)] }))
    expect(result.exitCode).toBe(2)
    expect(problemsOf(result.output)).toEqual([
      `--root ${id(99)} is not in the whiteboard list (the list is partial: showing 1-3 of 8)`,
    ])
  })

  it("warns when the whiteboard list has more pages", async () => {
    const project = makeDir()
    const result = await runCli(initArgs(project))
    expect(result.exitCode).toBe(0)
    expect(result.output.warnings).toEqual([
      "the whiteboard list is partial (showing 1-3 of 8), so the map cache holds only these whiteboards",
    ])
  })

  it("warns when the database tag is not the mirror tag", async () => {
    const project = makeDir()
    const whiteboards = writeWhiteboardsWithoutTrailer(makeDir())
    const result = await runCli(initArgs(project, { mirrorTag: INGEST_TAG, ingestTag: MIRROR_TAG, whiteboards }))
    expect(result.exitCode).toBe(0)
    expect(result.output.warnings).toEqual([
      `the database belongs to tag ${MIRROR_TAG}, but --mirror-tag is ${INGEST_TAG}`,
    ])
  })

  it("refuses to overwrite an existing heptabase.yaml", async () => {
    const project = makeDir()
    writeFileSync(join(project, "heptabase.yaml"), "# mine\n")
    const result = await runCli(initArgs(project))
    expect(result.exitCode).toBe(2)
    expect(problemsOf(result.output)).toEqual(["heptabase.yaml already exists; pass --force to replace it"])
    expect(readFileSync(join(project, "heptabase.yaml"), "utf8")).toBe("# mine\n")
    expect(existsSync(join(project, "heptabase-map.json"))).toBe(false)
  })

  it("replaces heptabase.yaml with --force and keeps the pages of the map", async () => {
    const project = makeDir()
    writeFileSync(join(project, "heptabase.yaml"), "# mine\n")
    const map = loadCardMap(project)
    map.pages["wiki/mechanisms/page-a.md"] = {
      card_id: id(21),
      content_hash: "abc",
      last_synced_at: "2026-10-01T00:00:00.000Z",
      card_updated_at: "2026-10-01T00:00:05.000Z",
      placements: [],
      status: "active",
    }
    saveCardMap(project, map)

    const result = await runCli(initArgs(project, { extra: ["--force"] }))
    expect(result.exitCode).toBe(0)
    expect(parseHeptabaseYaml(readFileSync(join(project, "heptabase.yaml"), "utf8")).ok).toBe(true)
    const after = loadCardMap(project)
    expect(after.pages).toEqual(map.pages)
    expect(after.whiteboards_cache.items).toHaveLength(9)
  })

  it("finishes an init that stopped after the map was written, without --force", async () => {
    const project = makeDir()
    const map = loadCardMap(project)
    map.pages["wiki/mechanisms/page-a.md"] = {
      card_id: id(21),
      content_hash: "abc",
      last_synced_at: "2026-10-01T00:00:00.000Z",
      card_updated_at: "2026-10-01T00:00:05.000Z",
      placements: [],
      status: "active",
    }
    saveCardMap(project, map)
    expect(existsSync(join(project, "heptabase.yaml"))).toBe(false)

    const result = await runCli(initArgs(project))
    expect(result.exitCode).toBe(0)
    expect(existsSync(join(project, "heptabase.yaml"))).toBe(true)
    expect(loadCardMap(project).pages).toEqual(map.pages)
  })

  it("strips a byte order mark from the database file", async () => {
    const project = makeDir()
    const dir = makeDir()
    const path = join(dir, "database.json")
    writeFileSync(path, `\uFEFF${readFileSync(DATABASE, "utf8")}`)
    const result = await runCli(initArgs(project, { database: path }))
    expect(result.exitCode).toBe(0)
  })

  describe("with one whiteboard list file per page", () => {
    /** The fixture list split in two pages: Archive and Root A, then Root B. */
    function writePages(dir: string, secondTrailer = ""): [string, string] {
      const envelope = JSON.parse(readFileSync(WHITEBOARDS, "utf8")) as { content: string }
      const lines = envelope.content.split("\n\nMore top-level")[0].split("\n")
      const split = lines.findIndex((line) => line.includes('"Root B"'))
      const first = join(dir, "page-1.txt")
      const second = join(dir, "page-2.txt")
      writeFileSync(
        first,
        `${lines.slice(0, split).join("\n")}\n\nMore top-level whiteboards are available. Showing 1-2 of 3. Call list_whiteboards with offset 2 to list the next page.`,
      )
      writeFileSync(second, `Whiteboards:\n${lines.slice(split).join("\n")}${secondTrailer}`)
      return [first, second]
    }

    it("joins the pages into one tree", async () => {
      const project = makeDir()
      const pages = writePages(makeDir())
      const result = await runCli(initArgs(project, { whiteboards: pages }))
      expect(result.exitCode).toBe(0)
      const full = parseListWhiteboards(readFileSync(WHITEBOARDS, "utf8"))
      expect(loadCardMap(project).whiteboards_cache.items).toEqual(full)
      expect(result.output.whiteboards_cached).toBe(9)
    })

    it("finds an id that is on a later page, and not on the first alone", async () => {
      const pages = writePages(makeDir())
      const alone = await runCli(initArgs(makeDir(), { whiteboards: pages[0], roots: [ROOT_B] }))
      expect(alone.exitCode).toBe(2)
      expect(problemsOf(alone.output)).toEqual([
        `--root ${ROOT_B} is not in the whiteboard list (the list is partial: showing 1-2 of 3)`,
      ])
      const both = await runCli(initArgs(makeDir(), { whiteboards: pages, roots: [ROOT_B] }))
      expect(both.exitCode).toBe(0)
    })

    it("does not warn when the last page has no paging trailer", async () => {
      const result = await runCli(initArgs(makeDir(), { whiteboards: writePages(makeDir()) }))
      expect(result.exitCode).toBe(0)
      expect(result.output.warnings).toEqual([])
    })

    it("warns when the last page still has a paging trailer", async () => {
      const trailer =
        "\n\nMore top-level whiteboards are available. Showing 3-3 of 5. Call list_whiteboards with offset 3 to list the next page."
      const result = await runCli(initArgs(makeDir(), { whiteboards: writePages(makeDir(), trailer) }))
      expect(result.exitCode).toBe(0)
      expect(result.output.warnings).toEqual([
        "the whiteboard list is partial (showing 3-3 of 5), so the map cache holds only these whiteboards",
      ])
    })

    it("names the file that cannot be read", async () => {
      const [first] = writePages(makeDir())
      const absent = join(makeDir(), "page-2.txt")
      const result = await runCli(initArgs(makeDir(), { whiteboards: [first, absent] }))
      expect(result.exitCode).toBe(2)
      expect(problemsOf(result.output)).toEqual([`cannot read --whiteboards file: ${absent}`])
    })
  })

  it("exits 2 and writes nothing when the existing map cannot be read", async () => {
    const project = makeDir()
    writeFileSync(join(project, "heptabase-map.json"), "{nope")
    const result = await runCli(initArgs(project))
    expect(result.exitCode).toBe(2)
    expect(problemsOf(result.output)).toHaveLength(1)
    expect(problemsOf(result.output)[0]).toMatch(/heptabase-map\.json.*repair or remove heptabase-map\.json/s)
    expect(existsSync(join(project, "heptabase.yaml"))).toBe(false)
    expect(readFileSync(join(project, "heptabase-map.json"), "utf8")).toBe("{nope")
  })

  it("reports a project folder that does not exist", async () => {
    const missing = join(makeDir(), "no-such-folder")
    const result = await runCli(initArgs(missing))
    expect(result.exitCode).toBe(2)
    expect(problemsOf(result.output)).toEqual([`project folder not found: ${missing}`])
    expect(existsSync(missing)).toBe(false)
  })

  it("reports an input file that is missing or is not valid JSON", async () => {
    const dir = makeDir()
    const project = makeDir()
    const notJson = join(dir, "bad.json")
    writeFileSync(notJson, "{nope")
    const missing = await runCli(initArgs(project, { database: join(dir, "absent.json") }))
    expect(missing.exitCode).toBe(2)
    expect(problemsOf(missing.output)).toEqual([`cannot read --database file: ${join(dir, "absent.json")}`])
    const bad = await runCli(initArgs(project, { database: notJson }))
    expect(bad.exitCode).toBe(2)
    expect(problemsOf(bad.output)).toHaveLength(1)
    expect(problemsOf(bad.output)[0]).toMatch(/bad\.json/)
    const noList = await runCli(initArgs(project, { whiteboards: join(dir, "absent.txt") }))
    expect(noList.exitCode).toBe(2)
    expect(problemsOf(noList.output)).toEqual([`cannot read --whiteboards file: ${join(dir, "absent.txt")}`])
  })

  it("reports a database file without a schema", async () => {
    const dir = makeDir()
    const project = makeDir()
    const path = join(dir, "failed.json")
    writeFileSync(path, JSON.stringify({ status: "failed", content: "no such tag" }))
    const result = await runCli(initArgs(project, { database: path }))
    expect(result.exitCode).toBe(2)
    expect(problemsOf(result.output)).toEqual(["--database file has no configuration.schema (status: failed)"])
  })

  it("reports a whiteboard list without whiteboards", async () => {
    const dir = makeDir()
    const project = makeDir()
    const path = join(dir, "empty.txt")
    writeFileSync(path, "Whiteboards:\n")
    const result = await runCli(initArgs(project, { whiteboards: path }))
    expect(result.exitCode).toBe(2)
    expect(problemsOf(result.output)).toEqual(["--whiteboards file lists no whiteboards"])
  })

  it("reports missing options and unknown options together", async () => {
    const result = await runCli(["hepta", "init", "--project", "/x", "--bogus"])
    expect(result.exitCode).toBe(2)
    expect(problemsOf(result.output)).toEqual([
      "unknown option: --bogus",
      "missing option: --database",
      "missing option: --whiteboards",
      "missing option: --ingest-tag",
      "missing option: --mirror-tag",
      "missing option: --root",
    ])
  })

  it("requires --project", async () => {
    const result = await runCli(["hepta", "init"])
    expect(result.exitCode).toBe(2)
    expect(problemsOf(result.output)[0]).toBe("missing option: --project")
  })
})

/** A copy of the fixture whiteboard list without its paging trailer. */
function writeWhiteboardsWithoutTrailer(dir: string): string {
  const text = readFileSync(WHITEBOARDS, "utf8")
  const envelope = JSON.parse(text) as { content: string }
  const complete = envelope.content.split("\n\nMore top-level")[0]
  const path = join(dir, "whiteboards.txt")
  writeFileSync(path, complete)
  return path
}
