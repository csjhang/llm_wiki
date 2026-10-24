/**
 * cmd-snapshot.test.ts - tests for `wiki-tool hepta snapshot`.
 *
 * The tests run the command through runCli. Ids are placeholders
 * (00000000-0000-4000-8000-0000000000NN) and titles are generic; the read_object pages
 * are the files of tools/wiki-tool/fixtures.
 *
 * The whiteboard tree of the fixture list_whiteboards.txt:
 *   Root A (12) > Board A1 (3) > Board A2 (1), Board A3 (14)
 *   Root B (13) > Board B1 (15) > Board B2 (2), Board B3 (16)
 */
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, describe, expect, it } from "vitest"
import { parseFrontmatter } from "@/lib/frontmatter"
import { type CardMap, loadCardMap, saveCardMap } from "./card-map"
import { runCli } from "./cli"
import { cardToSnapshotBody } from "./convert"
import { joinReadObjectPages, parseListWhiteboards } from "./parse-mcp"
import { id, makeProject, removeProjects, writeProjectFile } from "./test-project"

const FIXTURES = fileURLToPath(new URL("../fixtures/", import.meta.url))
const WHITEBOARDS = join(FIXTURES, "list_whiteboards.txt")
const PAGE_1 = join(FIXTURES, "read_object_page1.txt")
const PAGE_2 = join(FIXTURES, "read_object_page2.txt")

const NOW = "2026-10-24T08:00:00.000Z"
const UPDATED = "2026-10-04T07:28:31.245Z"
const CARD = id(6)
const BOARD_A2 = { id: id(1), title: "Board A2" }
const BOARD_B2 = { id: id(2), title: "Board B2" }
const CONTENT = 'Hello <hepta-color type="text" color="blue">blue</hepta-color> and [Topic](heptabase://card/' + id(7) + ").\n"

afterEach(removeProjects)

interface SnapshotOptions {
  cardId?: string
  title?: string
  cardType?: string
  whiteboards?: unknown
  /** The text of the content file; the default is CONTENT. */
  text?: string
  /** Content files (one per read_object page) in place of `text`. */
  files?: string[]
  url?: string
  /** Null leaves `--updated-at` out. */
  updatedAt?: string | null
  /** Replaces the whole command line after `hepta snapshot`. */
  args?: string[]
}

/** Run `hepta snapshot`; the defaults are valid. The content is written to the project's .llm-wiki/hepta folder. */
async function snapshot(project: string, options: SnapshotOptions = {}) {
  let files = options.files
  if (files === undefined) {
    writeProjectFile(project, ".llm-wiki/hepta/content.txt", options.text ?? CONTENT)
    files = [join(project, ".llm-wiki/hepta/content.txt")]
  }
  const args = options.args ?? [
    "--project", project,
    "--card-id", options.cardId ?? CARD,
    "--title", options.title ?? "Card N-00｜Map：entry",
    "--card-type", options.cardType ?? "card",
    "--whiteboards", JSON.stringify(options.whiteboards ?? [BOARD_A2]),
    ...files.flatMap((file) => ["--content", file]),
    ...(options.url === undefined ? [] : ["--url", options.url]),
    ...(options.updatedAt === null ? [] : ["--updated-at", options.updatedAt ?? UPDATED]),
    "--now", NOW,
  ]
  const result = await runCli(["hepta", "snapshot", ...args])
  return { exitCode: result.exitCode, output: result.output as Record<string, unknown> & { problems?: string[]; warnings?: string[] } }
}

function rawPath(cardId = CARD): string {
  return `raw/sources/heptabase/${cardId}.md`
}

function read(project: string, relative: string): string {
  return readFileSync(join(project, relative), "utf8")
}

function frontmatterOf(project: string, cardId = CARD): Record<string, string | string[]> {
  return parseFrontmatter(read(project, rawPath(cardId))).frontmatter ?? {}
}

