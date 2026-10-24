/**
 * Converters between wiki Markdown and Hepta Markdown.
 *
 * wikiPageToCard turns a wiki page into the content of a Heptabase note card:
 * no frontmatter, one H1 title, wikilinks as card links, and the mirror footer.
 * cardToSnapshotBody turns the Hepta Markdown of a card into plain Markdown for a
 * snapshot: mentions, colors, and card links become text, protected regions become
 * a comment. Both are pure, and neither touches fenced code blocks or inline code.
 */

/** A Heptabase card a wiki page can link to. */
export interface LinkTarget {
  cardId: string
  title: string
}

export interface WikiPageToCardOptions {
  /** The card title; it becomes the H1. */
  title: string
  /** The card for a wikilink slug, or null when the page is not synced. */
  resolveLink(slug: string): LinkTarget | null
  /** The page title for a slug, used for a link that is not synced and has no label. */
  titleForSlug(slug: string): string
  /** The cards the page was made from; they are listed in the footer. */
  sourceCards: LinkTarget[]
}

/** Written after a link whose page is not on Heptabase. */
const UNSYNCED_MARKER = "（僅在 wiki）"
const FOOTER_NO_SOURCES = "無"
const FOOTER_NOTICE = "由 wiki 產生，請勿直接編輯。"
/** Stands in for a Hepta element the tool cannot represent. */
const UNSUPPORTED_BLOCK = "<!-- heptabase: unsupported block -->"

const UUID = "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}"

/** The attributes of an HTML tag: anything but `>`, except inside quotes. */
const TAG_ATTRIBUTES = `(?:[^>"']|"[^"]*"|'[^']*')*`

/** `[[slug]]`, `[[slug|label]]`, and the same with a `!` embed prefix. A table cell may write the pipe as `\|`. */
const WIKILINK = /(!?)\[\[([^[\]|\\\n]+)(?:\\?\|([^[\]\n]*))?\]\]/g

/** An opening or closing tag of a mention or a color; the text between the tags stays. */
const HEPTA_INLINE_TAG = new RegExp(`</?hepta-(?:mention|color)(?=[\\s/>])${TAG_ATTRIBUTES}>`, "gi")

/** `[text](heptabase://card/<id>)` and `[text](https://app.heptabase.com/<space>/card/<id>)`, but not an image. */
const CARD_LINK = new RegExp(
  `(?<!!)\\[((?:\\\\.|[^\\[\\]\\\\\\n]|\\[[^\\[\\]\\n]*\\])*)\\]` +
    `\\(<?(?:heptabase://card/${UUID}|https://app\\.heptabase\\.com/[^\\s/)]+/card/${UUID})(?:[#?][^\\s)]*)?>?\\)`,
  "gi",
)

/** `[title](heptabase://card/<id>)`. Backslashes and brackets in the title are escaped so it cannot end the link text early. */
export function cardLink(target: LinkTarget): string {
  const title = target.title.replace(/\s+/g, " ").trim().replace(/[\\[\]]/g, "\\$&")
  return `[${title}](heptabase://card/${target.cardId})`
}

/**
 * A wiki page as the content of a Heptabase note card.
 *
 * A wikilink is resolved by its slug without the `#anchor`. A resolved link keeps its
 * label as the link text, or the card title without one; an unresolved link is the label
 * or the page title followed by the unsynced marker. A fence the page never closes is
 * closed before the footer, so the footer is not part of the code block.
 */
