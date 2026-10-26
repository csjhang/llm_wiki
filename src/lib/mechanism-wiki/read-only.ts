/**
 * Read-only pages of a mechanism wiki.
 *
 * In a mechanism wiki the AI keeps every page under `wiki/`. A person changes the
 * wiki by writing a thought card in Heptabase, and the next sync brings it in.
 * So the page editor opens these pages read-only and shows a one-line notice.
 * A page outside `wiki/` (a source, `purpose.md`, a lens) stays editable.
 */
import { normalizePath } from "@/lib/path-utils"

/** The notice above a read-only page. It is Traditional Chinese for every UI language, like the labels of the skill panel. */
export const READ_ONLY_NOTICE = "此頁由 AI 維護。要修改，請在 Heptabase 寫一張想法卡片。"

/** The folder of the pages that the AI keeps. */
const WIKI_FOLDER = "wiki"

/**
 * The segments of a path, with `.` and `..` applied. A Windows drive or UNC path is
 * lowercase, because the file system ignores its case. Slashes are all `/`.
 */
function pathSegments(path: string): string[] {
  const normalized = normalizePath(path)
  const folded = /^[A-Za-z]:\//.test(normalized) || normalized.startsWith("//") ? normalized.toLowerCase() : normalized
  const segments: string[] = []
  for (const part of folded.split("/")) {
    if (part === "" || part === ".") continue
    if (part === "..") segments.pop()
    else segments.push(part)
  }
  return segments
}

/** True when the file is inside the `wiki/` folder of the project, at any depth. The folder itself does not count. */
export function isWikiPagePath(
  projectPath: string | null | undefined,
  filePath: string | null | undefined,
): boolean {
  if (!projectPath || !filePath) return false
  const project = pathSegments(projectPath)
  const file = pathSegments(filePath)
  if (project.length === 0 || file.length <= project.length + 1) return false
  return project.every((segment, index) => file[index] === segment) && file[project.length] === WIKI_FOLDER
}

/**
 * True when the editor must show the page read-only: a page under `wiki/` of a mechanism wiki.
 * `mechanism` is the answer of `useMechanismWiki`: `null` while the check runs. A page under
 * `wiki/` stays read-only until the check says the project is not a mechanism wiki, so a quick
 * click cannot start an edit. A page outside `wiki/` needs no check.
 */
export function isReadOnlyPage(
  projectPath: string | null | undefined,
  filePath: string | null | undefined,
  mechanism: boolean | null,
): boolean {
  return isWikiPagePath(projectPath, filePath) && mechanism !== false
}
