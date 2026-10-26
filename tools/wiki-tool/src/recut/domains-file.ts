/**
 * The text edit of `domains.yaml` for a recut.
 *
 * The app writes this file as text too (`insertDomain` in `src/lib/mechanism-wiki/review-actions.ts`), so that every
 * comment and blank line stays. This module does the same for the three changes of a recut: a domain gets another
 * name (the key line changes and the entry stays as it is), an entry is removed, or an entry is replaced by new
 * entries (a split makes several, a merge makes one). A new entry is written as the app writes it: `lens`,
 * `description`, and `whiteboards`, with the indent and the line breaks of the file.
 *
 * The block of an entry is its key line and the indented lines after it. A comment in the first column, and a blank
 * line, are not part of a block, so they stay when the entry goes. The caller reads the result back with
 * `parseDomainsYaml`. A form this module cannot edit throws `DomainsFileError`.
 */
import yaml from "js-yaml"
import { yamlString } from "../cmd-snapshot"

export class DomainsFileError extends Error {}

/** An entry that the edit writes. */
export interface GeneratedDomain {
  name: string
  lens: string
  description: string
  whiteboards: readonly string[]
}

export interface DomainsTextEdit {
  /** Old name to new name. Only the key line changes. */
  renames?: ReadonlyMap<string, string>
  /** The entries that take the place of the entry of a domain. An empty list removes the entry. */
  replacements?: ReadonlyMap<string, readonly GeneratedDomain[]>
}

interface Line {
  content: string
  eol: string
}

interface Block {
  start: number
  /** The line after the block. */
  end: number
}

/** The `domains` key with a block (or nothing) after it. */
const DOMAINS_BLOCK = /^domains[ \t]*:[ \t]*(?:#.*)?$/
const ENTRY_KEY = /^([ \t]*)(["']?)([^\s:#'"]+)\2([ \t]*:(?:[ \t].*)?)$/

export function editDomainsYaml(text: string, edit: DomainsTextEdit): string {
  const lines: Line[] = (text.match(/[^\n]*\n|[^\n]+/g) ?? []).map((raw) => {
    const content = raw.replace(/\r?\n?$/, "")
    return { content, eol: raw.slice(content.length) }
  })
  const eol = text.includes("\r\n") ? "\r\n" : "\n"

  const keyAt = lines.findIndex((line) => /^domains[ \t]*:/.test(line.content))
  if (keyAt === -1) throw new DomainsFileError("domains.yaml has no domains block")
  if (!DOMAINS_BLOCK.test(lines[keyAt].content)) {
    throw new DomainsFileError("the domains list in domains.yaml is written in a form that this tool cannot edit")
  }

  // The block ends at the next line that starts in the first column and is not a comment.
  let blockEnd = lines.length
  for (let index = keyAt + 1; index < lines.length; index += 1) {
    const content = lines[index].content
    if (content.trim() === "" || /^[ \t]/.test(content) || content.startsWith("#")) continue
    blockEnd = index
    break
  }
  // The indent of the keys is the indent of the first line of content; the indent of an entry body is the next deeper one.
  const contentLines = lines.slice(keyAt + 1, blockEnd).map((line) => line.content).filter((content) => content.trim() !== "" && !/^[ \t]*#/.test(content))
  if (contentLines.length === 0) throw new DomainsFileError("domains.yaml lists no domain")
  const entryIndent = indentOf(contentLines[0])
  const deeper = contentLines.find((content) => indentOf(content).length > entryIndent.length)
  const bodyIndent = deeper === undefined ? `${entryIndent}  ` : indentOf(deeper)

  // The blocks of the entries, by name.
  const blocks = new Map<string, Block>()
  const keyLines: number[] = []
  for (let index = keyAt + 1; index < blockEnd; index += 1) {
    const match = ENTRY_KEY.exec(lines[index].content)
    if (match !== null && match[1] === entryIndent) {
      blocks.set(match[3], { start: index, end: index + 1 })
      keyLines.push(index)
    }
  }
  for (const block of blocks.values()) block.end = blockLastLine(lines, block.start, blockEnd, entryIndent.length, keyLines) + 1

  const renames = edit.renames ?? new Map<string, string>()
  const replacements = edit.replacements ?? new Map<string, readonly GeneratedDomain[]>()
  for (const name of [...renames.keys(), ...replacements.keys()]) {
    if (!blocks.has(name)) throw new DomainsFileError(`domains.yaml has no entry for ${name}`)
  }
  for (const name of renames.keys()) {
    if (replacements.has(name)) throw new DomainsFileError(`the domain ${name} is both renamed and replaced`)
  }

  const out: string[] = []
  const startAt = new Map<number, string>()
  for (const name of replacements.keys()) startAt.set((blocks.get(name) as Block).start, name)
  const renameAt = new Map<number, string>()
  for (const [oldName, newName] of renames) renameAt.set((blocks.get(oldName) as Block).start, newName)

  for (let index = 0; index < lines.length; index += 1) {
    const replaced = startAt.get(index)
    if (replaced !== undefined) {
      for (const entry of replacements.get(replaced) ?? []) out.push(...entryLines(entry, entryIndent, bodyIndent, eol))
      index = (blocks.get(replaced) as Block).end - 1
      continue
    }
    const renamed = renameAt.get(index)
    if (renamed !== undefined) {
      const match = ENTRY_KEY.exec(lines[index].content) as RegExpExecArray
      out.push(`${match[1]}${match[2]}${renamed}${match[2]}${match[4]}${lines[index].eol}`)
      continue
    }
    out.push(lines[index].content + lines[index].eol)
  }
  return out.join("")
}

/**
 * The last line of the block that starts at `start`: the last line with content that is indented deeper than the key.
 * The block stops at the next key line, at a comment that is not indented deeper, and at the end of the list.
 */
function blockLastLine(lines: readonly Line[], start: number, limit: number, keyWidth: number, keyLines: readonly number[]): number {
  let last = start
  for (let index = start + 1; index < limit; index += 1) {
    if (keyLines.includes(index)) break
    const content = lines[index].content
    if (content.trim() === "") continue
    const width = content.length - content.trimStart().length
    if (/^[ \t]*#/.test(content)) {
      if (width <= keyWidth) break
      continue
    }
    if (width <= keyWidth) break
    last = index
  }
  return last
}

function indentOf(content: string): string {
  return /^[ \t]*/.exec(content)?.[0] ?? ""
}

function entryLines(entry: GeneratedDomain, indent: string, bodyIndent: string, eol: string): string[] {
  const lines = [
    `${indent}${entry.name}:${eol}`,
    `${bodyIndent}lens: ${scalar(entry.lens)}${eol}`,
    `${bodyIndent}description: ${scalar(entry.description)}${eol}`,
  ]
  if (entry.whiteboards.length === 0) return [...lines, `${bodyIndent}whiteboards: []${eol}`]
  return [...lines, `${bodyIndent}whiteboards:${eol}`, ...entry.whiteboards.map((id) => `${bodyIndent}  - ${scalar(id)}${eol}`)]
}

/** `value` as a YAML scalar: plain when it reads back as the same string, else double-quoted (the rule of `mech:approve-domain`). */
function scalar(value: string): string {
  if (/^[A-Za-z0-9][A-Za-z0-9 ,.()'/_+-]*$/.test(value) && !value.endsWith(" ")) {
    try {
      if (yaml.load(value) === value) return value
    } catch {
      // Not plain-safe; quote it.
    }
  }
  return yamlString(value)
}
