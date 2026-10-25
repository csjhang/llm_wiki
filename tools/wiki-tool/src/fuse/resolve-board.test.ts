/**
 * resolve-board.test.ts - tests for `wiki-tool fuse resolve-board`.
 *
 * The tests run the command through runCli. Ids are placeholders (00000000-0000-4000-8000-0000000000NN) and titles are
 * generic. The board is the fixture read_whiteboard_fusion.txt:
 *   Board F1 (1)
 *     section 來源｜Mechanism side (17): cards 6, 7
 *     section Target domain (18): card 21, mind map Topic one (20)
 *     section Notes (19): card 22
 * The mind map is the fixture read_object_mindmap.txt: cards 9, 10, 34, 35, 36, 37, 38.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, describe, expect, it } from "vitest"
import { type CardMap, saveCardMap } from "../card-map"
import { runCli } from "../cli"
import { id, makeProject, pageText, removeProjects, writeProjectFile } from "../test-project"
import type { BoardContext } from "./resolve-board"

const FIXTURES = fileURLToPath(new URL("../../fixtures/", import.meta.url))
const STRUCTURE = join(FIXTURES, "read_whiteboard_fusion.txt")
const MIND_MAP = join(FIXTURES, "read_object_mindmap.txt")

const MIND_MAP_CARDS = [id(9), id(10), id(34), id(35), id(36), id(37), id(38)]

afterEach(removeProjects)

type Output = Partial<BoardContext> & { ok: boolean; problems?: string[]; warnings?: string[] }

async function resolveBoard(args: string[]) {
  const result = await runCli(["fuse", "resolve-board", ...args])
  return { exitCode: result.exitCode, output: result.output as Output }
}

/** The board of the fixtures, with the mind map, resolved against the project and the other wikis. */
async function resolveFixtureBoard(project: string, wikis: string[] = []) {
  return resolveBoard([
    "--project", project,
    "--structure", STRUCTURE,
    "--mindmap", MIND_MAP,
    ...wikis.flatMap((wiki) => ["--wiki", wiki]),
  ])
}

function cardOf(output: Output, cardId: string) {
  const card = output.cards?.find((candidate) => candidate.cardId === cardId)
  if (!card) throw new Error(`card ${cardId} is not in the output`)
  return card
}

/**
 * Write a card map with the given mirror pages (page path to card id) and sources (card id to snapshot path).
 * The pages in `retired` (paths) are retired pages.
 */
function writeMap(
  project: string,
  pages: Record<string, string> = {},
  sources: Record<string, string> = {},
  retired: readonly string[] = [],
): void {
  const map: CardMap = { version: 1, pages: {}, sources: {}, whiteboards_cache: { updated_at: "", items: [] } }
  for (const [path, cardId] of Object.entries(pages)) {
    map.pages[path] = {
      card_id: cardId,
      content_hash: "0",
      last_synced_at: "2026-10-01T00:00:00.000Z",
      card_updated_at: "2026-10-01T00:00:00.000Z",
      placements: [],
      status: retired.includes(path) ? "retired" : "active",
    }
  }
  for (const [cardId, rawPath] of Object.entries(sources)) {
    map.sources[cardId] = { raw_path: rawPath, card_updated_at: "2026-10-01T00:00:00.000Z", ingest_commit: null }
  }
  saveCardMap(project, map)
}

/** Every file under `directory` with its content and modification time, to compare before and after a run. */
function treeOf(directory: string, base = directory): Record<string, string> {
  const files: Record<string, string> = {}
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) Object.assign(files, treeOf(path, base))
    else files[path.slice(base.length)] = `${statSync(path).mtimeMs}:${readFileSync(path, "utf8")}`
  }
  return files
}

