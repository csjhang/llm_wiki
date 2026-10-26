/**
 * `wiki-tool lint mark` - record that the semantic lint has seen the wiki as it is at `HEAD`.
 *
 * `--project P` writes `.llm-wiki/semantic-lint.json` as `{ "commit": "<sha of HEAD>", "at": "<ISO time>" }` and gives
 * `{ ok: true, commit, at }`. `lint changed-domains` reads the marker (see marker.ts). The marker is never
 * committed. A project that is not a mechanism wiki (no `domains.yaml`), a project that is not a git repository, and
 * a repository with no commit give exit 2 and no marker.
 */
import { headCommit, isGitWorkTree } from "../git"
import type { CommandResult } from "../io"
import { writeMarker } from "./marker"
import { isMechanismWiki, notMechanismWiki, parseLintArgs } from "./project"

export function lintMark(args: string[]): CommandResult {
  const parsed = parseLintArgs(args)
  if (!parsed.ok) return parsed.result
  const { project } = parsed

  if (!isMechanismWiki(project)) return notMechanismWiki(project)
  if (!isGitWorkTree(project)) return { ok: false, problems: [`not inside a git work tree: ${project}`] }
  const commit = headCommit(project)
  if (commit === null) return { ok: false, problems: ["the repository has no commit yet; commit the wiki first"] }

  const at = new Date().toISOString()
  writeMarker(project, commit, at)
  return { ok: true, commit, at }
}
