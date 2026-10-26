/**
 * The check of the work tree before a recut (ruling U2).
 *
 * A recut commits the files it changes and nothing else, and `wiki-undo` can take the commit back. Both only make sense
 * when the recut is the only change in the commit, so a recut starts on a tree without uncommitted changes in the wiki
 * folder: staged, not staged, deleted, or new. Two things do not count: the card map `heptabase-map.json` (it is often
 * uncommitted after a sync, and the recut never commits it) and everything under `.llm-wiki/` (local state that is
 * never committed). This is the rule of `isDirty` in `plugins/llm-wiki/skills/wiki-undo/scripts/undo.mjs`, except that
 * a change outside the wiki folder of a larger repository does not count, because the commit of a recut names its paths.
 */
import { CARD_MAP_FILE } from "../card-map"
import { readGit } from "../git"
import { compareText } from "../mirror-pages"

const LLM_WIKI_DIR = ".llm-wiki"

/** The paths in the wiki folder (relative to it) that have uncommitted changes and count, sorted. Empty for a clean tree. */
export function uncommittedChanges(project: string): string[] {
  const prefix = readGit(project, ["rev-parse", "--show-prefix"]).stdout.trim()
  const status = readGit(project, ["status", "--porcelain", "-z", "--untracked-files=normal"])
  if (status.status !== 0) throw new Error(status.stderr.trim() || "git status failed")

  const paths = new Set<string>()
  const entries = status.stdout.split("\0")
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index]
    if (entry === "") continue
    const candidates = [entry.slice(3)]
    // A rename or copy entry is followed by a second entry with the old path.
    if ("RC".includes(entry[0]) || "RC".includes(entry[1])) {
      index += 1
      candidates.push(entries[index] ?? "")
    }
    for (const path of candidates) {
      if (path === "" || (prefix !== "" && !path.startsWith(prefix))) continue
      const relative = path.slice(prefix.length)
      const ignored = relative === CARD_MAP_FILE || relative === LLM_WIKI_DIR || relative.startsWith(`${LLM_WIKI_DIR}/`)
      if (!ignored) paths.add(relative)
    }
  }
  return [...paths].sort(compareText)
}