describe("fuse resolve-board", () => {
  it("pairs source and target sections", async () => {
    const project = makeProject()
    const { exitCode, output } = await resolveFixtureBoard(project)
    expect(exitCode).toBe(0)
    expect(output.ok).toBe(true)
    expect(output.boardId).toBe(id(1))
    expect(output.boardTitle).toBe("Board F1")
    expect(output.pairing).toEqual({ source: [id(6), id(7)], target: [id(21), ...MIND_MAP_CARDS] })
    expect(cardOf(output, id(6))).toMatchObject({ title: "Card S-01｜Mechanism：entry", section: "來源｜Mechanism side", side: "source" })
    expect(cardOf(output, id(7)).title).toBe('Card S-02｜Note：from "a" to [b] end')
    expect(cardOf(output, id(21))).toMatchObject({ section: "Target domain", side: "target" })
    // A section that is neither side has cards without a side.
    expect(cardOf(output, id(22))).toMatchObject({ section: "Notes", side: null })
  })

  it("names the side of a section by its title prefix", async () => {
    const project = makeProject()
    const titles = ["Source: a", "source b", "來源 c", "Target: d", "target e", "目標 f", "Resource", "My Source", ""]
    const lines = [`whiteboard "Board" [${id(1)}]`]
    titles.forEach((title, index) => lines.push(`section "${title}" [${id(100 + index)}]`, `  card "Card ${index}" [${id(200 + index)}]`))
    writeProjectFile(project, "board.txt", lines.join("\n"))
    const { output } = await resolveBoard(["--project", project, "--structure", join(project, "board.txt")])
    const sides = (output.cards ?? []).map((card) => card.side)
    expect(sides).toEqual(["source", "source", "source", "target", "target", "target", null, null, null])
  })

  it("no sections means no pairing", async () => {
    const project = makeProject()
    writeProjectFile(
      project,
      "board.txt",
      [`whiteboard "Board" [${id(1)}]`, "", `section "Group one" [${id(17)}]`, `  card "Card A" [${id(6)}]`, "(unsectioned)", `  card "Card B" [${id(7)}]`].join("\n"),
    )
    const { exitCode, output } = await resolveBoard(["--project", project, "--structure", join(project, "board.txt")])
    expect(exitCode).toBe(0)
    expect(output.pairing).toBeNull()
    expect(output.cards?.map((card) => [card.cardId, card.section, card.side])).toEqual([
      [id(6), "Group one", null],
      [id(7), null, null],
    ])
  })

  it("one side without the other is no pairing", async () => {
    const project = makeProject()
    writeProjectFile(
      project,
      "board.txt",
      [`whiteboard "Board" [${id(1)}]`, `section "Source" [${id(17)}]`, `  card "Card A" [${id(6)}]`, `section "Target" [${id(18)}]`].join("\n"),
    )
    const { output } = await resolveBoard(["--project", project, "--structure", join(project, "board.txt")])
    expect(output.pairing).toBeNull()
    expect(cardOf(output, id(6)).side).toBe("source")
  })

  it("mind map cards join their section", async () => {
    const project = makeProject()
    const { output } = await resolveFixtureBoard(project)
    const mindMapCards = (output.cards ?? []).filter((card) => MIND_MAP_CARDS.includes(card.cardId))
    expect(mindMapCards.map((card) => card.cardId)).toEqual(MIND_MAP_CARDS)
    expect(mindMapCards.every((card) => card.section === "Target domain" && card.side === "target")).toBe(true)
    expect(mindMapCards[0].title).toBe("Topic one")
    // The section's own cards come first, then the cards of its mind map; the next section follows.
    expect((output.cards ?? []).map((card) => card.cardId)).toEqual([id(6), id(7), id(21), ...MIND_MAP_CARDS, id(22)])
  })

  it("warns about a mind map that has no file", async () => {
    const project = makeProject()
    const { exitCode, output } = await resolveBoard(["--project", project, "--structure", STRUCTURE])
    expect(exitCode).toBe(0)
    expect(output.warnings).toEqual([expect.stringContaining(id(20))])
    expect(output.cards?.map((card) => card.cardId)).toEqual([id(6), id(7), id(21), id(22)])
  })

  it("refuses a mind map file of another mind map", async () => {
    const project = makeProject()
    writeProjectFile(
      project,
      "map.txt",
      `mindMap "Other" [${id(99)}] 1 nodes\n1\tcard "Node" cardId: [${id(9)}], nodeId: [${id(27)}]`,
    )
    const { exitCode, output } = await resolveBoard(["--project", project, "--structure", STRUCTURE, "--mindmap", join(project, "map.txt")])
    expect(exitCode).toBe(2)
    expect(output.problems).toEqual([expect.stringContaining(join(project, "map.txt"))])
    expect(output.problems?.[0]).toContain(id(99))
  })

  it("resolves mirror cards across wikis", async () => {
    const project = makeProject({}, { wikiId: "work" })
    const reading = makeProject({}, { wikiId: "reading" })
    writeMap(project, { "wiki/mechanisms/own.md": id(6) })
    writeMap(reading, { "wiki/mechanisms/event-driven.md": id(21) })
    const { exitCode, output } = await resolveFixtureBoard(project, [reading])
    expect(exitCode).toBe(0)
    expect(cardOf(output, id(6))).toMatchObject({ status: "mirror", wiki: "work", pages: ["wiki/mechanisms/own.md"] })
    expect(cardOf(output, id(21))).toMatchObject({ status: "mirror", wiki: "reading", pages: ["wiki/mechanisms/event-driven.md"] })
    expect(cardOf(output, id(7))).toMatchObject({ status: "not-ingested", wiki: null, pages: [] })
  })

  it("lists the pages of a mirror card sorted", async () => {
    const project = makeProject()
    writeMap(project, { "wiki/mechanisms/b.md": id(21), "wiki/mechanisms/a.md": id(21) })
    const { output } = await resolveFixtureBoard(project)
    expect(cardOf(output, id(21))).toMatchObject({ status: "mirror", pages: ["wiki/mechanisms/a.md", "wiki/mechanisms/b.md"] })
  })

  it("marks a card whose page is retired", async () => {
    const project = makeProject({}, { wikiId: "work" })
    const reading = makeProject({}, { wikiId: "reading" })
    writeMap(project, { "wiki/mechanisms/gone.md": id(6), "wiki/mechanisms/live.md": id(7) }, {}, ["wiki/mechanisms/gone.md"])
    writeMap(reading, { "wiki/mechanisms/gone-too.md": id(21) }, {}, ["wiki/mechanisms/gone-too.md"])
    const { exitCode, output } = await resolveFixtureBoard(project, [reading])
    expect(exitCode).toBe(0)
    expect(cardOf(output, id(6))).toMatchObject({ status: "retired", wiki: "work", pages: ["wiki/mechanisms/gone.md"] })
    expect(cardOf(output, id(21))).toMatchObject({ status: "retired", wiki: "reading", pages: ["wiki/mechanisms/gone-too.md"] })
    expect(cardOf(output, id(7))).toMatchObject({ status: "mirror", wiki: "work", pages: ["wiki/mechanisms/live.md"] })
  })

  it("prefers an active page of a card over a retired one", async () => {
    const project = makeProject({}, { wikiId: "work" })
    const reading = makeProject({}, { wikiId: "reading" })
    writeMap(project, { "wiki/mechanisms/old.md": id(6) }, {}, ["wiki/mechanisms/old.md"])
    writeMap(reading, { "wiki/mechanisms/new.md": id(6) })
    const { output } = await resolveFixtureBoard(project, [reading])
    expect(cardOf(output, id(6))).toMatchObject({ status: "mirror", wiki: "reading", pages: ["wiki/mechanisms/new.md"] })
  })

  it("resolves ingested cards to pages", async () => {
    const project = makeProject(
      {
        "wiki/concepts/alpha.md": pageText({ title: "Alpha", type: "concept", sources: [`${id(7)}.md`] }),
        "wiki/concepts/beta.md": pageText({ title: "Beta", type: "concept", sources: [`${id(7)}.md`, `${id(21)}.md`] }),
        "wiki/concepts/gamma.md": pageText({ title: "Gamma", type: "concept", sources: [`${id(22)}.md`] }),
      },
      { wikiId: "work" },
    )
    const reading = makeProject(
      { "wiki/concepts/delta.md": pageText({ title: "Delta", type: "concept", sources: [`${id(6)}.md`] }) },
      { wikiId: "reading" },
    )
    writeMap(project, {}, { [id(7)]: `raw/sources/heptabase/${id(7)}.md`, [id(21)]: `raw/sources/heptabase/${id(21)}.md` })
    writeMap(reading, {}, { [id(6)]: `raw/sources/heptabase/${id(6)}.md` })
    const { exitCode, output } = await resolveFixtureBoard(project, [reading])
    expect(exitCode).toBe(0)
    expect(cardOf(output, id(7))).toMatchObject({ status: "ingested", wiki: "work", pages: ["wiki/concepts/alpha.md", "wiki/concepts/beta.md"] })
    expect(cardOf(output, id(21))).toMatchObject({ status: "ingested", wiki: "work", pages: ["wiki/concepts/beta.md"] })
    expect(cardOf(output, id(6))).toMatchObject({ status: "ingested", wiki: "reading", pages: ["wiki/concepts/delta.md"] })
    // gamma.md cites a snapshot the map does not know, so the card is not ingested.
    expect(cardOf(output, id(22))).toMatchObject({ status: "not-ingested", wiki: null, pages: [] })
  })

  it("reports the wiki whose pages cite a card that several wikis ingested", async () => {
    const snapshot = `raw/sources/heptabase/${id(7)}.md`
    const project = makeProject({}, { wikiId: "work" })
    const reading = makeProject(
      { "wiki/concepts/delta.md": pageText({ title: "Delta", type: "concept", sources: [`${id(7)}.md`] }) },
      { wikiId: "reading" },
    )
    const third = makeProject(
      { "wiki/concepts/epsilon.md": pageText({ title: "Epsilon", type: "concept", sources: [`${id(7)}.md`] }) },
      { wikiId: "third" },
    )
    writeMap(project, {}, { [id(7)]: snapshot })
    writeMap(reading, {}, { [id(7)]: snapshot })
    writeMap(third, {}, { [id(7)]: snapshot })
    const { output } = await resolveFixtureBoard(project, [reading, third])
    // The project ingested the card too, but no page of it cites the snapshot; the first wiki with a citing page answers.
    expect(cardOf(output, id(7))).toMatchObject({ status: "ingested", wiki: "reading", pages: ["wiki/concepts/delta.md"] })
  })

  it("reports the first wiki when no page cites a card that several wikis ingested", async () => {
    const snapshot = `raw/sources/heptabase/${id(7)}.md`
    const project = makeProject({}, { wikiId: "work" })
    const reading = makeProject({}, { wikiId: "reading" })
    writeMap(project, {}, { [id(7)]: snapshot })
    writeMap(reading, {}, { [id(7)]: snapshot })
    const { output } = await resolveFixtureBoard(project, [reading])
    expect(cardOf(output, id(7))).toMatchObject({ status: "ingested", wiki: "work", pages: [] })
  })

  it("reports an ingested card that no page cites yet", async () => {
    const project = makeProject({ "wiki/concepts/alpha.md": pageText({ title: "Alpha", type: "concept", sources: ["other.md"] }) })
    writeMap(project, {}, { [id(7)]: `raw/sources/heptabase/${id(7)}.md` })
    const { output } = await resolveFixtureBoard(project)
    expect(cardOf(output, id(7))).toMatchObject({ status: "ingested", wiki: "test", pages: [] })
  })

  it("reports cards that are not ingested", async () => {
    const project = makeProject()
    const { exitCode, output } = await resolveFixtureBoard(project)
    expect(exitCode).toBe(0)
    expect(output.cards).toHaveLength(11)
    expect(output.cards?.every((card) => card.status === "not-ingested" && card.wiki === null && card.pages.length === 0)).toBe(true)
  })

  it("refuses a failed structure result", async () => {
    const project = makeProject()
    writeProjectFile(project, "failed.txt", JSON.stringify({ content: "", status: "failed" }))
    const failed = await resolveBoard(["--project", project, "--structure", join(project, "failed.txt")])
    expect(failed.exitCode).toBe(2)
    expect(failed.output.problems).toEqual([expect.stringContaining(join(project, "failed.txt"))])
    expect(failed.output.problems?.[0]).toContain("failed")

    const mindMap = await resolveBoard(["--project", project, "--structure", STRUCTURE, "--mindmap", join(project, "failed.txt")])
    expect(mindMap.exitCode).toBe(2)
    expect(mindMap.output.problems).toEqual([expect.stringContaining(join(project, "failed.txt"))])
  })

  it("refuses a structure file that is not a whiteboard", async () => {
    const project = makeProject()
    writeProjectFile(project, "text.txt", "No whiteboard here.")
    const { exitCode, output } = await resolveBoard(["--project", project, "--structure", join(project, "text.txt")])
    expect(exitCode).toBe(2)
    expect(output.problems).toEqual([expect.stringContaining(join(project, "text.txt"))])
  })

  it("reads other wikis read-only", async () => {
    const project = makeProject({ "wiki/concepts/alpha.md": pageText({ title: "Alpha", type: "concept", sources: [`${id(7)}.md`] }) }, { wikiId: "work" })
    const reading = makeProject(
      { "wiki/concepts/delta.md": pageText({ title: "Delta", type: "concept", sources: [`${id(6)}.md`] }) },
      { wikiId: "reading" },
    )
    writeMap(project, {}, { [id(7)]: `raw/sources/heptabase/${id(7)}.md` })
    writeMap(reading, { "wiki/mechanisms/event-driven.md": id(21) }, { [id(6)]: `raw/sources/heptabase/${id(6)}.md` })
    const beforeReading = treeOf(reading)
    const beforeProject = treeOf(project)

    const { exitCode } = await resolveFixtureBoard(project, [reading])

    expect(exitCode).toBe(0)
    expect(treeOf(reading)).toEqual(beforeReading)
    expect(treeOf(project)).toEqual(beforeProject)
  })

  it("does not create a card map in a wiki that has none", async () => {
    const project = makeProject()
    const other = makeProject({}, { wikiId: "reading" })
    const { exitCode } = await resolveFixtureBoard(project, [other])
    expect(exitCode).toBe(0)
    expect(existsSync(join(other, "heptabase-map.json"))).toBe(false)
    expect(existsSync(join(project, "heptabase-map.json"))).toBe(false)
  })

  it("reports a wiki that is not a wiki project", async () => {
    const project = makeProject()
    const missing = join(project, "no-such-folder")
    const noYaml = makeProject()
    writeProjectFile(noYaml, "wiki.yaml", "version: 1\nid: Not Valid\nrole: reading\n")
    const { exitCode, output } = await resolveFixtureBoard(project, [missing, noYaml])
    expect(exitCode).toBe(2)
    expect(output.problems).toHaveLength(2)
    expect(output.problems?.[0]).toContain(missing)
    expect(output.problems?.[1]).toContain(noYaml)
  })

  it("reports missing options", async () => {
    const { exitCode, output } = await resolveBoard([])
    expect(exitCode).toBe(2)
    expect(output.problems).toEqual(["missing option: --project", "missing option: --structure"])
  })
})
