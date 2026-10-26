/**
 * What a review option may do, and where the Review tab may delete.
 *
 * Ruling S17. A review item can come from outside the app: `POST /projects/{id}/reviews`, which the MCP tool
 * `llm_wiki_add_review` calls for an agent that reads text it does not trust. The Review tab runs the `action` of a
 * button with the rights of the app. So an item that comes through the API may carry only an action that cannot
 * change or delete a file by accident:
 *
 * - a dismissal word (`isDismissalAction`), which only closes the card,
 * - `mech:propose-mechanism`, `mech:start-fusion`, `mech:dismiss-fusion`, or `mech:discard-mirror-edit`, or
 * - `open:wiki/<path>`, which opens a page of the wiki in the preview.
 *
 * The API route refuses every other action with a 400. The same rule is in `review_action_allowed` of
 * `src-tauri/src/api_server.rs` and in `isAllowedReviewAction` of `mcp-server/src/review-tools.ts`;
 * `review-option-actions.test.ts` reads both files and fails when a list differs.
 *
 * `resolveDeletePath` is the second line of defence. Even for an action that got into `review.json` another way,
 * the `delete:` button deletes only a file inside `<project>/wiki/`.
 */
import { normalizePath } from "@/lib/path-utils"

/**
 * An action equal to one of these words (any letter case) is a plain dismissal. The review view takes any other
 * text that is not a known prefix for a request to create or research a page.
 */
export const DISMISSAL_ACTION_WORDS = ["skip", "dismiss", "ignore", "跳过", "忽略", "approve", "keep existing", "no"] as const

/**
 * The `mech:` actions that an API caller may use. `mech:discard-mirror-edit` changes no page and no source: it adds a page
 * of `wiki/` (checked by `discardEditPage`) to `.llm-wiki/hepta/discard-edits.json`, and the next sync writes the text of
 * the wiki over the Heptabase card of that page. The other `mech:` actions write pages or sources (`mech:replace-source`,
 * `mech:approve-domain`, `mech:use-existing-domain`, `mech:accept-research`).
 */
export const API_MECHANISM_ACTIONS = [
  "mech:propose-mechanism",
  "mech:start-fusion",
  "mech:dismiss-fusion",
  "mech:discard-mirror-edit",
] as const

const OPEN_PREFIX = "open:"
const WIKI_FOLDER = "wiki/"

/** True when the action is a plain dismissal: it only closes the card. */
export function isDismissalAction(action: string): boolean {
  return (DISMISSAL_ACTION_WORDS as readonly string[]).includes(action.toLowerCase())
}

/**
 * True when the API route takes the action on a new item. A project-relative path in `wiki/` has no `..` segment and
 * no backslash. The `wiki/` prefix also keeps out a leading `/` and a drive letter.
 */
export function isAllowedApiReviewAction(action: string): boolean {
  const trimmed = action.trim()
  if (isDismissalAction(trimmed)) return true
  if ((API_MECHANISM_ACTIONS as readonly string[]).includes(trimmed)) return true
  if (!trimmed.startsWith(OPEN_PREFIX)) return false
  const path = trimmed.slice(OPEN_PREFIX.length)
  if (!path.startsWith(WIKI_FOLDER) || path.length === WIKI_FOLDER.length) return false
  return !path.includes("\\") && !path.split("/").includes("..")
}

/** A Windows path (drive letter or UNC) compares without letter case. Other paths compare as they are. */
function comparable(path: string): string {
  return /^[A-Za-z]:\//.test(path) || path.startsWith("//") ? path.toLowerCase() : path
}

/**
 * The path that a `delete:` action may delete: a file inside `<projectPath>/wiki/`, with `/` separators. Throws an
 * error for the user for any other path, for the `wiki` folder itself, and for a path with a `..` segment.
 */
export function resolveDeletePath(projectPath: string, rawPath: string): string {
  const root = normalizePath(projectPath).replace(/\/+$/, "")
  const path = normalizePath(rawPath)
  const wikiRoot = `${root}/${WIKI_FOLDER}`
  const refusal = new Error(`Refusing to delete ${rawPath}. A review action may delete only a file inside ${wikiRoot}`)
  if (root === "" || !comparable(path).startsWith(comparable(wikiRoot))) throw refusal
  const inside = path.slice(wikiRoot.length)
  if (inside === "" || inside.split("/").includes("..")) throw refusal
  return path
}

/** Delete the file of a `delete:` action after `resolveDeletePath` has accepted its path. */
export async function deleteReviewTarget(
  projectPath: string,
  rawPath: string,
  remove: (path: string) => Promise<void>,
): Promise<void> {
  await remove(resolveDeletePath(projectPath, rawPath))
}
