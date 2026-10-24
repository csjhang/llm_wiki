/**
 * Index a research page for search. A research page is not ingested (that would write a second
 * summary page and feed on its own gaps), so whoever puts one in `wiki/queries/` indexes it here:
 * deep research for a page it writes at once, and `mech:accept-research` for a staged page it moves.
 */
import { normalizePath } from "@/lib/path-utils"
import { useWikiStore } from "@/stores/wiki-store"

/**
 * Embed the page at `pagePath` (absolute, inside `wiki/`). Does nothing when embedding is off.
 * Never throws: a failed index leaves the page unsearchable by meaning, and that is only a warning.
 */
export async function indexResearchPage(
  projectPath: string,
  pagePath: string,
  title: string,
  content: string,
): Promise<void> {
  const embeddingConfig = useWikiStore.getState().embeddingConfig
  if (!embeddingConfig.enabled || !embeddingConfig.model) return
  try {
    const { embedPage, wikiPageIdFromPath } = await import("@/lib/embedding")
    const pp = normalizePath(projectPath)
    await embedPage(pp, wikiPageIdFromPath(pp, pagePath), title, content, embeddingConfig)
  } catch (err) {
    console.warn("[DeepResearch] failed to index generated query page:", err)
  }
}
