/**
 * The in-place edit of the domain keys in the frontmatter of a page.
 *
 * A recut changes `domain`, `from_domain`, `to_domain`, and the items of `also`. Every other byte of the page
 * must stay, so this module edits text and never writes the YAML again: it finds the lines of the named keys at the
 * top level of the frontmatter and replaces the text of the values on those lines. It keeps the quote style of each
 * value, a trailing comment, the spacing, the line breaks (also a CRLF page), and a byte order mark. An `also` list may
 * be a flow list (`[a, b]`, also over several lines), a block list (`- a`), or one plain value; it keeps its form.
 *
 * A form that this module cannot edit safely (a block scalar, a nested value, a value over several lines) is a
 * `{ ok: false, reason }` result and the page is not changed. After every edit the result is read back with the
 * frontmatter parser of the app: the named keys must hold the new values and every other key must be unchanged.
 */
import yaml from "js-yaml"
import { type FrontmatterValue, parseFrontmatter } from "@/lib/frontmatter"
import { yamlString } from "../cmd-snapshot"

export type SingleDomainKey = "domain" | "from_domain" | "to_domain"

/** What to do with one item of the `also` list. */
export interface AlsoItemEdit {
  /** The new value of the item (the old value when it stays). */
  value: string
  /** The item now repeats another entry. It is removed when the form of the list allows that. */
  redundant: boolean
}

export interface DomainKeyRewrite {
  /** The single-value keys to edit. A key that is not listed is not touched. */
  singleKeys: readonly SingleDomainKey[]
  /** The new value for the value `old` of a key, as written in the page. Return `old` to leave it. */
  value(key: SingleDomainKey, old: string): string
  /** The edit of every item of `also`, in order. Called only for a page that has the key with items. Left out: `also` is not edited. */
  also?(old: string[]): AlsoItemEdit[]
}

export type DomainKeyEdit = { ok: true; text: string; changed: boolean } | { ok: false; reason: string }

interface Line {
  /** The text of the line without its line break. */
  content: string
  /** The line break: `\n`, `\r\n`, or "" for the last line of a text without one. */
  eol: string
  removed?: boolean
}

interface Token {
  /** Start and end of the value text in the string that was scanned. */
  start: number
  end: number
  /** The text of the value: unquoted and unescaped. */
  value: string
  quote: "" | "'" | '"'
}

class Unsupported extends Error {}

export function editDomainKeys(text: string, rewrite: DomainKeyRewrite): DomainKeyEdit {
  const bom = text.startsWith("\uFEFF") ? "\uFEFF" : ""
  const body = text.slice(bom.length)
  const parsed = parseFrontmatter(body)
  if (parsed.frontmatter === null || parsed.rawBlock === "") return { ok: true, changed: false, text }
  const at = body.indexOf(parsed.rawBlock)
  if (at === -1) return { ok: false, reason: "the frontmatter block cannot be located" }

  const lines = splitLines(parsed.rawBlock)
  const close = lines.findIndex((line, index) => index > 0 && /^---[ \t]*$/.test(line.content))
  if (close === -1) return { ok: false, reason: "the frontmatter has no closing line" }

  const expected = new Map<string, string[] | string>()
  try {
    for (let index = 1; index < close; index += 1) {
      const key = keyOfLine(lines[index].content)
      if (key === null) continue
      const isSingle = (rewrite.singleKeys as readonly string[]).includes(key.name)
      if (!isSingle && !(key.name === "also" && rewrite.also !== undefined)) continue
      let end = entryEnd(lines, index, close)
      if (isSingle) {
        const done = editSingle(lines, index, end, key, rewrite)
        if (done !== null) expected.set(key.name, done)
      } else {
        const done = editAlso(lines, index, end, close, key, rewrite.also as NonNullable<DomainKeyRewrite["also"]>)
        if (done.list !== null) expected.set("also", done.list)
        end = done.end
      }
      index = end - 1
    }
  } catch (error) {
    if (error instanceof Unsupported) return { ok: false, reason: error.message }
    throw error
  }

  const block = lines.filter((line) => line.removed !== true).map((line) => line.content + line.eol).join("")
  const result = bom + body.slice(0, at) + block + body.slice(at + parsed.rawBlock.length)
  if (result === text) return { ok: true, changed: false, text }

  const problem = readBackProblem(parsed.frontmatter, parseFrontmatter(result.slice(bom.length)).frontmatter, expected)
  return problem === null ? { ok: true, changed: true, text: result } : { ok: false, reason: problem }
}

