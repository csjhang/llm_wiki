/**
 * Parsers for the text the Heptabase MCP tools return.
 *
 * Every function is pure: it takes the text of one tool result and returns data.
 * A tool result is either the raw text or the JSON envelope
 * `{"content": "<text>", "status": "succeeded", ...}`; each parser accepts both.
 *
 * Object lines look like `<keyword> "<title>" [<uuid>] ...`. A title may hold
 * quotes and brackets, so the title is the text between the first quote after the
 * keyword and the last `" [` before the id. The id is a UUID, which is what tells
 * the id apart from a title that ends in `[draft]`. Heptabase may write a quote
 * inside a title as `\"`; titles come back with a plain quote.
 */

const UUID = "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}"

/**
 * `<indent><keyword> "<title>" [<uuid>]<rest>` - the lazy title ends at the first `" [<uuid>]`.
 * A line is text up to a line feed, so the captures are `[^\n]`, not `.`: a dot does not match
 * U+2028, U+2029, or a carriage return, and a line with one of them would be skipped.
 */
const OBJECT_LINE = new RegExp(`^(\\s*)([A-Za-z][A-Za-z0-9_]*) "([^\\n]*?)" \\[(${UUID})\\]([^\\n]*)$`)

/** One `<title> [<uuid>]` item of a comma-separated list. A title may hold commas. */
const LISTED_ITEM = new RegExp(`(?:^|, )([^\\n]+?) \\[(${UUID})\\](?=, |$)`, "g")

/** A mind map node: `<n>\t<indent>card "<title>" cardId: [<uuid>], nodeId: [<uuid>]`. */
const MIND_MAP_CARD = new RegExp(`^(?:\\d+\\t)?\\s*card "([^\\n]*?)" cardId: \\[(${UUID})\\]`)

/** A numbered line of read_object content: `<n>\t<text>`. */
const NUMBERED_LINE = /^(\d+)\t([^\n]*)$/

/** The line a paged list ends with. */
const PAGING_TRAILER = /^More [^\n]*? are available\. Showing (\d+)-(\d+) of (\d+)\.[^\n]*?\boffset (\d+)\b/

export interface CardRef {
  id: string
  title: string
  type: string
  whiteboards: { id: string; title: string }[]
  tags: string[]
  createdAt?: string
  updatedAt?: string
}

type CardDetails = Pick<CardRef, "whiteboards" | "tags" | "createdAt" | "updatedAt">

export interface WhiteboardNode {
  id: string
  title: string
  parentId: string | null
}

export interface WhiteboardStructure {
  id: string
  title: string
  sections: { id: string; title: string; cards: { id: string; title: string; type: string }[] }[]
  unsectioned: { id: string; title: string; type: string }[]
  mindMapIds: string[]
}

export interface PagingTrailer {
  /** First and last item number of this page, counting from 1. */
  shown: [number, number]
  total: number
  /** The `offset` argument that lists the next page. */
  nextOffset: number
}

/** The `content` text of a JSON envelope, or the text itself when it is not one. */
function unwrap(text: string): string {
  const body = text.replace(/^\uFEFF/, "")
  if (!body.trimStart().startsWith("{")) return body
  try {
    const parsed: unknown = JSON.parse(body)
    if (parsed !== null && typeof parsed === "object" && typeof (parsed as { content?: unknown }).content === "string") {
      return (parsed as { content: string }).content
    }
  } catch {
    // Not JSON: the text is raw tool output.
  }
  return body
}

/** Lines end at a line feed, or at a carriage return plus line feed. A lone carriage return stays in its line. */
function linesOf(text: string): string[] {
  return unwrap(text).split(/\r?\n/)
}

