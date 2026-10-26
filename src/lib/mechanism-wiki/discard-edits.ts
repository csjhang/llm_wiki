/**
 * The list of mirror pages whose Heptabase edit the user chose to discard (spec 6.6, "Discard the edit").
 *
 * `.llm-wiki/hepta/discard-edits.json` is a JSON array of page paths. The review action `mech:discard-mirror-edit`
 * adds the page of a `mirror-edited` item. The next `wiki-tool hepta plan-down` plans the normal `update` for a listed
 * page, instead of `skip-edited`, so the card gets the text of the wiki again. `hepta record` takes the page out of
 * the list when the card was written (`updated`, `retired`, or `forgotten`).
 *
 * This module is pure. The app and the `wiki-tool` both import it, so there is one reader and one writer of the
 * format.
 */

export const DISCARD_EDITS_FILE = ".llm-wiki/hepta/discard-edits.json"

/**
 * The page path in the form that the card map uses: forward slashes, no leading `./`, inside `wiki/`, and a `.md`
 * file. Null for any other text.
 */
export function discardEditPage(path: string): string | null {
  const page = path.trim().replace(/\\/g, "/").replace(/^(\.\/)+/, "")
  if (!page.startsWith("wiki/") || !page.toLowerCase().endsWith(".md")) return null
  const segments = page.split("/")
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) return null
  return page
}

export type DiscardEditsRead = { ok: true; pages: string[] } | { ok: false; reason: string }

/** The pages of the file text. An empty text is an empty list. A page is listed once, in the order of the file. */
export function parseDiscardEdits(text: string): DiscardEditsRead {
  const body = text.replace(/^﻿/, "")
  if (body.trim() === "") return { ok: true, pages: [] }
  const unreadable = (why: string): DiscardEditsRead => ({ ok: false, reason: `${DISCARD_EDITS_FILE} ${why}` })
  let value: unknown
  try {
    value = JSON.parse(body)
  } catch (error) {
    return unreadable(`is not valid JSON: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (!Array.isArray(value)) return unreadable("must be a JSON array of page paths")
  const pages: string[] = []
  for (const item of value) {
    const page = typeof item === "string" ? discardEditPage(item) : null
    if (page === null) return unreadable(`has an item that is not a page path in wiki/: ${JSON.stringify(item)}`)
    if (!pages.includes(page)) pages.push(page)
  }
  return { ok: true, pages }
}

/** The list with `page` at the end, or as it is when the page is there. */
export function addDiscardEdit(pages: readonly string[], page: string): string[] {
  return pages.includes(page) ? [...pages] : [...pages, page]
}

/** The list without `page`. */
export function removeDiscardEdit(pages: readonly string[], page: string): string[] {
  return pages.filter((other) => other !== page)
}

/** The text of the file for a list of pages. */
export function renderDiscardEdits(pages: readonly string[]): string {
  return `${JSON.stringify(pages, null, 2)}\n`
}