// --- lines ---------------------------------------------------------------

function splitLines(text: string): Line[] {
  return (text.match(/[^\n]*\n|[^\n]+/g) ?? []).map((raw) => {
    const content = raw.replace(/\r?\n?$/, "")
    return { content, eol: raw.slice(content.length) }
  })
}

const KEY_LINE = /^(?:"([^"\\]*)"|'([^']*)'|([A-Za-z_][\w.-]*))[ \t]*:/

interface KeyLine {
  name: string
  /** The text of the line up to and including the colon. */
  head: string
  /** The text after the colon. */
  rest: string
}

/** The key of a line at the top level of the frontmatter, or null. */
function keyOfLine(content: string): KeyLine | null {
  const match = KEY_LINE.exec(content)
  if (match === null) return null
  const rest = content.slice(match[0].length)
  // `domain:foo` is one plain scalar, not a key with a value.
  if (rest !== "" && !/^[ \t]/.test(rest)) return null
  return { name: match[1] ?? match[2] ?? match[3], head: match[0], rest }
}

/** The line after the entry of the key at `index`: its continuation lines are blank, indented, or a block item. */
function entryEnd(lines: readonly Line[], index: number, close: number): number {
  let end = index + 1
  while (end < close && /^(?:\s*$|[ \t]|-(?:[ \t]|$))/.test(lines[end].content)) end += 1
  return end
}

function isBlankOrComment(content: string): boolean {
  const trimmed = content.trim()
  return trimmed === "" || trimmed.startsWith("#")
}

// --- tokens --------------------------------------------------------------

/** The value token at `from` in `text`. Null when there is none, or when it is not a plain or quoted scalar. */
function readToken(text: string, from: number, inFlow: boolean): Token | null {
  const first = text[from]
  if (first === undefined) return null
  if (first === '"') {
    let end = from + 1
    while (end < text.length && text[end] !== '"') end += text[end] === "\\" ? 2 : 1
    if (end >= text.length) return null
    const raw = text.slice(from, end + 1)
    let value: unknown
    try {
      value = yaml.load(raw, { schema: yaml.JSON_SCHEMA })
    } catch {
      return null
    }
    return typeof value === "string" ? { start: from, end: end + 1, value, quote: '"' } : null
  }
  if (first === "'") {
    let end = from + 1
    while (end < text.length) {
      if (text[end] === "'") {
        if (text[end + 1] !== "'") break
        end += 2
      } else {
        end += 1
      }
    }
    if (end >= text.length) return null
    return { start: from, end: end + 1, value: text.slice(from + 1, end).replace(/''/g, "'"), quote: "'" }
  }
  if ("[]{},#&*!|>%@`".includes(first) || (/[-?:]/.test(first) && /^\s|^$/.test(text.slice(from + 1, from + 2)))) return null
  const stop = inFlow ? /[,\]\[{}\n]|[ \t]#/ : /\n|[ \t]#/
  const hit = stop.exec(text.slice(from))
  const raw = hit === null ? text.slice(from) : text.slice(from, from + hit.index)
  const value = raw.replace(/\s+$/, "")
  return value === "" ? null : { start: from, end: from + value.length, value, quote: "" }
}

/** The text of a value in the quote style of the value it replaces. */
function renderToken(quote: Token["quote"], value: string): string {
  if (quote === "'") return `'${value.replace(/'/g, "''")}'`
  if (quote === "") {
    let plain = false
    try {
      plain = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(value) && yaml.load(value, { schema: yaml.JSON_SCHEMA }) === value
    } catch {
      plain = false
    }
    if (plain) return value
  }
  return yamlString(value)
}

// --- single values -------------------------------------------------------