export function wikiPageToCard(markdown: string, opts: WikiPageToCardOptions): string {
  const text = markdown.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n")
  const body = dropLeadingTitle(stripFrontmatter(text))

  const code = maskCode(body)
  const converted = code.restore(
    code.masked.replace(WIKILINK, (match, _embed: string, rawTarget: string, rawLabel: string | undefined) => {
      const [rawSlug, ...anchorParts] = rawTarget.split("#")
      const slug = rawSlug.trim()
      const anchor = anchorParts.join("#").replace(/^\^/, "").trim()
      const label = rawLabel?.trim()
      // `[[#heading]]` points into the same page: it has no card, so it is plain text.
      if (slug === "") return anchor === "" && !label ? match : label || anchor
      const target = opts.resolveLink(slug)
      if (target) return cardLink(label ? { cardId: target.cardId, title: label } : target)
      return `${label ? label : opts.titleForSlug(slug)}${UNSYNCED_MARKER}`
    }),
  )

  const title = `# ${opts.title.replace(/\s+/g, " ").trim()}`
  const content = [converted.replace(/\s+$/, ""), code.unclosedFence].filter((part) => part !== undefined).join("\n")
  const sources = opts.sourceCards.length > 0 ? opts.sourceCards.map(cardLink).join(", ") : FOOTER_NO_SOURCES
  const footer = `---\n來源：${sources}\n${FOOTER_NOTICE}`
  return [title, content, footer].filter((part) => part !== "").join("\n\n")
}

export function cardToSnapshotBody(heptaMarkdown: string): string {
  const code = maskCode(heptaMarkdown)
  let text = replaceUnsupportedBlocks(code.masked)
  text = text.replace(HEPTA_INLINE_TAG, "")
  text = text.replace(CARD_LINK, "$1")
  return code.restore(text)
}

/** Removes a leading `---` frontmatter block. */
function stripFrontmatter(text: string): string {
  return text.replace(/^---[ \t]*\n(?:[\s\S]*?\n)?(?:---|\.\.\.)[ \t]*(?:\n|$)/, "")
}

/** Removes blank lines and then an H1 at the start, so the card title is the only H1 there. */
function dropLeadingTitle(text: string): string {
  const body = text.replace(/^(?:[ \t]*\n)+/, "")
  const lines = body.split("\n")
  const first = lines[0] ?? ""
  let skip = 0
  if (/^ {0,3}#(?:[ \t].*)?$/.test(first)) skip = 1
  else if (first.trim() !== "" && /^ {0,3}=+[ \t]*$/.test(lines[1] ?? "")) skip = 2
  return lines.slice(skip).join("\n").replace(/^(?:[ \t]*\n)+/, "")
}

interface MaskedCode {
  /** The text with each code region replaced by one placeholder. */
  masked: string
  /** Puts the code regions back. */
  restore(text: string): string
  /** When a fence is never closed: the line that closes it. The unclosed fence runs to the end of the text. */
  unclosedFence?: string
}

/** The placeholder of region `n`. A NUL cannot be in the text: callers replace it first. */
function placeholder(n: number): string {
  return `\u0000${n}\u0000`
}

/**
 * Replaces fenced code blocks and inline code spans with placeholders, so a
 * conversion cannot change them. An unclosed fence runs to the end of the text.
 * A code span stays inside its paragraph.
 */
function maskCode(input: string): MaskedCode {
  const regions: string[] = []
  const keep = (code: string): string => {
    regions.push(code)
    return placeholder(regions.length - 1)
  }

  const text = input.replace(/\u0000/g, "\uFFFD")
  const fences = maskFences(text, keep)
  const masked = maskInlineCode(fences.text, keep)
  return {
    masked,
    restore: (value) => value.replace(/\u0000(\d+)\u0000/g, (_match, n: string) => regions[Number(n)] ?? ""),
    unclosedFence: fences.unclosedFence,
  }
}

const FENCE_OPEN = /^[ \t>]*(`{3,}|~{3,})(.*)$/

function maskFences(text: string, keep: (code: string) => string): { text: string; unclosedFence?: string } {
  const lines = text.split("\n")
  const out: string[] = []
  let unclosedFence: string | undefined
  let i = 0
  while (i < lines.length) {
    const open = FENCE_OPEN.exec(lines[i])
    const marker = open?.[1]
    if (!open || !marker || (marker.startsWith("`") && open[2].includes("`"))) {
      out.push(lines[i])
      i++
      continue
    }
    const close = new RegExp(`^[ \\t>]*${marker[0] === "`" ? "`" : "~"}{${marker.length},}[ \\t]*$`)
    let end = i + 1
    while (end < lines.length && !close.test(lines[end])) end++
    if (end >= lines.length) unclosedFence = `${lines[i].slice(0, lines[i].indexOf(marker))}${marker}`
    const last = Math.min(end, lines.length - 1)
    out.push(keep(lines.slice(i, last + 1).join("\n")))
    i = last + 1
  }
  return { text: out.join("\n"), unclosedFence }
}

const PARAGRAPH_BREAK = /\n[ \t]*\n/g

function maskInlineCode(text: string, keep: (code: string) => string): string {
  let out = ""
  let i = 0
  // The end of the paragraph the scan is in. It holds until the scan passes it, so a long paragraph is searched once.
  let paragraphEnd = -1
  while (i < text.length) {
    const char = text[i]
    if (char === "\\" && i + 1 < text.length && /[!-/:-@[-`{-~]/.test(text[i + 1])) {
      out += text.slice(i, i + 2)
      i += 2
      continue
    }
    if (char !== "`") {
      out += char
      i++
      continue
    }
    let runEnd = i
    while (text[runEnd] === "`") runEnd++
    const length = runEnd - i
    if (paragraphEnd < runEnd) paragraphEnd = findParagraphEnd(text, runEnd)
    const closeEnd = findCodeSpanEnd(text, runEnd, length, paragraphEnd)
    if (closeEnd === -1) {
      out += text.slice(i, runEnd)
      i = runEnd
    } else {
      out += keep(text.slice(i, closeEnd))
      i = closeEnd
    }
  }
  return out
}

