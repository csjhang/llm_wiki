/**
 * cmd-plan-up.test.ts - tests for `wiki-tool hepta plan-up`.
 *
 * The tests run the command through runCli, so they also cover the registration of the
 * hepta group. The inputs are the files of tools/wiki-tool/fixtures and small lists written
 * here. Ids are placeholders (00000000-0000-4000-8000-0000000000NN) and titles are generic.
 *
 * The whiteboard tree of the fixture list_whiteboards.txt:
 *   Archive／Root (11)
 *   Root A (12) > Board A1 (3) > Board A2 (1), Board A3 (14)
 *   Root B (13) > Board B1 (15) > Board B2 (2), Board B3 (16)
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, describe, expect, it } from "vitest"
import { type CardMap, loadCardMap, saveCardMap } from "./card-map"
import { runCli } from "./cli"
import type { UpAction } from "./cmd-plan-up"
import { parseListWhiteboards } from "./parse-mcp"
import { id, makeProject, type ProjectOptions, removeProjects, writeProjectFile } from "./test-project"

const FIXTURES = fileURLToPath(new URL("../fixtures/", import.meta.url))
const CARDS = join(FIXTURES, "list_cards.txt")
const TWO_BOARDS = join(FIXTURES, "list_cards_two_boards.txt")
const WHITEBOARDS = join(FIXTURES, "list_whiteboards.txt")
const WHITEBOARDS_TEXT = readFileSync(WHITEBOARDS, "utf8")
/** The fixture list is the first page of 8 top-level whiteboards. This is the same text without the paging trailer. */
const COMPLETE_TREE = (JSON.parse(WHITEBOARDS_TEXT) as { content: string }).content.split("\n\nMore ")[0]

const NOW = "2026-10-24T08:00:00.000Z"
const BOARD_A2 = { id: id(1), title: "Board A2" }
const BOARD_B2 = { id: id(2), title: "Board B2" }
const ROOTS = [id(12), id(13)]

afterEach(removeProjects)

/** A tag that no fixture card has. The fixture cards carry the tag `wiki-test` (id 4), which is the mirror tag of makeProject. */
const MIRROR_TAG = id(70)

/** A project for plan-up. Its mirror tag is not on the fixture cards, so they are sources. */
function makeUpProject(files: Record<string, string> = {}, options: ProjectOptions = {}): string {
  return makeProject(files, { mirrorTag: MIRROR_TAG, ...options })
}

interface PlanOutput {
  ok: boolean
  actions: UpAction[]
  skipped: { archived: number; mirror: number; "mirror-tag": number; unchanged: number; declined: number; "other-wiki": number }
  warnings: string[]
  problems: string[]
}

async function planUp(project: string, extra: string[]): Promise<{ exitCode: number; output: PlanOutput }> {
  const result = await runCli(["hepta", "plan-up", "--project", project, "--now", NOW, ...extra])
  return { exitCode: result.exitCode, output: result.output as unknown as PlanOutput }
}

interface ListedCard {
  id: string
  title: string
  type?: string
  boards?: { id: string; title: string }[]
  updated?: string
}

/** A list_cards text: one line per card, like the tool writes it. */
function cardList(cards: ListedCard[]): string {
  const lines = cards.map((card) => {
    const boards = (card.boards ?? []).map((board) => `${board.title} [${board.id}]`).join(", ") || "none"
    return `${card.type ?? "card"} "${card.title}" [${card.id}] whiteboards: ${boards}, tags: none, created: 2026-09-01T00:00:00.000Z; updated: ${card.updated ?? "2026-10-01T00:00:00.000Z"}`
  })
  return ["Cards:", ...lines].join("\n")
}

/** A list_whiteboards text. Each entry is `[depth, id, title]`; a level is indented two spaces more than its parent. */
function whiteboardList(entries: [number, string, string][]): string {
  const lines = entries.map(([depth, boardId, title]) => `${"  ".repeat(depth)}whiteboard "${title}" [${boardId}] 0 cards, 0 sections, 0 non-card objects, 0 whiteboards`)
  return ["Whiteboards:", ...lines].join("\n")
}

/** Write a list into the project the way the skill saves MCP output, and return its path. */
function save(project: string, name: string, text: string): string {
  writeProjectFile(project, `.llm-wiki/hepta/${name}`, text)
  return join(project, ".llm-wiki/hepta", name)
}