/** A domains.yaml with the given domains: name to the whiteboard ids that hint at it. */
function domainsYaml(domains: Record<string, string[]>): string {
  const lines = ["version: 1", "domains:"]
  for (const [name, hints] of Object.entries(domains)) {
    lines.push(`  "${name}":`, "    lens: business", `    description: Domain ${name}`, "    whiteboards:", ...hints.map((hint) => `      - ${hint}`))
  }
  return `${lines.join("\n")}\n`
}

describe("hepta snapshot", () => {
  it("writes the frontmatter and the body, and records the source", async () => {
    const project = makeProject()
    const { exitCode, output } = await snapshot(project)
    expect(exitCode).toBe(0)
    expect(output).toEqual({ ok: true, card_id: CARD, written: rawPath(), source_kind: "note", domain: null, warnings: [] })
    expect(read(project, rawPath())).toBe(
      [
        "---",
        'title: "Card N-00｜Map：entry"',
        `heptabase_card_id: ${CARD}`,
        'heptabase_whiteboards: ["Board A2"]',
        `card_updated_at: "${UPDATED}"`,
        "source_kind: note",
        "---",
        "",
        "Hello blue and Topic.",
        "",
      ].join("\n"),
    )
    expect(loadCardMap(project).sources).toEqual({ [CARD]: { raw_path: rawPath(), card_updated_at: UPDATED, ingest_commit: null } })
    expect(readdirSync(join(project, "raw/sources/heptabase"))).toEqual([`${CARD}.md`])
    expect(readdirSync(project).filter((name) => name.endsWith(".tmp"))).toEqual([])
  })

  it("writes frontmatter that reads back, whatever the title holds", async () => {
    const project = makeProject()
    const title = 'Say "hi": [draft] # not a comment, ｜ \\ end'
    const second = { id: id(2), title: "Board: \"B2\" [x]" }
    await snapshot(project, { title, whiteboards: [BOARD_A2, second], url: "https://example.com/a?b=1&c=2#d" })
    expect(frontmatterOf(project)).toEqual({
      title,
      heptabase_card_id: CARD,
      heptabase_whiteboards: ["Board A2", second.title],
      card_updated_at: UPDATED,
      url: "https://example.com/a?b=1&c=2#d",
      source_kind: "note",
    })
  })

  it("keeps the order of the keys and leaves out an empty url", async () => {
    const project = makeProject()
    writeProjectFile(project, "domains.yaml", domainsYaml({ "business/pricing": [BOARD_A2.id] }))
    await snapshot(project, { url: "https://example.com/a" })
    const keys = (text: string): string[] => text.split("\n").slice(1, text.split("\n").indexOf("---", 1)).map((line) => line.split(":")[0])
    expect(keys(read(project, rawPath()))).toEqual(["title", "heptabase_card_id", "heptabase_whiteboards", "card_updated_at", "url", "source_kind", "domain"])

    const other = makeProject()
    await snapshot(other)
    expect(read(other, rawPath())).not.toContain("url:")
  })

  it("uses the clock for the update time when none is given", async () => {
    const project = makeProject()
    const { exitCode } = await snapshot(project, { whiteboards: [], updatedAt: null })
    expect(exitCode).toBe(0)
    expect(loadCardMap(project).sources[CARD].card_updated_at).toBe(NOW)
    expect(frontmatterOf(project).card_updated_at).toBe(NOW)
    expect(frontmatterOf(project).heptabase_whiteboards).toEqual([])
  })

  it("joins paged read_object output", async () => {
    const project = makeProject()
    // The fixture pages are the pages of the card id(8).
    const { exitCode } = await snapshot(project, { cardId: id(8), files: [PAGE_1, PAGE_2] })
    expect(exitCode).toBe(0)
    const body = parseFrontmatter(read(project, rawPath(id(8)))).body
    const joined = joinReadObjectPages([readFileSync(PAGE_1, "utf8"), readFileSync(PAGE_2, "utf8")])
    expect(body).toBe(`${cardToSnapshotBody(joined)}\n`)
    // No line numbers, no header, no databases block, and the Hepta tags are gone.
    expect(body).not.toMatch(/^\d+\t/m)
    expect(body).not.toContain("Databases")
    expect(body).not.toContain("hepta-mention")
    expect(body).toContain("| Alpha | First item\tthat can be tabbed |")
    expect(body.indexOf("| Beta |")).toBeLessThan(body.indexOf("Source B, 1994"))
  })

  it("takes a file of plain text as it is", async () => {
    const project = makeProject()
    // Lines that look like numbered lines are text here: the file is not a read_object result.
    await snapshot(project, { text: "# Plain\n\n1\tone\n2\ttwo\n" })
    expect(parseFrontmatter(read(project, rawPath())).body).toBe("# Plain\n\n1\tone\n2\ttwo\n")
  })

  it("writes the card as the user wrote it: no escapes of Heptabase, no image tag", async () => {
    const project = makeProject()
    const image = `<image fileId="${id(50)}" sourceObjectId="${id(51)}" sourceObjectType="card" />`
    await snapshot(project, { text: `# \\[x] y\n\n- a\n\n- b\n\n${image}\n` })
    expect(parseFrontmatter(read(project, rawPath())).body).toBe("# [x] y\n\n- a\n- b\n\n<!-- heptabase: image -->\n")
  })

  it("writes an empty body for a card without lines", async () => {
    const project = makeProject()
    const { exitCode } = await snapshot(project, { text: `card "Empty" [${CARD}] 0 lines` })
    expect(exitCode).toBe(0)
    expect(read(project, rawPath()).endsWith("---\n")).toBe(true)
    expect(read(project, rawPath())).not.toContain("Empty")
  })

  describe("source_kind", () => {
    it("marks web cards and pdf cards as article", async () => {
      const project = makeProject()
      await snapshot(project, { cardType: "webCard" })
      await snapshot(project, { cardId: id(7), cardType: "pdfCard" })
      expect(frontmatterOf(project, CARD).source_kind).toBe("article")
      expect(frontmatterOf(project, id(7)).source_kind).toBe("article")
    })

    it("marks a card on a source board as article and other cards as note", async () => {
      const project = makeProject({}, { boards: { [id(2)]: "{ kind: source, auto_ingest: false }", [id(1)]: "{ kind: project }" } })
      await snapshot(project, { whiteboards: [BOARD_A2, BOARD_B2] })
      await snapshot(project, { cardId: id(7), whiteboards: [BOARD_A2] })
      await snapshot(project, { cardId: id(8), whiteboards: [] })
      expect(frontmatterOf(project, CARD).source_kind).toBe("article")
      expect(frontmatterOf(project, id(7)).source_kind).toBe("note")
      expect(frontmatterOf(project, id(8)).source_kind).toBe("note")
    })
  })

  describe("domain", () => {
    it("adds domain from a unique whiteboard hint", async () => {
      const project = makeProject()
      writeProjectFile(project, "domains.yaml", domainsYaml({ "business/pricing": [BOARD_A2.id], hardware: [id(99)] }))
      const { exitCode, output } = await snapshot(project)
      expect(exitCode).toBe(0)
      expect(output.warnings).toEqual([])
      expect(frontmatterOf(project).domain).toBe("business/pricing")
    })

    it("adds domain from a hint on an ancestor whiteboard", async () => {
      const project = makeProject()
      // Root A (12) is above Board A2 (1) in the stored tree.
      const map = loadCardMap(project)
      map.whiteboards_cache = { updated_at: NOW, items: parseListWhiteboards(readFileSync(WHITEBOARDS, "utf8")) }
      saveCardMap(project, map)
      writeProjectFile(project, "domains.yaml", domainsYaml({ "business/pricing": [id(12)], hardware: [id(13)] }))
      await snapshot(project)
      expect(frontmatterOf(project).domain).toBe("business/pricing")
    })

    it("counts two hints of one domain as one match", async () => {
      const project = makeProject()
      writeProjectFile(project, "domains.yaml", domainsYaml({ "business/pricing": [BOARD_A2.id, BOARD_B2.id] }))
      await snapshot(project, { whiteboards: [BOARD_A2, BOARD_B2] })
      expect(frontmatterOf(project).domain).toBe("business/pricing")
    })

    it("omits domain when hints are ambiguous", async () => {
      const project = makeProject()
      writeProjectFile(project, "domains.yaml", domainsYaml({ "business/pricing": [BOARD_A2.id], hardware: [BOARD_A2.id] }))
      await snapshot(project)
      expect(frontmatterOf(project)).not.toHaveProperty("domain")

      // Two whiteboards of the card, each hinting at another domain.
      writeProjectFile(project, "domains.yaml", domainsYaml({ "business/pricing": [BOARD_A2.id], hardware: [BOARD_B2.id] }))
      await snapshot(project, { whiteboards: [BOARD_A2, BOARD_B2] })
      expect(frontmatterOf(project)).not.toHaveProperty("domain")
    })

    it("omits domain when no hint matches or there is no domains.yaml", async () => {
      const project = makeProject()
      await snapshot(project)
      expect(frontmatterOf(project)).not.toHaveProperty("domain")

      writeProjectFile(project, "domains.yaml", domainsYaml({ hardware: [id(99)] }))
      await snapshot(project)
      expect(frontmatterOf(project)).not.toHaveProperty("domain")
    })

    it("reads a custom lens and warns about a domains.yaml it cannot read", async () => {
      const project = makeProject()
      writeProjectFile(project, "lenses/finance.md", "# Finance\n")
      writeProjectFile(
        project,
        "domains.yaml",
        `version: 1\ndomains:\n  money:\n    lens: finance\n    description: Money\n    whiteboards: [${BOARD_A2.id}]\n`,
      )
      const known = await snapshot(project)
      expect(known.output.warnings).toEqual([])
      expect(frontmatterOf(project).domain).toBe("money")

      writeProjectFile(project, "domains.yaml", "version: 1\ndomains: [oops\n")
      const broken = await snapshot(project)
      expect(broken.exitCode).toBe(0)
      expect(broken.output.warnings).toEqual([expect.stringContaining("domains.yaml")])
      expect(frontmatterOf(project)).not.toHaveProperty("domain")
    })
  })

  describe("nearest domain hint", () => {
    /** Board A2 (1) < Board A1 (3) < Root A (12); Board B2 (2) < Board B1 (15) < Root B (13). */
    function treeProject(domains: Record<string, string[]>): string {
      const project = makeProject()
      const map = loadCardMap(project)
      map.whiteboards_cache = { updated_at: NOW, items: parseListWhiteboards(readFileSync(WHITEBOARDS, "utf8")) }
      saveCardMap(project, map)
      writeProjectFile(project, "domains.yaml", domainsYaml(domains))
      return project
    }

    it("prefers the hint on the board itself over a hint on its parent", async () => {
      const project = treeProject({ "business/pricing": [id(12)], hardware: [BOARD_A2.id] })
      await snapshot(project)
      expect(frontmatterOf(project).domain).toBe("hardware")
    })

    it("prefers the nearer ancestor", async () => {
      const project = treeProject({ "business/pricing": [id(12)], hardware: [id(3)] })
      await snapshot(project)
      expect(frontmatterOf(project).domain).toBe("hardware")
    })

    it("omits domain when two domains tie at the nearest distance", async () => {
      // Each whiteboard of the card has a hint two levels up, for another domain.
      const project = treeProject({ "business/pricing": [id(12)], hardware: [id(13)] })
      await snapshot(project, { whiteboards: [BOARD_A2, BOARD_B2] })
      expect(frontmatterOf(project)).not.toHaveProperty("domain")

      // The same distance on one chain: two domains hint at the same ancestor.
      writeProjectFile(project, "domains.yaml", domainsYaml({ "business/pricing": [id(3)], hardware: [id(3)] }))
      await snapshot(project)
      expect(frontmatterOf(project)).not.toHaveProperty("domain")
    })

    it("lets the nearest hint win over a farther hint of another whiteboard", async () => {
      const project = treeProject({ "business/pricing": [id(12)], hardware: [BOARD_B2.id] })
      await snapshot(project, { whiteboards: [BOARD_A2, BOARD_B2] })
      expect(frontmatterOf(project).domain).toBe("hardware")
    })
  })

  it("quotes a domain that YAML would read as another type", async () => {
    for (const name of ["null", "true", "2026", "no"]) {
      const project = makeProject()
      writeProjectFile(project, "domains.yaml", domainsYaml({ [name]: [BOARD_A2.id] }))
      await snapshot(project)
      expect(read(project, rawPath())).toContain(`\ndomain: "${name}"\n`)
      expect(frontmatterOf(project).domain).toBe(name)
    }
  })

  describe("overwrite guard", () => {
    it("refuses to replace a file that is not a snapshot of the card", async () => {
      const project = makeProject()
      const other = [
        "not a snapshot\n",
        `---\ntitle: "Mine"\nheptabase_card_id: ${id(7)}\n---\n\nText.\n`,
        `---\ntitle: "Mine"\n---\n\nText.\n`,
      ]
      for (const text of other) {
        writeProjectFile(project, rawPath(), text)
        const result = await snapshot(project)
        expect(result.exitCode).toBe(2)
        expect(result.output.problems).toEqual([expect.stringContaining(rawPath())])
        expect(read(project, rawPath())).toBe(text)
        expect(existsSync(join(project, "heptabase-map.json"))).toBe(false)
      }
    })

    it("replaces the file of a recorded source or a file of the same card", async () => {
      const project = makeProject()
      writeProjectFile(project, rawPath(), "not a snapshot\n")
      const map = loadCardMap(project)
      map.sources[CARD] = { raw_path: rawPath(), card_updated_at: UPDATED, ingest_commit: null }
      saveCardMap(project, map)
      expect((await snapshot(project, { text: "Recorded.\n" })).exitCode).toBe(0)
      expect(read(project, rawPath())).toContain("Recorded.")

      const lost = makeProject()
      writeProjectFile(lost, rawPath(), `---\ntitle: "Old"\nheptabase_card_id: ${CARD}\n---\n\nOld text.\n`)
      expect((await snapshot(lost, { text: "New.\n" })).exitCode).toBe(0)
      expect(read(lost, rawPath())).toContain("New.")
      expect(loadCardMap(lost).sources[CARD].raw_path).toBe(rawPath())
    })

    it("does not trust a recorded source whose path is another file", async () => {
      const project = makeProject()
      // The map says the card was saved elsewhere. The file at the target is not known to be this card's.
      writeProjectFile(project, rawPath(), "A file of the user.\n")
      const map = loadCardMap(project)
      map.sources[CARD] = { raw_path: "raw/sources/heptabase/moved.md", card_updated_at: UPDATED, ingest_commit: null }
      saveCardMap(project, map)
      const result = await snapshot(project, { text: "New.\n" })
      expect(result.exitCode).toBe(2)
      expect(result.output.problems).toEqual([expect.stringContaining(rawPath())])
      expect(read(project, rawPath())).toBe("A file of the user.\n")
      expect(loadCardMap(project).sources[CARD].raw_path).toBe("raw/sources/heptabase/moved.md")
    })

    it("replaces a file that names the card even when the recorded path differs", async () => {
      const project = makeProject()
      writeProjectFile(project, rawPath(), `---\ntitle: "Old"\nheptabase_card_id: ${CARD}\n---\n\nOld text.\n`)
      const map = loadCardMap(project)
      map.sources[CARD] = { raw_path: "raw/sources/heptabase/moved.md", card_updated_at: UPDATED, ingest_commit: null }
      saveCardMap(project, map)
      expect((await snapshot(project, { text: "New.\n" })).exitCode).toBe(0)
      expect(loadCardMap(project).sources[CARD].raw_path).toBe(rawPath())
    })

    it("refuses a folder in the place of the file", async () => {
      const project = makeProject()
      writeProjectFile(project, `${rawPath()}/inner.txt`, "x")
      const result = await snapshot(project)
      expect(result.exitCode).toBe(2)
      expect(result.output.problems).toEqual([expect.stringContaining(rawPath())])
    })
  })

  describe("the content files", () => {
    it("rejects a result whose status is not succeeded", async () => {
      const project = makeProject()
      const failed = join(project, "failed.json")
      writeProjectFile(project, "failed.json", JSON.stringify({ content: "Card not found.", status: "failed" }))
      const result = await snapshot(project, { files: [failed] })
      expect(result.exitCode).toBe(2)
      expect(result.output.problems).toEqual([expect.stringContaining(failed)])
      expect(result.output.problems?.[0]).toContain("failed")
      expect(existsSync(join(project, "raw"))).toBe(false)

      // One failed page among good pages stops the command as well.
      const mixed = await snapshot(project, { cardId: id(8), files: [PAGE_1, failed] })
      expect(mixed.exitCode).toBe(2)
      expect(mixed.output.problems).toEqual([expect.stringContaining(failed)])
    })

    it("rejects a status that is not a string, such as 1 or null", async () => {
      const project = makeProject()
      for (const status of [1, null, true, {}, ["succeeded"]]) {
        const failed = join(project, "failed.json")
        writeProjectFile(project, "failed.json", JSON.stringify({ content: "Card not found.", status }))
        const result = await snapshot(project, { files: [failed] })
        expect(result.exitCode, JSON.stringify(status)).toBe(2)
        expect(result.output.problems, JSON.stringify(status)).toEqual([expect.stringContaining(failed)])
      }
      expect(existsSync(join(project, "raw"))).toBe(false)
    })

    it("accepts the status succeeded, a missing status, and plain text", async () => {
      const project = makeProject()
      expect((await snapshot(project, { cardId: id(8), files: [PAGE_1, PAGE_2] })).exitCode).toBe(0)
      const noStatus = join(project, "no-status.json")
      writeProjectFile(project, "no-status.json", JSON.stringify({ content: `card "T" [${id(8)}] 1 line\n1\tText` }))
      expect((await snapshot(project, { cardId: id(8), files: [noStatus] })).exitCode).toBe(0)
      expect((await snapshot(project, { text: "# Plain\n" })).exitCode).toBe(0)
    })

    it("rejects a read_object result of another card", async () => {
      const project = makeProject()
      // The fixture pages are the pages of the card id(8), not of CARD.
      const result = await snapshot(project, { files: [PAGE_1, PAGE_2] })
      expect(result.exitCode).toBe(2)
      expect(result.output.problems).toEqual([expect.stringContaining(PAGE_1), expect.stringContaining(PAGE_2)])
      expect(result.output.problems?.[0]).toContain(id(8))
      expect(existsSync(join(project, "raw"))).toBe(false)
      expect(existsSync(join(project, "heptabase-map.json"))).toBe(false)
    })
  })

  it("overwrites the snapshot of a card and keeps the other sources", async () => {
    const project = makeProject()
    const map = loadCardMap(project)
    map.sources[id(70)] = { raw_path: rawPath(id(70)), card_updated_at: UPDATED, ingest_commit: "abc123" }
    saveCardMap(project, map)
    await snapshot(project, { text: "First text.\n" })
    const later = "2026-10-25T09:00:00.000Z"
    await snapshot(project, { text: "Second text.\n", title: "Renamed", updatedAt: later })
    expect(parseFrontmatter(read(project, rawPath())).body).toBe("Second text.\n")
    expect(frontmatterOf(project).title).toBe("Renamed")
    expect(loadCardMap(project).sources).toEqual({
      [id(70)]: { raw_path: rawPath(id(70)), card_updated_at: UPDATED, ingest_commit: "abc123" },
      [CARD]: { raw_path: rawPath(), card_updated_at: later, ingest_commit: null },
    })
  })

  it("rejects a non-UUID card id", async () => {
    const project = makeProject()
    for (const cardId of ["../../outside", "not-an-id", "00000000-0000-4000-8000-00000000000G", "0000000A-0000-4000-8000-00000000000A", `${CARD}/x`]) {
      const result = await snapshot(project, { cardId })
      expect(result.exitCode).toBe(2)
      expect(result.output.problems).toEqual([expect.stringContaining("--card-id")])
    }
    expect(existsSync(join(project, "raw"))).toBe(false)
    expect(existsSync(join(project, "heptabase-map.json"))).toBe(false)
  })

  it("refuses the card of a mirror page", async () => {
    const project = makeProject()
    const map: CardMap = loadCardMap(project)
    map.pages["wiki/mechanisms/one.md"] = {
      card_id: CARD,
      content_hash: "0".repeat(64),
      last_synced_at: NOW,
      card_updated_at: NOW,
      placements: [],
      status: "active",
    }
    saveCardMap(project, map)
    const result = await snapshot(project)
    expect(result.exitCode).toBe(2)
    expect(result.output.problems).toEqual([expect.stringContaining("wiki/mechanisms/one.md")])
    expect(existsSync(join(project, "raw"))).toBe(false)
    expect(loadCardMap(project).sources).toEqual({})
  })

  it("stops with a problem for bad input and writes nothing", async () => {
    const project = makeProject()
    const missing = await snapshot(project, { args: ["--project", project] })
    expect(missing.exitCode).toBe(2)
    expect(missing.output.problems).toEqual([
      "missing option: --card-id",
      "missing option: --title",
      "missing option: --card-type",
      "missing option: --whiteboards",
      "missing option: --content",
    ])

    const bad = async (options: SnapshotOptions, problem: string): Promise<void> => {
      const result = await snapshot(project, options)
      expect(result.exitCode).toBe(2)
      expect(result.output.problems).toEqual([expect.stringContaining(problem)])
    }
    await bad({ whiteboards: "text" }, "--whiteboards")
    await bad({ whiteboards: [{ id: "x", title: "T" }] }, "--whiteboards")
    await bad({ whiteboards: [{ id: id(1) }] }, "--whiteboards")
    await bad({ args: snapshotArgs(project, ["--whiteboards", "[oops"]) }, "--whiteboards")
    await bad({ updatedAt: "yesterday" }, "--updated-at")
    await bad({ title: "  " }, "--title")
    await bad({ cardType: "web card" }, "--card-type")
    await bad({ files: [join(project, "none.txt")] }, "--content")
    await bad({ cardId: id(8), files: [PAGE_1, join(FIXTURES, "list_cards_empty.txt")] }, "--content")
    expect((await snapshot(makeProject({}, { noHeptabaseYaml: true }))).output.problems).toEqual([expect.stringContaining("heptabase.yaml")])
    expect((await snapshot(join(project, "nowhere"), { files: [PAGE_1] })).output.problems).toEqual([expect.stringContaining("project folder not found")])
    expect(existsSync(join(project, "raw"))).toBe(false)
    expect(existsSync(join(project, "heptabase-map.json"))).toBe(false)
  })
})

/** The default command line with the values of `overrides` (option name and value pairs) replaced. */
function snapshotArgs(project: string, overrides: string[]): string[] {
  const args = new Map<string, string>([
    ["--project", project],
    ["--card-id", CARD],
    ["--title", "T"],
    ["--card-type", "card"],
    ["--whiteboards", "[]"],
    ["--content", join(FIXTURES, "list_cards_empty.txt")],
  ])
  for (let index = 0; index < overrides.length; index += 2) args.set(overrides[index], overrides[index + 1])
  return [...args].flat()
}