/** The index of the blank line that ends the paragraph holding `from`, or the end of the text. */
function findParagraphEnd(text: string, from: number): number {
  PARAGRAPH_BREAK.lastIndex = from
  return PARAGRAPH_BREAK.exec(text)?.index ?? text.length
}

/** The end of the code span whose opening run of `length` backticks ends at `from`, or -1. */
function findCodeSpanEnd(text: string, from: number, length: number, limit: number): number {
  let at = from
  while (at < limit) {
    const tick = text.indexOf("`", at)
    if (tick === -1 || tick >= limit) return -1
    let runEnd = tick
    while (text[runEnd] === "`") runEnd++
    if (runEnd - tick === length) return runEnd
    at = runEnd
  }
  return -1
}

/**
 * Replaces each `<hepta-placeholder>` and `<hepta-table>` element with a comment.
 * A table may span lines and hold other tags. A tag whose closing tag is missing
 * is replaced alone; a closing tag without an opening tag is dropped.
 */
function replaceUnsupportedBlocks(text: string): string {
  const tags = [...text.matchAll(new RegExp(`<(/?)hepta-(table|placeholder)(?=[\\s/>])(${TAG_ATTRIBUTES})>`, "gi"))]
  const endOf = (tag: RegExpMatchArray): number => (tag.index ?? 0) + tag[0].length
  let out = ""
  let position = 0
  let i = 0
  while (i < tags.length) {
    const tag = tags[i]
    const start = tag.index ?? 0
    out += text.slice(position, start)
    position = endOf(tag)
    i++
    const closing = tag[1] === "/"
    if (closing) continue
    out += UNSUPPORTED_BLOCK
    if (/\/\s*$/.test(tag[3])) continue

    const name = tag[2].toLowerCase()
    let depth = 1
    for (let j = i; j < tags.length; j++) {
      const next = tags[j]
      if (next[2].toLowerCase() !== name || (next[1] !== "/" && /\/\s*$/.test(next[3]))) continue
      depth += next[1] === "/" ? -1 : 1
      if (depth === 0) {
        position = endOf(next)
        i = j + 1
        break
      }
    }
  }
  return out + text.slice(position)
}
