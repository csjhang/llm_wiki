/**
 * Helpers for the contract tests of the skills that run `wiki-tool` (wiki-lint, wiki-recut).
 *
 * A skill is text for an agent. These helpers read the parts of that text that other code depends on: the `wiki-tool`
 * command lines in its code blocks, and its JSON blocks (the arguments of the `llm_wiki_*` MCP calls and the recut
 * plans). A test then runs the command lines against a real temporary wiki, so a wrong command or option fails here.
 */
import { readFileSync } from "node:fs"

const REPO_ROOT_URL = new URL("../../", import.meta.url)

/** The text of a file of the repository. The path starts at the repository root. */
export function readRepoFile(relativePath: string): string {
  return readFileSync(new URL(relativePath, REPO_ROOT_URL), "utf8")
}

// --- JSON blocks ---------------------------------------------------------

export interface JsonBlock {
  /** The tool named last in the paragraph before the block, or null. */
  tool: string | null
  json: Record<string, unknown>
  /** The name that the caller gave the text (a file name), for the message of a failed check. */
  source: string
}

/** The tools that a skill names before a JSON block: the `llm_wiki_*` tools and the Heptabase reads of wiki-fuse. */
const TOOL_NAME = /\b(llm_wiki_[a-z_]+|read_whiteboard|read_object|list_whiteboards|list_cards|read_database)\b/g

/**
 * Every ```json block of a markdown text, with the tool that the paragraph right before it names last (null when that
 * paragraph names none, as before a recut plan). All the skill tests use this one function.
 */
export function jsonBlocks(markdown: string, source = ""): JsonBlock[] {
  const blocks: JsonBlock[] = []
  for (const match of markdown.matchAll(/```json\n([\s\S]*?)```/g)) {
    const paragraphs = markdown.slice(0, match.index).split(/\n\s*\n/).filter((text) => text.trim() !== "")
    const paragraph = paragraphs[paragraphs.length - 1] ?? ""
    const names = [...paragraph.matchAll(TOOL_NAME)].map((name) => name[1])
    blocks.push({ tool: names.length > 0 ? names[names.length - 1] : null, json: JSON.parse(match[1]) as Record<string, unknown>, source })
  }
  return blocks
}

// --- wiki-tool command lines ---------------------------------------------

export interface WikiToolCommand {
  /** The command group: `lint`, `recut`. */
  group: string
  command: string
  /** The words after the command, unquoted. */
  args: string[]
  /** The line as the skill writes it. */
  line: string
}

const TOOL_LINE = /^node "<plugin dir>\/scripts\/wiki-tool\.mjs" (.+)$/

/** The words of a command line. A double-quoted or single-quoted part is one word, and the quotes are removed. */
export function shellWords(line: string): string[] {
  const words: string[] = []
  const pattern = /"([^"]*)"|'([^']*)'|(\S+)/g
  for (const match of line.matchAll(pattern)) words.push(match[1] ?? match[2] ?? match[3])
  return words
}

/**
 * The `wiki-tool` command lines in the code blocks of a skill. The line that shows the general form of a command
 * (`<command>` in place of its name) is not one.
 */
export function wikiToolCommands(markdown: string): WikiToolCommand[] {
  const commands: WikiToolCommand[] = []
  let inBlock = false
  for (const line of markdown.split(/\r?\n/)) {
    if (/^\s*```/.test(line)) {
      inBlock = !inBlock
      continue
    }
    const match = inBlock ? TOOL_LINE.exec(line) : null
    if (match === null) continue
    const [group, command, ...args] = shellWords(match[1])
    if (command === undefined || command.startsWith("<")) continue
    commands.push({ group, command, args, line })
  }
  return commands
}

/** The word with every placeholder (a key of `values`, such as `<project>`) replaced by its value. */
export function fillPlaceholders(word: string, values: Record<string, string>): string {
  return Object.entries(values).reduce((text, [placeholder, value]) => text.split(placeholder).join(value), word)
}

/** What the option parser says about a command line that does not fit the command. */
export const OPTION_PROBLEM = /unknown command|unknown option|missing option|missing value|unexpected argument|given more than once|takes no value/

/** The review types that the app accepts, read from the list of the API route (the same file the parity test reads). */
export function apiReviewTypes(): string[] {
  const source = readRepoFile("src-tauri/src/api_server.rs")
  const start = source.indexOf("const REVIEW_TYPES")
  return [...source.slice(start, source.indexOf("];", start)).matchAll(/"([a-z][a-z-]*)"/g)].map((match) => match[1])
}
