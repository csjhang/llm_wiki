/**
 * Sentence-length check for AI-facing template files.
 *
 * The template files follow a short-sentence rule (at most 25 words). This
 * helper finds the sentences that break it. It is a guard, not a grammar check.
 */

export interface SteViolation {
  file: string
  /** 1-based line where the sentence starts. */
  line: number
  words: number
  sentence: string
}

const DEFAULT_MAX_WORDS = 25

/** Han, kana, Hangul, and CJK punctuation or full-width forms. */
const CJK_PATTERN = /[ᄀ-ᇿ⺀-〿぀-ヿ㄀-ㄯ㄰-㆏㐀-䶿一-鿿가-힯豈-﫿＀-￯]/

const FENCE_PATTERN = /^\s*(```|~~~)/
const LIST_MARKER_PATTERN = /^\s*(?:[-*+]|\d+[.)])\s+/

/** A run of prose lines that read as one block. Lines are joined with one space. */
interface Paragraph {
  /** Text of each line, in order. */
  texts: string[]
  /** 1-based file line number of each entry in `texts`. */
  lines: number[]
}

/**
 * Return every sentence longer than `maxWords` words.
 *
 * Skips YAML frontmatter, fenced code blocks, table rows (lines that start
 * with `|`), headings, and any line that contains CJK characters. Splits prose
 * on `.`, `!`, `?`, or `;` followed by whitespace or the end of the block.
 * A sentence can wrap over several lines. Each list item is a separate block.
 */
export function findLongSentences(
  file: string,
  markdown: string,
  maxWords: number = DEFAULT_MAX_WORDS,
): SteViolation[] {
  const violations: SteViolation[] = []
  for (const paragraph of collectParagraphs(markdown)) {
    for (const sentence of splitSentences(paragraph)) {
      const words = sentence.text.split(/\s+/).filter((word) => word !== "").length
      if (words > maxWords) {
        violations.push({ file, line: sentence.line, words, sentence: sentence.text })
      }
    }
  }
  return violations
}

function collectParagraphs(markdown: string): Paragraph[] {
  const rawLines = markdown.split(/\r?\n/)
  const paragraphs: Paragraph[] = []
  let current: Paragraph = { texts: [], lines: [] }
  const flush = (): void => {
    if (current.texts.length > 0) paragraphs.push(current)
    current = { texts: [], lines: [] }
  }

  let index = 0
  if (rawLines[0]?.trim() === "---") {
    const close = rawLines.findIndex((line, i) => i > 0 && line.trim() === "---")
    if (close !== -1) index = close + 1
  }

  let inFence = false
  for (; index < rawLines.length; index++) {
    const line = rawLines[index]
    if (FENCE_PATTERN.test(line)) {
      inFence = !inFence
      flush()
      continue
    }
    const trimmed = line.trim()
    const isSkipped =
      inFence || trimmed.startsWith("|") || trimmed.startsWith("#") || CJK_PATTERN.test(line)
    if (isSkipped || trimmed === "") {
      flush()
      continue
    }
    const startsItem = LIST_MARKER_PATTERN.test(line)
    if (startsItem) flush()
    const text = startsItem ? line.replace(LIST_MARKER_PATTERN, "").trim() : trimmed
    current.texts.push(text)
    current.lines.push(index + 1)
  }
  flush()
  return paragraphs
}

interface Sentence {
  text: string
  line: number
}

function splitSentences(paragraph: Paragraph): Sentence[] {
  // Join the lines and remember where each one starts, to map offsets to lines.
  const starts: number[] = []
  let joined = ""
  paragraph.texts.forEach((text, i) => {
    if (i > 0) joined += " "
    starts.push(joined.length)
    joined += text
  })

  const sentences: Sentence[] = []
  const boundary = /[.!?;](?=\s|$)/g
  let from = 0
  const emit = (end: number): void => {
    const raw = joined.slice(from, end)
    const text = raw.trim()
    if (text !== "") {
      const offset = from + (raw.length - raw.trimStart().length)
      sentences.push({ text, line: lineAt(offset, starts, paragraph.lines) })
    }
    from = end
  }
  for (let match = boundary.exec(joined); match !== null; match = boundary.exec(joined)) {
    emit(match.index + 1)
  }
  emit(joined.length)
  return sentences
}

function lineAt(offset: number, starts: number[], lines: number[]): number {
  let found = 0
  for (let i = 0; i < starts.length; i++) {
    if (starts[i] <= offset) found = i
  }
  return lines[found]
}
