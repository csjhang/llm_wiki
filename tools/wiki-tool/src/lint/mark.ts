/**
 * `wiki-tool lint mark` - record that the semantic lint has seen the wiki as it is at a commit.
 *
 * `--project P [--commit SHA]` writes `.llm-wiki/semantic-lint.json` as `{ "commit": "<sha>", "at": "<ISO time>" }` and
 * gives `{ ok: true, commit, at }`. The commit is `HEAD`, or the commit that `--commit` names (a sha of 7 to 64 hex
 * digits). That commit must be an ancestor of `HEAD` or `HEAD` itself, else the command refuses and writes nothing. The
 * app can commit an ingest at any time during a long lint: the skill notes `HEAD` when it starts and marks that commit,
 * so what came after it counts as changed at the next lint. `lint changed-domains` reads the marker (see marker.ts).
 * The marker is never committed. A project that is not a mechanism wiki (no `domains.yaml`), a project that is not a git
 * repository, and a repository with no commit give exit 2 and no marker.
 */
import { headCommit, isGitWorkTree } from "../git"
import type { CommandResult } from "../io"
import { ancestorOfHead, isCommitSha, resolveCommit, writeMarker } from "./marker"
import { isMechanismWiki, notMechanismWiki, parseLintArgs } from "./project"

export function lintMark(args: string[]): CommandResult {
  const parsed = parseLintArgs(args, ["commit"])
  if (!parsed.ok) return parsed.result
  const { project, values } = parsed

  if (!isMechanismWiki(project)) return notMechanismWiki(project)
  if (!isGitWorkTree(project)) return { ok: false, problems: [`not inside a git work tree: ${project}`] }
  const head = headCommit(project)
  if (head === null) return { ok: false, problems: ["the repository has no commit yet; commit the wiki first"] }

  let commit = head
  const wanted = values.commit
  if (wanted !== undefined) {
    // Only a sha goes to git: a name or an option could mean anything else.
    if (!isCommitSha(wanted)) return { ok: false, problems: [`--commit must be the sha of a commit (7 to 64 hex digits): ${JSON.stringify(wanted)}`] }
    const found = ancestorOfHead(project, wanted)
    if (found === null) {
      const reason = resolveCommit(project, wanted) === null ? "a commit of this repository" : "an ancestor of HEAD, so it cannot be a baseline"
      return { ok: false, problems: [`--commit ${wanted} is not ${reason}`] }
    }
    commit = found
  }

  const at = new Date().toISOString()
  writeMarker(project, commit, at)
  return { ok: true, commit, at }
}
