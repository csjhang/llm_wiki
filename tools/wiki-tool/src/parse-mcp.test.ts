/**
 * parse-mcp.test.ts - tests for the parsers of Heptabase MCP text output.
 *
 * The fixtures in tools/wiki-tool/fixtures are anonymized samples of real MCP
 * output: ids are 00000000-0000-4000-8000-0000000000NN and titles are generic.
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import {
  joinReadObjectPages,
  parseListCards,
  parseListWhiteboards,
  parseMindMap,
  parsePagingTrailer,
  parseWhiteboardStructure,
} from "./parse-mcp"

const FIXTURES = fileURLToPath(new URL("../fixtures/", import.meta.url))

function fixture(name: string): string {
  return readFileSync(join(FIXTURES, name), "utf8")
}

/** The envelope's `content` text of a fixture. */
function fixtureContent(name: string): string {
  return (JSON.parse(fixture(name)) as { content: string }).content
}

/** Fixture ids end with a two-digit number. */
function id(n: number): string {
  return `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`
}

/** An envelope the way the MCP tools return it. */
function envelope(content: string): string {
  return JSON.stringify({ content, status: "succeeded" })
}

/** Separators that a regex `.` does not match: they must stay inside titles and content. */
const LINE_SEPARATOR = String.fromCharCode(0x2028)
const PARAGRAPH_SEPARATOR = String.fromCharCode(0x2029)

describe("parseListCards", () => {
  it("parses the cards of a list_cards page", () => {
    const cards = parseListCards(fixture("list_cards.txt"))
    expect(cards).toHaveLength(3)
    expect(cards[0]).toEqual({
      id: id(6),
      title: "Card N-00｜Map：entry",
      type: "card",
      whiteboards: [{ id: id(1), title: "Board A2" }],
      tags: ["wiki-test"],
      createdAt: "2026-09-28T17:39:37.772Z",
      updatedAt: "2026-10-04T07:28:31.245Z",
    })
    expect(cards[2].tags).toEqual(["wiki-test", "ingest-test"])
    expect(cards[2].updatedAt).toBe("2026-10-04T07:28:41.259Z")
  })

  it("parses titles with quotes and brackets", () => {
    const cards = parseListCards(fixture("list_cards.txt"))
    expect(cards[1].id).toBe(id(7))
    expect(cards[1].title).toBe('Card N-01｜Topic：from "a" to [b] end')
    expect(cards[2].title).toBe("Card N-02｜Terms, one | two")
  })

  it("keeps several whiteboards in order and reads tags: none as no tags", () => {
    const cards = parseListCards(fixture("list_cards_two_boards.txt"))
    expect(cards.map((card) => card.id)).toEqual([id(9), id(10)])
    expect(cards[0].title).toBe("Topic one")
    expect(cards[0].whiteboards).toEqual([
      { id: id(2), title: "Board B2" },
      { id: id(1), title: "Board A2" },
    ])
    expect(cards[0].tags).toEqual([])
    expect(cards[1].createdAt).toBe("2023-09-14T15:02:54.883Z")
  })

  it("returns an empty list for No cards found.", () => {
    expect(parseListCards(fixture("list_cards_empty.txt"))).toEqual([])
    expect(parseListCards("No cards found.")).toEqual([])
    expect(parseListCards("")).toEqual([])
  })

  it("ignores the header, blank lines, and the paging trailer", () => {
    const text = [
      "Cards:",
      `card "A" [${id(1)}] whiteboards: none, tags: none, created: 2026-01-01T00:00:00.000Z; updated: 2026-01-02T00:00:00.000Z`,
      "",
      "More cards are available. Showing 1-1 of 9. Call list_cards with offset 1 to list the next page.",
    ].join("\n")
    const cards = parseListCards(text)
    expect(cards).toHaveLength(1)
    expect(cards[0]).toEqual({
      id: id(1),
      title: "A",
      type: "card",
      whiteboards: [],
      tags: [],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-02T00:00:00.000Z",
    })
  })

  it("accepts the JSON envelope and the raw text alike", () => {
    const raw = fixtureContent("list_cards.txt")
    expect(parseListCards(envelope(raw))).toEqual(parseListCards(raw))
    expect(parseListCards(fixture("list_cards.txt"))).toEqual(parseListCards(raw))
  })

  it("keeps U+2028, U+2029, and a lone carriage return inside titles", () => {
    const title = `One${LINE_SEPARATOR}two${PARAGRAPH_SEPARATOR}three\rfour`
    const board = `Board${LINE_SEPARATOR}x`
    const text = `card "${title}" [${id(1)}] whiteboards: ${board} [${id(2)}], tags: t${PARAGRAPH_SEPARATOR}u [${id(3)}], created: 2026-01-01T00:00:00.000Z; updated: 2026-01-02T00:00:00.000Z`
    expect(parseListCards(text)).toEqual([
      {
        id: id(1),
        title,
        type: "card",
        whiteboards: [{ id: id(2), title: board }],
        tags: [`t${PARAGRAPH_SEPARATOR}u`],
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-02T00:00:00.000Z",
      },
    ])
  })

  it("splits lines on a line feed, with or without a carriage return before it", () => {
    const text = `Cards:\r\ncard "A" [${id(1)}]\r\ncard "B" [${id(2)}]\n`
    expect(parseListCards(text).map((card) => card.title)).toEqual(["A", "B"])
  })

  it("ignores a byte order mark before the envelope", () => {
    const bom = String.fromCharCode(0xfeff)
    expect(parseListCards(bom + fixture("list_cards.txt"))).toEqual(parseListCards(fixture("list_cards.txt")))
  })

  it("splits whiteboards on the ids, not on commas", () => {
    const text = `card "T" [${id(1)}] whiteboards: Plan, phase 2 [${id(2)}], Notes [${id(3)}], tags: a, b [${id(4)}], created: 2026-01-01T00:00:00.000Z; updated: 2026-01-01T00:00:00.000Z`
    const [card] = parseListCards(text)
    expect(card.whiteboards).toEqual([
      { id: id(2), title: "Plan, phase 2" },
      { id: id(3), title: "Notes" },
    ])
    expect(card.tags).toEqual(["a, b"])
  })

  it("accepts a line without whiteboards, tags, or timestamps", () => {
    const [card] = parseListCards(`card "Bare" [${id(5)}]`)
    expect(card).toEqual({ id: id(5), title: "Bare", type: "card", whiteboards: [], tags: [] })
    expect("createdAt" in card).toBe(false)
  })
})