/** Edit the value of a single-value key. Returns the new value, or null when the key was left as it is. */
function editSingle(lines: Line[], index: number, end: number, key: KeyLine, rewrite: DomainKeyRewrite): string | null {
  const name = key.name as SingleDomainKey
  const unsupported = (why: string): Unsupported => new Unsupported(`${name} ${why}`)
  for (let next = index + 1; next < end; next += 1) {
    if (!isBlankOrComment(lines[next].content)) throw unsupported("is not a value on one line")
  }
  const lead = /^[ \t]*/.exec(key.rest)?.[0].length ?? 0
  // A key with no value at all has nothing to change.
  if (/^[ \t]*(?:#.*)?$/.test(key.rest)) return null
  const token = readToken(key.rest, lead, false)
  if (token === null) throw unsupported("is not a plain or quoted value on its line")
  if (!/^[ \t]*(?:#.*)?$/.test(key.rest.slice(token.end))) throw unsupported("is not a value on one line")

  const next = rewrite.value(name, token.value)
  if (next === token.value) return null
  const rest = key.rest.slice(0, token.start) + renderToken(token.quote, next) + key.rest.slice(token.end)
  lines[index].content = key.head + rest
  return next
}

// --- the also list -------------------------------------------------------

/**
 * Edit the items of `also`. `list` is the new list, or null when the key was left as it is. `end` is the line after the
 * lines that the entry used (a flow list may go on past the lines that look like its continuation).
 */
function editAlso(
  lines: Line[],
  index: number,
  end: number,
  close: number,
  key: KeyLine,
  alsoEdit: NonNullable<DomainKeyRewrite["also"]>,
): { list: string[] | null; end: number } {
  const lead = /^[ \t]*/.exec(key.rest)?.[0].length ?? 0
  const value = key.rest.slice(lead)
  if (value === "" || value.startsWith("#")) return { list: editBlockList(lines, index, end, key, alsoEdit), end }
  if (value.startsWith("[")) return editFlowList(lines, index, close, key, lead, alsoEdit)

  // One plain or quoted value: a list of one.
  const token = readToken(key.rest, lead, false)
  if (token === null || !/^[ \t]*(?:#.*)?$/.test(key.rest.slice(token.end))) throw new Unsupported("also is not a list this tool can edit")
  for (let next = index + 1; next < end; next += 1) {
    if (!isBlankOrComment(lines[next].content)) throw new Unsupported("also is not a list this tool can edit")
  }
  const [edit] = checkedEdits(alsoEdit, [token.value])
  if (edit.value === token.value && !edit.redundant) return { list: null, end }
  const text = edit.redundant ? "[]" : renderToken(token.quote, edit.value)
  lines[index].content = key.head + key.rest.slice(0, token.start) + text + key.rest.slice(token.end)
  return { list: edit.redundant ? [] : [edit.value], end }
}

function checkedEdits(alsoEdit: NonNullable<DomainKeyRewrite["also"]>, old: string[]): AlsoItemEdit[] {
  const edits = alsoEdit(old)
  if (edits.length !== old.length) throw new Error("the also rewrite must return one edit for each item")
  return edits
}

interface BlockItem {
  line: number
  token: Token
  /** The text of the line before the value token. */
  head: string
  tail: string
}

function editBlockList(lines: Line[], index: number, end: number, key: KeyLine, alsoEdit: NonNullable<DomainKeyRewrite["also"]>): string[] | null {
  const items: BlockItem[] = []
  for (let next = index + 1; next < end; next += 1) {
    const content = lines[next].content
    if (isBlankOrComment(content)) continue
    const match = /^([ \t]*-[ \t]+)(.*)$/.exec(content)
    const token = match === null ? null : readToken(match[2], 0, false)
    if (match === null || token === null || !/^[ \t]*(?:#.*)?$/.test(match[2].slice(token.end))) {
      throw new Unsupported("also is not a list this tool can edit")
    }
    items.push({ line: next, token, head: match[1], tail: match[2].slice(token.end) })
  }
  if (items.length === 0) return null

  const edits = checkedEdits(alsoEdit, items.map((item) => item.token.value))
  if (edits.every((edit, at) => edit.value === items[at].token.value && !edit.redundant)) return null
  const kept: string[] = []
  items.forEach((item, at) => {
    const edit = edits[at]
    if (edit.redundant) {
      lines[item.line].removed = true
      return
    }
    kept.push(edit.value)
    if (edit.value !== item.token.value) lines[item.line].content = item.head + renderToken(item.token.quote, edit.value) + item.tail
  })
  if (kept.length === 0) {
    const comment = /^[ \t]*(#.*)$/.exec(key.rest)?.[1]
    lines[index].content = `${key.head} []${comment === undefined ? "" : `  ${comment}`}`
  }
  return kept
}

function editFlowList(
  lines: Line[],
  index: number,
  close: number,
  key: KeyLine,
  lead: number,
  alsoEdit: NonNullable<DomainKeyRewrite["also"]>,
): { list: string[] | null; end: number } {
  // The list may go over several lines, and its closing bracket may stand in the first column.
  const open = key.head.length + lead
  let end = index + 1
  let chunk = joinLines(lines, index, end)
  let scan = scanFlow(chunk, open)
  while (scan === "open" && end < close) {
    end += 1
    chunk = joinLines(lines, index, end)
    scan = scanFlow(chunk, open)
  }
  if (scan === null || scan === "open") throw new Unsupported("also is not a list this tool can edit")
  // After the closing bracket: only a comment.
  if (!/^[ \t]*(?:#.*)?\r?\n?$/.test(chunk.slice(scan.close + 1))) throw new Unsupported("also is not a list this tool can edit")
  if (scan.items.length === 0) return { list: null, end }

  const edits = checkedEdits(alsoEdit, scan.items.map((item) => item.value))
  const singleLine = !chunk.slice(open, scan.close).includes("\n")
  // A redundant item stays in a list over several lines: a drop could lose a comment in that list.
  const drops = edits.map((edit) => edit.redundant && singleLine)
  if (edits.every((edit, at) => edit.value === scan.items[at].value && !drops[at])) return { list: null, end }

  const original = (at: number): string => chunk.slice(scan.items[at].start, scan.items[at].end)
  const written = (at: number): string =>
    edits[at].value === scan.items[at].value ? original(at) : renderToken(scan.items[at].quote, edits[at].value)

  const keptAt = scan.items.map((_item, at) => at).filter((at) => !drops[at])
  let inner = ""
  if (keptAt.length > 0) {
    inner = chunk.slice(open + 1, scan.items[0].start)
    keptAt.forEach((at, position) => {
      if (position > 0) inner += chunk.slice(scan.items[at - 1].end, scan.items[at].start)
      inner += written(at)
    })
    inner += chunk.slice(scan.items[scan.items.length - 1].end, scan.close)
  }
  const rewritten = chunk.slice(0, open + 1) + inner + chunk.slice(scan.close)

  // The first line of the entry holds all of the new text; the other lines of the entry are gone.
  const lineBreak = /\r?\n?$/.exec(rewritten)?.[0] ?? ""
  lines[index].content = rewritten.slice(0, rewritten.length - lineBreak.length)
  lines[index].eol = lineBreak
  for (let at = index + 1; at < end; at += 1) lines[at].removed = true
  return { list: keptAt.map((at) => edits[at].value), end }
}

function joinLines(lines: readonly Line[], from: number, to: number): string {
  return lines.slice(from, to).map((line) => line.content + line.eol).join("")
}

interface FlowScan {
  items: Token[]
  /** The position of the closing bracket. */
  close: number
}

/**
 * The items of the flow list that opens at `open` in `text`. Null when it is nested or not a list of scalars; "open"
 * when the text ends before the closing bracket.
 */
function scanFlow(text: string, open: number): FlowScan | "open" | null {
  const items: Token[] = []
  let at = skipFiller(text, open + 1)
  for (;;) {
    if (at >= text.length) return "open"
    if (text[at] === "]") return { items, close: at }
    const token = readToken(text, at, true)
    if (token === null) return null
    items.push(token)
    at = skipFiller(text, token.end)
    if (at >= text.length) return "open"
    if (text[at] === ",") at = skipFiller(text, at + 1)
    else if (text[at] !== "]") return null
  }
}

/** The position after the white space and the comments from `from`. */
function skipFiller(text: string, from: number): number {
  let at = from
  for (;;) {
    while (at < text.length && /\s/.test(text[at])) at += 1
    if (text[at] === "#" && (at === 0 || /\s/.test(text[at - 1]))) {
      const lineEnd = text.indexOf("\n", at)
      at = lineEnd === -1 ? text.length : lineEnd
    } else {
      return at
    }
  }
}

// --- read back -----------------------------------------------------------

function asList(value: FrontmatterValue | undefined): string[] {
  const items = Array.isArray(value) ? value : typeof value === "string" ? [value] : []
  return items.map((item) => item.trim()).filter((item) => item !== "")
}

/** A text for the first difference between the frontmatter after the edit and what the edit meant, or null. */
function readBackProblem(
  before: Record<string, FrontmatterValue>,
  after: Record<string, FrontmatterValue> | null,
  expected: ReadonlyMap<string, string[] | string>,
): string | null {
  const failure = (name: string): string => `the frontmatter would not read back as intended at "${name}", so the page was left as it is`
  if (after === null) return failure("frontmatter")
  for (const name of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const wanted = expected.get(name)
    if (wanted === undefined) {
      if (JSON.stringify(before[name]) !== JSON.stringify(after[name])) return failure(name)
    } else if (name === "also") {
      if (JSON.stringify(asList(after.also)) !== JSON.stringify(asList(wanted as string[]))) return failure(name)
    } else if (after[name] !== wanted) {
      return failure(name)
    }
  }
  return null
}