/** The complete fixture tree, written into the project; returns the path for `--whiteboards`. */
function tree(project: string): string {
  return save(project, "whiteboards.txt", COMPLETE_TREE)
}

function source(updated: string): CardMap["sources"][string] {
  return { raw_path: "raw/sources/heptabase/x.md", card_updated_at: updated, ingest_commit: null }
}

function mapOf(project: string, change: (map: CardMap) => void): void {
  const map = loadCardMap(project)
  change(map)
  saveCardMap(project, map)
}

describe("hepta plan-up", () => {
  it("plans new cards", async () => {
    const project = makeUpProject({}, { roots: ROOTS })
    const { exitCode, output } = await planUp(project, ["--cards", CARDS, "--whiteboards", tree(project)])
    expect(exitCode).toBe(0)
    expect(output.ok).toBe(true)
    expect(output.actions).toEqual([
      { op: "snapshot", cardId: id(6), title: "Card N-00｜Map：entry", cardType: "card", whiteboards: [BOARD_A2] },
      { op: "snapshot", cardId: id(7), title: 'Card N-01｜Topic：from "a" to [b] end', cardType: "card", whiteboards: [BOARD_A2] },
      { op: "snapshot", cardId: id(8), title: "Card N-02｜Terms, one | two", cardType: "card", whiteboards: [BOARD_A2] },
    ])
    expect(output.skipped).toEqual({ archived: 0, mirror: 0, "mirror-tag": 0, unchanged: 0, declined: 0, "other-wiki": 0 })
  })

  it("skips unchanged cards", async () => {
    const project = makeUpProject({}, { roots: ROOTS })
    mapOf(project, (map) => {
      // card_updated_at equal to the card's updatedAt, and a later one: both are unchanged.
      map.sources[id(6)] = source("2026-10-04T07:28:31.245Z")
      map.sources[id(7)] = source("2026-10-05T00:00:00.000Z")
    })
    const { output } = await planUp(project, ["--cards", CARDS, "--whiteboards", tree(project)])
    expect(output.actions.map((action) => action.cardId)).toEqual([id(8)])
    expect(output.skipped.unchanged).toBe(2)
  })

  it("replans updated cards", async () => {
    const project = makeUpProject({}, { roots: ROOTS })
    mapOf(project, (map) => {
      map.sources[id(6)] = source("2026-10-04T07:28:31.244Z")
      map.sources[id(7)] = source("2026-10-04T07:28:38.779Z")
      map.sources[id(8)] = source("2026-10-04T07:28:41.259Z")
    })
    const { output } = await planUp(project, ["--cards", CARDS, "--whiteboards", tree(project)])
    expect(output.actions.map((action) => [action.op, action.cardId])).toEqual([["snapshot", id(6)]])
  })

  it("does not replan a snapshotted card whose list has no updatedAt", async () => {
    const project = makeUpProject({}, { roots: ROOTS })
    mapOf(project, (map) => {
      map.sources[id(6)] = source("2026-10-04T07:28:31.245Z")
    })
    const list = save(project, "cards.txt", `card "No dates" [${id(6)}] whiteboards: ${BOARD_A2.title} [${BOARD_A2.id}], tags: none`)
    const { output } = await planUp(project, ["--cards", list, "--whiteboards", tree(project)])
    expect(output.actions).toEqual([])
  })

  it("plans a card under two roots of this wiki: they are one wiki", async () => {
    const project = makeUpProject({}, { roots: ROOTS })
    const { exitCode, output } = await planUp(project, ["--cards", TWO_BOARDS, "--whiteboards", tree(project)])
    expect(exitCode).toBe(0)
    expect(output.actions).toEqual([
      { op: "snapshot", cardId: id(9), title: "Topic one", cardType: "card", whiteboards: [BOARD_B2, BOARD_A2] },
      { op: "snapshot", cardId: id(10), title: "Node 1.1", cardType: "card", whiteboards: [BOARD_B2, BOARD_A2] },
    ])
  })

  it("one root reached by two whiteboards is not a decision", async () => {
    const project = makeUpProject({}, { roots: ROOTS })
    const list = save(project, "cards.txt", cardList([{ id: id(30), title: "Two boards, one root", boards: [BOARD_A2, { id: id(14), title: "Board A3" }] }]))
    const { output } = await planUp(project, ["--cards", list, "--whiteboards", tree(project)])
    expect(output.actions).toEqual([
      { op: "snapshot", cardId: id(30), title: "Two boards, one root", cardType: "card", whiteboards: [BOARD_A2, { id: id(14), title: "Board A3" }] },
    ])
  })

  it("card under no root needs a decision", async () => {
    const project = makeUpProject({}, { roots: [id(12)] })
    const list = save(
      project,
      "cards.txt",
      cardList([
        { id: id(30), title: "Outside the roots", boards: [BOARD_B2] },
        { id: id(31), title: "On no whiteboard" },
        { id: id(32), title: "Unknown whiteboard", boards: [{ id: id(99), title: "Board Z" }] },
      ]),
    )
    const { exitCode, output } = await planUp(project, ["--cards", list, "--whiteboards", tree(project)])
    expect(exitCode).toBe(0)
    expect(output.actions).toEqual([
      { op: "ask", cardId: id(30), title: "Outside the roots", reason: "no-root" },
      { op: "ask", cardId: id(31), title: "On no whiteboard", reason: "no-root" },
      { op: "ask", cardId: id(32), title: "Unknown whiteboard", reason: "no-root" },
    ])
  })

  it("counts a card on a root whiteboard as under that root", async () => {
    const project = makeUpProject({}, { roots: [id(12)] })
    const list = save(project, "cards.txt", cardList([{ id: id(30), title: "On the root", boards: [{ id: id(12), title: "Root A" }] }]))
    // The tree is not stored yet: the whiteboard itself is a root.
    const { output } = await planUp(project, ["--cards", list])
    expect(output.actions.map((action) => action.op)).toEqual(["snapshot"])
  })

  it("skips archive boards", async () => {
    const project = makeUpProject({}, { roots: [id(12)], boards: { [id(11)]: "{ kind: archive }", [id(14)]: "{ kind: archive }" } })
    const tree = save(
      project,
      "whiteboards.txt",
      whiteboardList([
        [0, id(11), "Archive Root"],
        [1, id(21), "Old Board"],
        [2, id(22), "Older Board"],
        [0, id(12), "Root A"],
        [1, id(1), "Board A2"],
        [1, id(14), "Board A3"],
      ]),
    )
    const list = save(
      project,
      "cards.txt",
      cardList([
        { id: id(30), title: "On the archive board", boards: [{ id: id(11), title: "Archive Root" }] },
        { id: id(31), title: "Below the archive board", boards: [{ id: id(22), title: "Older Board" }] },
        { id: id(32), title: "Archived and under a root", boards: [BOARD_A2, { id: id(14), title: "Board A3" }] },
        { id: id(33), title: "Kept", boards: [BOARD_A2] },
      ]),
    )
    const { output } = await planUp(project, ["--cards", list, "--whiteboards", tree])
    expect(output.actions.map((action) => action.cardId)).toEqual([id(33)])
    expect(output.skipped.archived).toBe(3)
  })

  it("skips an archived card before it asks about its roots", async () => {
    const project = makeUpProject({}, { roots: ROOTS, boards: { [id(2)]: "{ kind: archive }" } })
    const { output } = await planUp(project, ["--cards", TWO_BOARDS, "--whiteboards", tree(project)])
    expect(output.actions).toEqual([])
    expect(output.skipped.archived).toBe(2)
  })

  it("never snapshots mirror cards", async () => {
    const project = makeUpProject({}, { roots: ROOTS })
    mapOf(project, (map) => {
      const entry = { content_hash: "0".repeat(64), last_synced_at: NOW, card_updated_at: NOW, placements: [] }
      map.pages["wiki/mechanisms/one.md"] = { ...entry, card_id: id(7), status: "active" }
      map.pages["wiki/mechanisms/two.md"] = { ...entry, card_id: id(8), status: "retired" }
    })
    const { output } = await planUp(project, ["--cards", CARDS, "--whiteboards", tree(project)])
    expect(output.actions.map((action) => action.cardId)).toEqual([id(6)])
    expect(output.skipped.mirror).toBe(2)
  })

  it("plans pdf download", async () => {
    const project = makeUpProject({}, { roots: ROOTS })
    const list = save(
      project,
      "cards.txt",
      cardList([
        { id: id(30), title: "A paper", type: "pdfCard", boards: [BOARD_A2] },
        { id: id(31), title: "A page", type: "webCard", boards: [BOARD_A2] },
        { id: id(32), title: "An unplaced paper", type: "pdfCard" },
      ]),
    )
    const { output } = await planUp(project, ["--cards", list, "--whiteboards", tree(project)])
    expect(output.actions).toEqual([
      { op: "download-pdf", cardId: id(30), title: "A paper" },
      { op: "snapshot", cardId: id(31), title: "A page", cardType: "webCard", whiteboards: [BOARD_A2] },
      { op: "ask", cardId: id(32), title: "An unplaced paper", reason: "no-root" },
    ])
  })

  it("joins paged card lists", async () => {
    const project = makeUpProject({}, { roots: ROOTS })
    const page1 = save(project, "cards-1.txt", cardList([
      { id: id(30), title: "First", boards: [BOARD_A2] },
      { id: id(31), title: "Second, old title", boards: [BOARD_A2] },
    ]))
    const page2 = save(project, "cards-2.txt", cardList([
      { id: id(31), title: "Second, new title", boards: [BOARD_A2] },
      { id: id(32), title: "Third", boards: [BOARD_B2] },
    ]))
    // The tree is paged as well: the second page lists Root B with its boards.
    const tree1 = save(project, "whiteboards-1.txt", whiteboardList([[0, id(12), "Root A"], [1, id(3), "Board A1"], [2, id(1), "Board A2"]]))
    const tree2 = save(project, "whiteboards-2.txt", whiteboardList([[0, id(13), "Root B"], [1, id(15), "Board B1"], [2, id(2), "Board B2"]]))
    const { exitCode, output } = await planUp(project, ["--cards", page1, "--cards", page2, "--whiteboards", tree1, "--whiteboards", tree2])
    expect(exitCode).toBe(0)
    expect(output.actions).toEqual([
      { op: "snapshot", cardId: id(30), title: "First", cardType: "card", whiteboards: [BOARD_A2] },
      { op: "snapshot", cardId: id(31), title: "Second, new title", cardType: "card", whiteboards: [BOARD_A2] },
      { op: "snapshot", cardId: id(32), title: "Third", cardType: "card", whiteboards: [BOARD_B2] },
    ])
    expect(loadCardMap(project).whiteboards_cache.items.map((node) => node.id)).toEqual([id(12), id(3), id(1), id(13), id(15), id(2)])
  })

  it("stores the whiteboard tree when it is given and reads it back later", async () => {
    const project = makeUpProject({}, { roots: ROOTS })
    expect(existsSync(join(project, "heptabase-map.json"))).toBe(false)
    const first = await planUp(project, ["--cards", CARDS])
    // Without a tree and without a stored one, nothing is saved, and the output says why every card asks.
    expect(existsSync(join(project, "heptabase-map.json"))).toBe(false)
    expect(first.output.warnings).toEqual(["the whiteboard tree is empty; pass --whiteboards"])

    await planUp(project, ["--cards", CARDS, "--whiteboards", tree(project)])
    const cache = loadCardMap(project).whiteboards_cache
    expect(cache.updated_at).toBe(NOW)
    expect(cache.items).toEqual(parseListWhiteboards(COMPLETE_TREE))

    const later = await planUp(project, ["--cards", CARDS])
    expect(later.output.actions.map((action) => action.op)).toEqual(["snapshot", "snapshot", "snapshot"])
    expect(later.output.warnings).toEqual([])
    expect(readdirSync(project).filter((name) => name.endsWith(".tmp"))).toEqual([])
  })

  it("saves the map only when the tree changed", async () => {
    const project = makeUpProject({}, { roots: ROOTS })
    const file = join(project, "heptabase-map.json")
    await planUp(project, ["--cards", CARDS, "--whiteboards", tree(project)])
    const first = statSync(file)
    const stored = readFileSync(file, "utf8")
    expect(loadCardMap(project).whiteboards_cache.updated_at).toBe(NOW)

    // The same tree on a later day: the map is not written again, and keeps its date.
    const later = await runCli(["hepta", "plan-up", "--project", project, "--now", "2026-11-01T00:00:00.000Z", "--cards", CARDS, "--whiteboards", tree(project)])
    expect(later.exitCode).toBe(0)
    expect(statSync(file).ino).toBe(first.ino)
    expect(readFileSync(file, "utf8")).toBe(stored)

    // Another tree is stored.
    const changed = save(project, "changed.txt", `${COMPLETE_TREE}\nwhiteboard "Root C" [${id(17)}] 0 cards, 0 sections, 0 non-card objects, 0 whiteboards`)
    await runCli(["hepta", "plan-up", "--project", project, "--now", "2026-11-01T00:00:00.000Z", "--cards", CARDS, "--whiteboards", changed])
    expect(loadCardMap(project).whiteboards_cache.updated_at).toBe("2026-11-01T00:00:00.000Z")
    expect(loadCardMap(project).whiteboards_cache.items.map((node) => node.id)).toContain(id(17))
  })

  it("warns when a whiteboard reports more whiteboards than the list shows, and still stores the tree", async () => {
    const project = makeUpProject({}, { roots: ROOTS })
    const cut = save(
      project,
      "cut.txt",
      [
        "Whiteboards:",
        `whiteboard "Root A" [${id(12)}] 0 cards, 0 sections, 0 non-card objects, 2 whiteboards`,
        `  whiteboard "Board A1" [${id(3)}] 0 cards, 0 sections, 0 non-card objects, 0 whiteboards`,
      ].join("\n"),
    )
    const { output } = await planUp(project, ["--cards", CARDS, "--whiteboards", cut])
    expect(output.warnings).toEqual([
      `the whiteboard list is cut off below "Root A" [${id(12)}] (2 whiteboards reported, 1 listed); call list_whiteboards again with depth 10`,
    ])
    expect(loadCardMap(project).whiteboards_cache.items).toHaveLength(2)
  })

  it("warns when the stored tree is empty and no list is given", async () => {
    const project = makeUpProject({}, { roots: ROOTS })
    mapOf(project, () => {})
    const { output } = await planUp(project, ["--cards", CARDS])
    expect(output.warnings).toEqual(["the whiteboard tree is empty; pass --whiteboards"])
    expect(output.actions.map((action) => action.op)).toEqual(["ask", "ask", "ask"])
  })

  it("warns about a partial whiteboard list and keeps the stored tree", async () => {
    const project = makeUpProject({}, { roots: ROOTS })
    await planUp(project, ["--cards", CARDS, "--whiteboards", tree(project)])
    const stored = loadCardMap(project).whiteboards_cache

    // The fixture list is the first page of 8 top-level whiteboards: it has a paging trailer.
    const { output } = await planUp(project, ["--cards", CARDS, "--whiteboards", WHITEBOARDS])
    expect(output.warnings).toEqual([expect.stringContaining("showing 1-3 of 8")])
    expect(output.warnings[0]).toContain("not changed")
    expect(loadCardMap(project).whiteboards_cache).toEqual(stored)
    // The cards are planned with the stored tree.
    expect(output.actions.map((action) => action.op)).toEqual(["snapshot", "snapshot", "snapshot"])
  })

  it("does not store a partial list when nothing is stored yet", async () => {
    const project = makeUpProject({}, { roots: ROOTS })
    const { output } = await planUp(project, ["--cards", CARDS, "--whiteboards", WHITEBOARDS])
    expect(output.warnings).toEqual([expect.stringContaining("showing 1-3 of 8")])
    expect(existsSync(join(project, "heptabase-map.json"))).toBe(false)
    expect(output.actions.map((action) => action.op)).toEqual(["ask", "ask", "ask"])
  })

  describe("other wikis", () => {
    /** Root A is this wiki. Root B belongs to another wiki that uses the same Heptabase space. */
    const other = (files: Record<string, string> = {}) => makeUpProject(files, { roots: [id(12)], otherRoots: [id(13)] })
    const BOARD_A3 = { id: id(14), title: "Board A3" }

    it("skips a card that is only under the roots of another wiki", async () => {
      const project = other()
      const list = save(project, "cards.txt", cardList([{ id: id(30), title: "Theirs", boards: [BOARD_B2] }]))
      const { exitCode, output } = await planUp(project, ["--cards", list, "--whiteboards", tree(project)])
      expect(exitCode).toBe(0)
      expect(output.actions).toEqual([])
      expect(output.skipped["other-wiki"]).toBe(1)
    })

    it("plans a card that is only under a root of this wiki", async () => {
      const project = other()
      const list = save(project, "cards.txt", cardList([{ id: id(30), title: "Ours", boards: [BOARD_A2, BOARD_A3] }]))
      const { output } = await planUp(project, ["--cards", list, "--whiteboards", tree(project)])
      expect(output.actions.map((action) => action.op)).toEqual(["snapshot"])
      expect(output.skipped["other-wiki"]).toBe(0)
    })

    it("asks about a card under a root of this wiki and a root of another wiki", async () => {
      const project = other()
      const list = save(project, "cards.txt", cardList([{ id: id(30), title: "Both", boards: [BOARD_A2, BOARD_B2] }]))
      const { output } = await planUp(project, ["--cards", list, "--whiteboards", tree(project)])
      expect(output.actions).toEqual([{ op: "ask", cardId: id(30), title: "Both", reason: "two-wikis" }])
    })

    it("asks about a card under no root of either", async () => {
      const project = other()
      const list = save(
        project,
        "cards.txt",
        cardList([
          { id: id(30), title: "Nowhere" },
          { id: id(31), title: "Unknown board", boards: [{ id: id(99), title: "Board Z" }] },
        ]),
      )
      const { output } = await planUp(project, ["--cards", list, "--whiteboards", tree(project)])
      expect(output.actions).toEqual([
        { op: "ask", cardId: id(30), title: "Nowhere", reason: "no-root" },
        { op: "ask", cardId: id(31), title: "Unknown board", reason: "no-root" },
      ])
    })

    it("counts the nearest root of each whiteboard: a root of this wiki inside a root of another wiki is this wiki", async () => {
      const project = other()
      const nested = save(
        project,
        "nested.txt",
        whiteboardList([
          [0, id(13), "Root B"],
          [1, id(12), "Root A"],
          [2, id(1), "Board A2"],
          [1, id(2), "Board B2"],
        ]),
      )
      const list = save(
        project,
        "cards.txt",
        cardList([
          { id: id(30), title: "Inside both", boards: [BOARD_A2] },
          { id: id(31), title: "Only in the other", boards: [BOARD_B2] },
        ]),
      )
      const { output } = await planUp(project, ["--cards", list, "--whiteboards", nested])
      expect(output.actions.map((action) => [action.op, action.cardId])).toEqual([["snapshot", id(30)]])
      expect(output.skipped["other-wiki"]).toBe(1)
    })

    it("updates a card it snapshotted already, whatever roots it is under now", async () => {
      const project = other()
      mapOf(project, (map) => {
        map.sources[id(30)] = source("2023-01-01T00:00:00.000Z")
      })
      const list = save(project, "cards.txt", cardList([{ id: id(30), title: "Theirs now", boards: [BOARD_B2] }]))
      const { output } = await planUp(project, ["--cards", list, "--whiteboards", tree(project)])
      expect(output.actions.map((action) => action.op)).toEqual(["snapshot"])
    })

    it("lets a decision of this-wiki settle a card of another wiki", async () => {
      const project = other()
      mapOf(project, (map) => {
        map.up_decisions = { [id(30)]: "this-wiki" }
      })
      const list = save(project, "cards.txt", cardList([{ id: id(30), title: "Mine after all", boards: [BOARD_B2] }]))
      const { output } = await planUp(project, ["--cards", list, "--whiteboards", tree(project)])
      expect(output.actions.map((action) => action.op)).toEqual(["snapshot"])
    })
  })

  describe("the mirror tag", () => {
    it("never snapshots a card that has the mirror tag, whatever the map says", async () => {
      const project = makeProject({}, { roots: ROOTS, mirrorTag: id(4) })
      // The fixture cards have the tag wiki-test [4]: here it is the mirror tag.
      const { output } = await planUp(project, ["--cards", CARDS, "--whiteboards", tree(project)])
      expect(output.actions).toEqual([])
      expect(output.skipped["mirror-tag"]).toBe(3)
      expect(output.skipped.mirror).toBe(0)
    })

    it("skips it also when a snapshot exists and the card changed", async () => {
      const project = makeProject({}, { roots: ROOTS, mirrorTag: id(4) })
      mapOf(project, (map) => {
        map.sources[id(6)] = source("2023-01-01T00:00:00.000Z")
      })
      const { output } = await planUp(project, ["--cards", CARDS, "--whiteboards", tree(project)])
      expect(output.actions).toEqual([])
      expect(output.skipped["mirror-tag"]).toBe(3)
    })

    it("counts the other skips first: a mirror card of the map, an unchanged card, an archived card", async () => {
      const project = makeProject({}, { roots: ROOTS, mirrorTag: id(4), boards: { [id(1)]: "{ kind: archive }" } })
      mapOf(project, (map) => {
        map.pages["wiki/mechanisms/one.md"] = {
          card_id: id(6),
          content_hash: "0".repeat(64),
          last_synced_at: NOW,
          card_updated_at: NOW,
          placements: [],
          status: "active",
        }
        map.sources[id(7)] = source("2026-10-05T00:00:00.000Z")
      })
      const { output } = await planUp(project, ["--cards", CARDS, "--whiteboards", tree(project)])
      expect(output.skipped).toEqual({ archived: 1, mirror: 1, "mirror-tag": 0, unchanged: 1, declined: 0, "other-wiki": 0 })
    })

    it("plans a card that has the ingest tag and no mirror tag", async () => {
      const project = makeProject({}, { roots: ROOTS, mirrorTag: id(70) })
      const { output } = await planUp(project, ["--cards", CARDS, "--whiteboards", tree(project)])
      expect(output.actions).toHaveLength(3)
      expect(output.skipped["mirror-tag"]).toBe(0)
    })
  })

  describe("decisions", () => {
    /** Root A is this wiki; the cards are under no root. */
    const lonely = () => {
      const project = makeUpProject({}, { roots: [id(12)] })
      const list = save(
        project,
        "cards.txt",
        cardList([
          { id: id(30), title: "Outside", boards: [BOARD_B2] },
          { id: id(31), title: "Also outside", boards: [BOARD_B2] },
        ]),
      )
      return { project, list }
    }

    const decide = (project: string, cardId: string, decision: string) =>
      runCli(["hepta", "record", "--project", project, "--event", JSON.stringify({ type: "up-decision", cardId, decision })])

    it("remembers a skip", async () => {
      const { project, list } = lonely()
      const asked = await planUp(project, ["--cards", list, "--whiteboards", tree(project)])
      expect(asked.output.actions.map((action) => action.op)).toEqual(["ask", "ask"])

      expect((await decide(project, id(30), "skip")).exitCode).toBe(0)
      const again = await planUp(project, ["--cards", list])
      expect(again.output.actions).toEqual([{ op: "ask", cardId: id(31), title: "Also outside", reason: "no-root" }])
      expect(again.output.skipped.declined).toBe(1)
    })

    it("remembers this-wiki: the card is planned", async () => {
      const { project, list } = lonely()
      await planUp(project, ["--cards", list, "--whiteboards", tree(project)])
      expect((await decide(project, id(30), "this-wiki")).exitCode).toBe(0)
      const again = await planUp(project, ["--cards", list])
      expect(again.output.actions.map((action) => [action.op, action.cardId])).toEqual([
        ["snapshot", id(30)],
        ["ask", id(31)],
      ])
    })

    it("takes a root id from an older answer as this-wiki", async () => {
      const project = makeUpProject({}, { roots: ROOTS })
      const list = save(
        project,
        "cards.txt",
        cardList([
          { id: id(31), title: "No root", boards: [{ id: id(99), title: "Board Z" }] },
          { id: id(32), title: "pdf, no root", type: "pdfCard" },
        ]),
      )
      mapOf(project, (map) => {
        map.up_decisions = { [id(31)]: id(12), [id(32)]: id(13) }
      })
      const { output } = await planUp(project, ["--cards", list, "--whiteboards", tree(project)])
      expect(output.actions).toEqual([
        { op: "snapshot", cardId: id(31), title: "No root", cardType: "card", whiteboards: [{ id: id(99), title: "Board Z" }] },
        { op: "download-pdf", cardId: id(32), title: "pdf, no root" },
      ])
    })

    it("asks again about an answer it does not know", async () => {
      const { project, list } = lonely()
      mapOf(project, (map) => {
        map.up_decisions = { [id(30)]: "maybe" }
      })
      const { output } = await planUp(project, ["--cards", list, "--whiteboards", tree(project)])
      expect(output.actions.map((action) => action.op)).toEqual(["ask", "ask"])
    })

    it("does not override the archive, mirror, or unchanged skips", async () => {
      const project = makeUpProject({}, { roots: ROOTS, boards: { [id(2)]: "{ kind: archive }" } })
      mapOf(project, (map) => {
        map.up_decisions = { [id(9)]: "this-wiki", [id(10)]: "skip" }
      })
      const { output } = await planUp(project, ["--cards", TWO_BOARDS, "--whiteboards", tree(project)])
      expect(output.actions).toEqual([])
      expect(output.skipped).toEqual({ archived: 2, mirror: 0, "mirror-tag": 0, unchanged: 0, declined: 0, "other-wiki": 0 })
    })

    it("lets a snapshotted card be updated whatever was decided", async () => {
      const { project, list } = lonely()
      mapOf(project, (map) => {
        map.sources[id(30)] = source("2023-01-01T00:00:00.000Z")
        map.up_decisions = { [id(30)]: "skip" }
      })
      const { output } = await planUp(project, ["--cards", list, "--whiteboards", tree(project)])
      expect(output.actions.map((action) => [action.op, action.cardId])).toEqual([["snapshot", id(30)], ["ask", id(31)]])
    })
  })

  it("plans the update of a card it already snapshotted without asking again", async () => {
    const project = makeUpProject({}, { roots: [id(12)] })
    mapOf(project, (map) => {
      map.sources[id(9)] = source("2023-01-01T00:00:00.000Z")
    })
    // Both cards are under no root of this wiki: the one with a snapshot is updated, the other one is asked about.
    const list = save(
      project,
      "cards.txt",
      cardList([
        { id: id(9), title: "Topic one", boards: [BOARD_B2] },
        { id: id(10), title: "Node 1.1", boards: [BOARD_B2] },
      ]),
    )
    const { output } = await planUp(project, ["--cards", list, "--whiteboards", tree(project)])
    expect(output.actions).toEqual([
      { op: "snapshot", cardId: id(9), title: "Topic one", cardType: "card", whiteboards: [BOARD_B2] },
      { op: "ask", cardId: id(10), title: "Node 1.1", reason: "no-root" },
    ])
  })

  it("stops with a problem for bad input and writes no card map", async () => {
    const project = makeUpProject({}, { roots: ROOTS })
    const missing = await planUp(project, [])
    expect(missing.exitCode).toBe(2)
    expect(missing.output.problems).toEqual(["missing option: --cards"])

    const unreadable = await planUp(project, ["--cards", join(project, "none.txt"), "--whiteboards", join(project, "none2.txt")])
    expect(unreadable.exitCode).toBe(2)
    expect(unreadable.output.problems).toEqual([expect.stringContaining("--cards"), expect.stringContaining("--whiteboards")])

    const noFolder = await planUp(join(project, "nowhere"), ["--cards", CARDS])
    expect(noFolder.exitCode).toBe(2)
    expect(noFolder.output.problems).toEqual([expect.stringContaining("project folder not found")])

    const noConfig = await planUp(makeUpProject({}, { noHeptabaseYaml: true }), ["--cards", CARDS])
    expect(noConfig.exitCode).toBe(2)
    expect(noConfig.output.problems).toEqual([expect.stringContaining("heptabase.yaml")])
    expect(existsSync(join(project, "heptabase-map.json"))).toBe(false)
  })

  it("refuses an empty whiteboard list instead of clearing the stored tree", async () => {
    const project = makeUpProject({}, { roots: ROOTS })
    await planUp(project, ["--cards", CARDS, "--whiteboards", tree(project)])
    const empty = save(project, "empty.txt", "Whiteboards:\n")
    const result = await planUp(project, ["--cards", CARDS, "--whiteboards", empty])
    expect(result.exitCode).toBe(2)
    expect(result.output.problems).toEqual([expect.stringContaining("no whiteboards")])
    expect(loadCardMap(project).whiteboards_cache.items.length).toBeGreaterThan(0)
  })
})