describe("parseListWhiteboards", () => {
  it("builds parents from indentation", () => {
    const nodes = parseListWhiteboards(fixture("list_whiteboards.txt"))
    expect(nodes).toHaveLength(9)
    const parentOf = Object.fromEntries(nodes.map((node) => [node.title, node.parentId]))
    expect(parentOf["Root A"]).toBeNull()
    expect(parentOf["Board A1"]).toBe(id(12))
    expect(parentOf["Board A2"]).toBe(id(3))
    expect(parentOf["Board A3"]).toBe(id(3))
    expect(parentOf["Root B"]).toBeNull()
    expect(parentOf["Board B1"]).toBe(id(13))
    expect(parentOf["Board B2"]).toBe(id(15))
    expect(nodes[0]).toEqual({ id: id(11), title: "Archive／Root", parentId: null })
  })

  it("keeps quotes and brackets in titles and ignores the trailer", () => {
    const nodes = parseListWhiteboards(fixture("list_whiteboards.txt"))
    const last = nodes[nodes.length - 1]
    expect(last.id).toBe(id(16))
    expect(last.title).toBe('Board "B3" [draft]')
    expect(last.parentId).toBe(id(15))
  })

  it("accepts the JSON envelope and the raw text alike", () => {
    const raw = fixtureContent("list_whiteboards.txt")
    expect(parseListWhiteboards(envelope(raw))).toEqual(parseListWhiteboards(raw))
  })

  it("returns an empty list when there are no whiteboards", () => {
    expect(parseListWhiteboards("")).toEqual([])
    expect(parseListWhiteboards("Whiteboards:\n")).toEqual([])
  })

  it("keeps U+2028 inside a title", () => {
    const title = `Board${LINE_SEPARATOR}one`
    expect(parseListWhiteboards(`whiteboard "${title}" [${id(1)}] 0 cards`)).toEqual([{ id: id(1), title, parentId: null }])
  })

  it("starts a new root after a deep branch", () => {
    const text = [
      `whiteboard "A" [${id(1)}] 0 cards`,
      `  whiteboard "B" [${id(2)}] 0 cards`,
      `    whiteboard "C" [${id(3)}] 0 cards`,
      `whiteboard "D" [${id(4)}] 0 cards`,
      `  whiteboard "E" [${id(5)}] 0 cards`,
    ].join("\n")
    expect(parseListWhiteboards(text).map((node) => node.parentId)).toEqual([null, id(1), id(2), null, id(4)])
  })
})

