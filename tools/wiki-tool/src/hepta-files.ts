/**
 * Where wiki-tool keeps the text of the cards it sends, under `<project>/.llm-wiki/hepta/` (git-ignored).
 *
 * `outbox/<sha256 of the page path>.md` is the text that plan-down wants in the card of a page. The skill sends this
 * file's text to Heptabase, so the text is never typed again. `sent/<card id>.md` is the text of the last write that
 * `hepta record` saw for a card. A user's edit is the difference between the card now and this file, so the text the
 * wiki wrote is never taken for the user's change.
 */
import { contentHash } from "./card-map"

const HEPTA_DIRECTORY = ".llm-wiki/hepta"

/** The project-relative path of the outbox file of a page. */
export function outboxFile(page: string): string {
  return `${HEPTA_DIRECTORY}/outbox/${contentHash(page)}.md`
}

/** The project-relative path of the sent file of a card. */
export function sentFile(cardId: string): string {
  return `${HEPTA_DIRECTORY}/sent/${cardId}.md`
}