function unescapeTitle(title: string): string {
  return title.replace(/\\"/g, '"')
}

interface ObjectLine {
  /** Width of the leading whitespace, a tab counting as two spaces. */
  indent: number
  keyword: string
  title: string
  id: string
  /** What follows the id on the line. */
  rest: string
}

function parseObjectLine(line: string): ObjectLine | null {
  const match = OBJECT_LINE.exec(line)
  if (!match) return null
  return {
    indent: match[1].replace(/\t/g, "  ").length,
    keyword: match[2],
    title: unescapeTitle(match[3]),
    id: match[4],
    rest: match[5],
  }
}

/** The `<title> [<uuid>]` items of a comma-separated list. `none` has no item. */
function parseListedItems(segment: string): { id: string; title: string }[] {
  return Array.from(segment.matchAll(LISTED_ITEM), (match) => ({ id: match[2], title: unescapeTitle(match[1]) }))
}

/**
 * Read the part of a list_cards line after the card's id:
 * `whiteboards: <items>, tags: <items|none>, created: <iso>; updated: <iso>`.
 * Each part is optional, because it depends on the `include` option of the call.
 */
function parseCardDetails(rest: string): CardDetails {
  let body = rest.trim()
  let updatedAt: string | undefined
  let createdAt: string | undefined

  const updated = /(?:^|[,;] )updated: (\S+)$/.exec(body)
  if (updated) {
    updatedAt = updated[1]
    body = body.slice(0, updated.index)
  }
  const created = /(?:^|[,;] )created: (\S+?);?$/.exec(body)
  if (created) {
    createdAt = created[1]
    body = body.slice(0, created.index)
  }

  const tagsLabel = /(?:^|, )tags: /.exec(body)
  const whiteboardsPart = (tagsLabel ? body.slice(0, tagsLabel.index) : body).replace(/^whiteboards: /, "")
  const tagsPart = tagsLabel ? body.slice(tagsLabel.index + tagsLabel[0].length) : ""

  const details: CardDetails = {
    whiteboards: parseListedItems(whiteboardsPart),
    tags: parseListedItems(tagsPart).map((tag) => tag.title),
  }
  if (createdAt !== undefined) details.createdAt = createdAt
  if (updatedAt !== undefined) details.updatedAt = updatedAt
  return details
}

/** Cards of a list_cards result. The header, blank lines, and paging trailer are skipped. */
export function parseListCards(text: string): CardRef[] {
  const cards: CardRef[] = []
  for (const line of linesOf(text)) {
    const item = parseObjectLine(line)
    if (!item) continue
    cards.push({ id: item.id, title: item.title, type: item.keyword, ...parseCardDetails(item.rest) })
  }
  return cards
}

/**
 * Whiteboards of a list_whiteboards result. Each level is indented two spaces more
 * than its parent, so a whiteboard's parent is the closest earlier whiteboard with
 * one level less. A top-level whiteboard has `parentId: null`.
 */
export function parseListWhiteboards(text: string): WhiteboardNode[] {
  const nodes: WhiteboardNode[] = []
  const ancestors: WhiteboardNode[] = []
  for (const line of linesOf(text)) {
    const item = parseObjectLine(line)
    if (!item || item.keyword !== "whiteboard") continue
    ancestors.length = Math.min(Math.floor(item.indent / 2), ancestors.length)
    const node: WhiteboardNode = { id: item.id, title: item.title, parentId: ancestors[ancestors.length - 1]?.id ?? null }
    nodes.push(node)
    ancestors.push(node)
  }
  return nodes
}

/**
 * The structure of a whiteboard from read_whiteboard: the header line, then
 * sections with their indented cards, then mind maps. A card line takes its
 * keyword as `type`. Cards after an `(unsectioned)` line, or not indented, are
 * unsectioned. Nested whiteboard lines are skipped. Cards inside a mind map are
 * not listed here; see parseMindMap.
 */
export function parseWhiteboardStructure(text: string): WhiteboardStructure {
  let header: ObjectLine | null = null
  const sections: WhiteboardStructure["sections"] = []
  const unsectioned: WhiteboardStructure["unsectioned"] = []
  const mindMapIds: string[] = []
  let current: WhiteboardStructure["sections"][number] | null = null
  let seenObject = false

  for (const line of linesOf(text)) {
    if (line.trim().startsWith("(unsectioned)")) {
      current = null
      continue
    }
    const item = parseObjectLine(line)
    if (!item) continue
    const isFirstObject = !seenObject
    seenObject = true
    if (item.keyword === "whiteboard") {
      // Only the first object line is the header. A later whiteboard line is a nested whiteboard.
      if (isFirstObject) header = item
    } else if (item.keyword === "section") {
      current = { id: item.id, title: item.title, cards: [] }
      sections.push(current)
    } else if (item.keyword === "mindMap") {
      mindMapIds.push(item.id)
    } else {
      const card = { id: item.id, title: item.title, type: item.keyword }
      if (current && item.indent > 0) current.cards.push(card)
      else unsectioned.push(card)
    }
  }

  if (!header) throw new Error("not a whiteboard structure: no whiteboard line found")
  return { id: header.id, title: header.title, sections, unsectioned, mindMapIds }
}

/** The card nodes of a mind map object, in order. `id` is the card id, not the node id. */
export function parseMindMap(text: string): { id: string; title: string }[] {
  const cards: { id: string; title: string }[] = []
  for (const line of linesOf(text)) {
    const match = MIND_MAP_CARD.exec(line)
    if (match) cards.push({ id: match[2], title: unescapeTitle(match[1]) })
  }
  return cards
}

/**
 * Join the pages of a paged read_object result into the object's own text.
 * Each page has a header line, on page 1 a `--- Databases ---` block, and content
 * lines `<n>\t<text>` with absolute line numbers. Only the numbered lines are kept,
 * ordered by number; when pages overlap, the later page wins. Only the first
 * `<n>\t` is removed, so tabs inside the text stay. A missing number is not
 * reported: compare the line count with the `totalLines` of the result.
 */
export function joinReadObjectPages(pages: string[]): string {
  const byNumber = new Map<number, string>()
  for (const page of pages) {
    for (const line of linesOf(page)) {
      const match = NUMBERED_LINE.exec(line)
      if (match) byNumber.set(Number(match[1]), match[2])
    }
  }
  return Array.from(byNumber.keys())
    .sort((a, b) => a - b)
    .map((number) => byNumber.get(number) as string)
    .join("\n")
}

/**
 * The paging trailer of a list result, such as
 * `More cards are available. Showing 1-3 of 40. Call list_cards with offset 3 to list the next page.`
 * Returns null when the result is not paged or the page is the last one.
 */
export function parsePagingTrailer(text: string): PagingTrailer | null {
  const lines = linesOf(text)
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const match = PAGING_TRAILER.exec(lines[index])
    if (match) {
      return { shown: [Number(match[1]), Number(match[2])], total: Number(match[3]), nextOffset: Number(match[4]) }
    }
  }
  return null
}