describe("parseWhiteboardStructure", () => {
  it("reads the whiteboard, its sections, and their cards", () => {
    const structure = parseWhiteboardStructure(fixture("read_whiteboard_structure.txt"))
    expect(structure.id).toBe(id(1))
    expect(structure.title).toBe("Board A2")
    expect(structure.sections.map((section) => section.title)).toEqual([
      "Section One",
      "Section Two",
      "Section Three",
      "Section Four",
    ])
    expect(structure.sections[0]).toEqual({
      id: id(17),
      title: "Section One",
      cards: [
        { id: id(6), title: "Card N-00｜Map：entry", type: "card" },
        { id: id(7), title: 'Card N-01｜Topic：from "a" to [b] end', type: "card" },
      ],
    })
    expect(structure.sections[1].cards.map((card) => card.id)).toEqual([id(21), id(22)])
    expect(structure.unsectioned).toEqual([])
  })

  it("accepts a section without a color word", () => {
    const structure = parseWhiteboardStructure(fixture("read_whiteboard_structure.txt"))
    const readingList = structure.sections.find((section) => section.title === "Section Three")
    expect(readingList?.id).toBe(id(19))
    expect(readingList?.cards).toEqual([{ id: id(23), title: "Card N-40｜List：80 items", type: "card" }])
  })

  it("structure includes mind map ids", () => {
    const structure = parseWhiteboardStructure(fixture("read_whiteboard_structure.txt"))
    expect(structure.mindMapIds).toEqual([id(20)])
    // The mind map is not a card, and the cards inside it are not listed here.
    expect(structure.sections[3]).toEqual({ id: id(26), title: "Section Four", cards: [] })
  })

  it("accepts the JSON envelope and the raw text alike", () => {
    const raw = fixtureContent("read_whiteboard_structure.txt")
    expect(parseWhiteboardStructure(envelope(raw))).toEqual(parseWhiteboardStructure(raw))
  })

  it("collects cards that are not in a section", () => {
    const text = [
      `whiteboard "Board" [${id(1)}] Parent: none`,
      "cards: 3 (card: 3); other objects: 1 (section: 1)",
      "",
      `section "S" [${id(2)}] red`,
      `  card "In section" [${id(3)}]`,
      "(unsectioned)",
      `  card "Loose one" [${id(4)}]`,
      `  card "Loose two" [${id(5)}]`,
      `  mindMap "Map" [${id(6)}] 2 nodes`,
    ].join("\n")
    const structure = parseWhiteboardStructure(text)
    expect(structure.sections).toEqual([
      { id: id(2), title: "S", cards: [{ id: id(3), title: "In section", type: "card" }] },
    ])
    expect(structure.unsectioned).toEqual([
      { id: id(4), title: "Loose one", type: "card" },
      { id: id(5), title: "Loose two", type: "card" },
    ])
    expect(structure.mindMapIds).toEqual([id(6)])
  })

  it("puts an unindented card after the sections in unsectioned", () => {
    const text = [
      `whiteboard "Board" [${id(1)}]`,
      "",
      `section "S" [${id(2)}]`,
      `  card "In section" [${id(3)}]`,
      `card "Loose" [${id(4)}]`,
    ].join("\n")
    const structure = parseWhiteboardStructure(text)
    expect(structure.sections[0].cards.map((card) => card.id)).toEqual([id(3)])
    expect(structure.unsectioned.map((card) => card.id)).toEqual([id(4)])
  })

  it("skips a nested whiteboard line, in a section or loose", () => {
    const text = [
      `whiteboard "Board" [${id(1)}]`,
      `section "S" [${id(2)}]`,
      `  card "C" [${id(3)}]`,
      `  whiteboard "Nested" [${id(4)}] 2 cards`,
      "(unsectioned)",
      `  whiteboard "Nested loose" [${id(5)}] 1 card`,
    ].join("\n")
    const structure = parseWhiteboardStructure(text)
    expect(structure.id).toBe(id(1))
    expect(structure.title).toBe("Board")
    expect(structure.sections[0].cards).toEqual([{ id: id(3), title: "C", type: "card" }])
    expect(structure.unsectioned).toEqual([])
  })

  it("does not take a nested whiteboard line for the header", () => {
    const text = [`section "S" [${id(2)}]`, `  card "C" [${id(3)}]`, `  whiteboard "Nested" [${id(4)}]`].join("\n")
    expect(() => parseWhiteboardStructure(text)).toThrow(/whiteboard/)
  })

  it("keeps U+2028 inside titles", () => {
    const title = `Card${LINE_SEPARATOR}one`
    const text = [`whiteboard "B${PARAGRAPH_SEPARATOR}" [${id(1)}]`, `section "S" [${id(2)}]`, `  card "${title}" [${id(3)}]`].join("\n")
    const structure = parseWhiteboardStructure(text)
    expect(structure.title).toBe(`B${PARAGRAPH_SEPARATOR}`)
    expect(structure.sections[0].cards[0].title).toBe(title)
  })

  it("throws when the text has no whiteboard line", () => {
    expect(() => parseWhiteboardStructure("No whiteboard here.")).toThrow(/whiteboard/)
  })
})

