/**
 * What the Heptabase mirror sync decides about a wiki page, in one pure module.
 *
 * The `wiki-tool` CLI (`hepta plan-down`) decides which pages get a card. The structural lint of the app
 * (`lint-structure.ts`) must know the same rule: a retired card whose page is back and mirrored again gets
 * its card back at the next sync, so the lint must not tell the user to delete that card. Both import this
 * file, so the rule has one copy. It imports nothing: the `wiki-tool` bundle may use it.
 */

/** Title prefix of a card whose page is gone. The tool puts it before the title. */
export const RETIRED_TITLE_PREFIX = "🗄 已停用｜"

/** Page types that are always synced. A `concept` is synced when it has two sources. */
const ALWAYS_SYNCED_TYPES: readonly string[] = ["mechanism", "hypothesis", "comparison"]
const MIN_CONCEPT_SOURCES = 2

/** The two fields of a page that decide whether it is mirrored. */
export interface SyncablePage {
  /** The `type` in the frontmatter of the page. "" when the page has none: the folder of the page does not count. */
  type: string
  /** The `sources` of the page. Blank names are ignored and a name that is repeated counts once. */
  sources: readonly string[]
}

/** True for a page that is mirrored: mechanism, hypothesis, comparison, or a concept with two sources. */
export function isSyncable(page: SyncablePage): boolean {
  if (ALWAYS_SYNCED_TYPES.includes(page.type)) return true
  if (page.type !== "concept") return false
  const names = new Set(page.sources.map((name) => name.trim()).filter((name) => name !== ""))
  return names.size >= MIN_CONCEPT_SOURCES
}
