/**
 * Where wiki-tool keeps the text of the cards it sends, under `<project>/.llm-wiki/hepta/` (git-ignored).
 *
 * `outbox/<sha256 of the page path>.md` is the text that plan-down wants in the card of a page. The skill sends this
 * file's text to Heptabase, so the text is never typed again. `sent/<card id>.md` is the text of the last write that
 * `hepta record` saw for a card. A user's edit is the difference between the card now and this file, so the text the
 * wiki wrote is never taken for the user's change.
 *
 * `discard-edits.json` lists the pages whose Heptabase edit the user chose to discard in the review tab (spec 6.6). The app
 * writes it (`mech:discard-mirror-edit`), `hepta plan-down` reads it (for the edit the user saw only, ruling W13), and
 * `hepta record` takes a page out of it when it saves feedback or writes the card. The format is in `src/lib/mechanism-wiki/discard-edits.ts`, which the app shares.
 */
import { readFileSync } from "node:fs"
import {
  DISCARD_EDITS_FILE,
  discardEditPage,
  parseDiscardEdits,
  removeDiscardEdit,
  renderDiscardEdits,
} from "@/lib/mechanism-wiki/discard-edits"
import { contentHash } from "./card-map"
import { resolveInProject, writeFileAtomic } from "./io"

const HEPTA_DIRECTORY = ".llm-wiki/hepta"

/** The project-relative path of the outbox file of a page. */
export function outboxFile(page: string): string {
  return `${HEPTA_DIRECTORY}/outbox/${contentHash(page)}.md`
}

/** The project-relative path of the sent file of a card. */
export function sentFile(cardId: string): string {
  return `${HEPTA_DIRECTORY}/sent/${cardId}.md`
}

/**
 * The pages whose edit the user chose to discard. A missing file is an empty list. A file that cannot be read or is not a
 * list of page paths throws an Error with a message for the user.
 */
export function readDiscardEdits(project: string): string[] {
  let text: string
  try {
    text = readFileSync(resolveInProject(project, DISCARD_EDITS_FILE), "utf8")
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return []
    throw new Error(`cannot read ${DISCARD_EDITS_FILE}: ${error instanceof Error ? error.message : String(error)}`)
  }
  const read = parseDiscardEdits(text)
  if (!read.ok) throw new Error(read.reason)
  return read.pages
}

/** Take a page out of the list of discarded edits. True when the page was in the list. The file is written atomically. */
export function clearDiscardEdit(project: string, page: string): boolean {
  const key = discardEditPage(page)
  const pages = readDiscardEdits(project)
  if (key === null || !pages.includes(key)) return false
  writeFileAtomic(resolveInProject(project, DISCARD_EDITS_FILE), renderDiscardEdits(removeDiscardEdit(pages, key)))
  return true
}