describe("parseMindMap", () => {
  it("lists the card nodes in order", () => {
    const nodes = parseMindMap(fixture("read_object_mindmap.txt"))
    expect(nodes).toEqual([
      { id: id(9), title: "Topic one" },
      { id: id(10), title: "Node 1.1" },
      { id: id(34), title: "Node 1.1.1" },
      { id: id(35), title: "Node 1.2" },
      { id: id(36), title: "Node 1.2.1" },
      { id: id(37), title: "Node 1.3" },
      { id: id(38), title: "Node 1.3.1" },
    ])
  })

  it("uses the card id, not the node id", () => {
    const text = `1\tcard "Only" cardId: [${id(1)}], nodeId: [${id(2)}]`
    expect(parseMindMap(text)).toEqual([{ id: id(1), title: "Only" }])
  })

  it("accepts the JSON envelope, the raw text, and joined pages", () => {
    const expected = parseMindMap(fixture("read_object_mindmap.txt"))
    expect(parseMindMap(fixtureContent("read_object_mindmap.txt"))).toEqual(expected)
    expect(parseMindMap(joinReadObjectPages([fixture("read_object_mindmap.txt")]))).toEqual(expected)
  })

  it("keeps quotes and brackets in titles", () => {
    const text = `1\t  card "Say "hi" [now]" cardId: [${id(1)}], nodeId: [${id(2)}]`
    expect(parseMindMap(text)).toEqual([{ id: id(1), title: 'Say "hi" [now]' }])
  })

  it("keeps U+2028 inside a title", () => {
    const title = `Node${LINE_SEPARATOR}one`
    expect(parseMindMap(`1\tcard "${title}" cardId: [${id(1)}], nodeId: [${id(2)}]`)).toEqual([{ id: id(1), title }])
  })

  it("returns an empty list for a mind map without card nodes", () => {
    expect(parseMindMap(`mindMap "Empty" [${id(1)}] 0 nodes`)).toEqual([])
  })
})

describe("joinReadObjectPages", () => {
  /** A read_object page the way the tool returns it: header, optional databases, numbered lines. */
  function page(from: number, to: number, withDatabases: boolean): string {
    const lines = [`card "Long card" [${id(1)}] 80 lines`]
    if (withDatabases) lines.push("--- Databases ---", `- tag "wiki-test" [${id(4)}]`)
    for (let n = from; n <= to; n += 1) lines.push(`${n}\tline ${n}`)
    return lines.join("\n")
  }

  it("joins paged read_object output", () => {
    const joined = joinReadObjectPages([page(1, 40, true), page(41, 80, false)])
    const expected = Array.from({ length: 80 }, (_, index) => `line ${index + 1}`).join("\n")
    expect(joined).toBe(expected)
  })

  it("drops the header line and the databases block", () => {
    const joined = joinReadObjectPages([page(1, 3, true)])
    expect(joined).toBe("line 1\nline 2\nline 3")
    expect(joined).not.toContain("Databases")
    expect(joined).not.toContain("wiki-test")
    expect(joined).not.toContain("Long card")
  })

  it("keeps tab characters inside content after the prefix", () => {
    const joined = joinReadObjectPages([`card "T" [${id(1)}] 3 lines\n1\tcol a\tcol b\n2\t\n3\t7\tnot a prefix`])
    expect(joined).toBe("col a\tcol b\n\n7\tnot a prefix")
  })

  it("joins the fixture pages, keeping a tab inside a table row and the empty lines", () => {
    const joined = joinReadObjectPages([fixture("read_object_page1.txt"), fixture("read_object_page2.txt")])
    const lines = joined.split("\n")
    expect(lines[0]).toBe('# Card N-02｜Terms, one | two')
    expect(lines[1]).toBe("")
    expect(lines).toContain("| Alpha | First item\tthat can be tabbed |")
    expect(lines[lines.length - 1]).toBe('<hepta-placeholder id="00000000-0000-4000-8000-000000000040" kind="complexTable" />')
    expect(joined).not.toContain("--- Databases ---")
    expect(joined).not.toMatch(/^\d+\t/m)
    expect(joined).not.toContain("40 lines")
  })

  it("accepts raw text and JSON envelopes", () => {
    const raw1 = fixtureContent("read_object_page1.txt")
    const raw2 = fixtureContent("read_object_page2.txt")
    const fromEnvelopes = joinReadObjectPages([fixture("read_object_page1.txt"), fixture("read_object_page2.txt")])
    expect(joinReadObjectPages([raw1, raw2])).toBe(fromEnvelopes)
    expect(joinReadObjectPages([raw1, fixture("read_object_page2.txt")])).toBe(fromEnvelopes)
  })

  it("orders by line number whatever the page order", () => {
    expect(joinReadObjectPages([page(4, 6, false), page(1, 3, true)])).toBe(
      "line 1\nline 2\nline 3\nline 4\nline 5\nline 6",
    )
  })

  it("de-duplicates overlapping line numbers, later page wins", () => {
    const first = `card "T" [${id(1)}] 5 lines\n1\ta\n2\tb\n3\told`
    const second = `card "T" [${id(1)}] 5 lines\n3\tnew\n4\td\n5\te`
    expect(joinReadObjectPages([first, second])).toBe("a\nb\nnew\nd\ne")
  })

  it("keeps content lines that hold U+2028, U+2029, or a lone carriage return", () => {
    const content = [
      `1\tfirst`,
      `2\tsep${LINE_SEPARATOR}arator`,
      `3\tcarriage\rreturn`,
      `4\tpara${PARAGRAPH_SEPARATOR}graph`,
      `5\tlast\r`,
    ].join("\n")
    expect(joinReadObjectPages([`card "T" [${id(1)}] 5 lines\n${content}`])).toBe(
      `first\nsep${LINE_SEPARATOR}arator\ncarriage\rreturn\npara${PARAGRAPH_SEPARATOR}graph\nlast\r`,
    )
  })

  it("treats a carriage return before a line feed as part of the line break", () => {
    expect(joinReadObjectPages([`card "T" [${id(1)}] 2 lines\r\n1\ta\r\n2\tb`])).toBe("a\nb")
  })

  it("returns an empty string when there are no numbered lines", () => {
    expect(joinReadObjectPages([])).toBe("")
    expect(joinReadObjectPages([`card "T" [${id(1)}] 0 lines`])).toBe("")
  })
})

describe("parsePagingTrailer", () => {
  it("reads the list_cards trailer", () => {
    expect(parsePagingTrailer(fixture("list_cards.txt"))).toEqual({ shown: [1, 3], total: 40, nextOffset: 3 })
  })

  it("reads the list_whiteboards trailer", () => {
    expect(parsePagingTrailer(fixture("list_whiteboards.txt"))).toEqual({ shown: [1, 3], total: 8, nextOffset: 3 })
  })

  it("reads a trailer from raw text", () => {
    const raw = "Cards:\ncard \"A\" [x]\n\nMore cards are available. Showing 4-6 of 40. Call list_cards with offset 6 to list the next page."
    expect(parsePagingTrailer(raw)).toEqual({ shown: [4, 6], total: 40, nextOffset: 6 })
  })

  it("returns null when the result is not paged", () => {
    expect(parsePagingTrailer(fixture("list_cards_two_boards.txt"))).toBeNull()
    expect(parsePagingTrailer(fixture("list_cards_empty.txt"))).toBeNull()
    expect(parsePagingTrailer("")).toBeNull()
  })

  it("does not read a card title that looks like a trailer", () => {
    const text = `Cards:\ncard "More cards are available. Showing 1-3 of 9. Call list_cards with offset 3 to list the next page." [${id(1)}]`
    expect(parsePagingTrailer(text)).toBeNull()
  })
})
