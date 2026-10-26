/**
 * `wiki-tool lint changed-domains` - the domains whose pages changed since the last semantic lint.
 *
 * `--project P` gives `{ ok, since, domains, mechanismsChanged, ingestsSince }`, and `note` when the marker could
 * not be used. The marker `.llm-wiki/semantic-lint.json` (written by `lint mark`) names a commit. The changed
 * pages are the files under `wiki/` that differ between that commit and `HEAD`; uncommitted changes do not count.
 * A page counts under its `domain` (a hypothesis: its `to_domain`, ruling R19) and its `also` domains. A page that
 * was deleted, or that moved to another domain, counts under its old domains too: the command reads the page at
 * the marker commit as well as at `HEAD`. A renamed page is a deleted page and a new one.
 *
 * - `since` is the marker commit, or null when there is no usable marker. Then `domains` holds every domain of
 *   `domains.yaml` in file order (Review Focus 4), and `note` says why when a marker was there. A marker is not
 *   usable when it is not valid JSON, has no sha, or names a commit that is not an ancestor of `HEAD` (the
 *   history was rewritten).
 * - `domains` holds each changed domain once, in the order of `domains.yaml`. A name that no domain list holds is
 *   dropped. In a work wiki, the domains of the reading wiki follow those of this wiki.
 * - `mechanismsChanged` is true when a path under `wiki/mechanisms/` changed. Without a marker it is true when the
 *   wiki has a mechanism page.
 * - `ingestsSince` is the number of commits after the marker (all commits without a marker) whose subject starts
 *   with `ingest:`.
 *
 * It only reads: git calls take no lock.
 */
import { structurePageFromMarkdown } from "@/lib/mechanism-wiki/lint-structure"
import { readGit } from "../git"
import type { CommandResult } from "../io"
import { readWikiPages } from "../mirror-pages"
import { headCommit, isGitWorkTree, readMarker } from "./mark"
import {
  isPagePath,
  libraryOnlyDomains,
  type LintProject,
  loadLintProject,
  notMechanismWiki,
  ownDomains,
  parseLintArgs,
} from "./project"

const MECHANISMS_FOLDER = "wiki/mechanisms/"
const INGEST_PREFIX = "ingest:"

type ChangeStatus = "A" | "M" | "D"

interface ChangedPath {
  path: string
  status: ChangeStatus
}

export function lintChangedDomains(args: string[]): CommandResult {
  const parsed = parseLintArgs(args)
  if (!parsed.ok) return parsed.result
  const { project } = parsed

  const config = loadLintProject(project)
  if (config === null) return notMechanismWiki(project)
  if (config.blockingProblems.length > 0) {
    return { ok: false, problems: config.blockingProblems.map((problem) => `${problem}. Run "lint structure" for the details`) }
  }
  if (!isGitWorkTree(project)) return { ok: false, problems: [`not inside a git work tree: ${project}`] }

  const head = headCommit(project)
  const marker = readMarker(project)
  let note: string | undefined
  let since: string | null = null
  if (head !== null && marker.kind === "commit") {
    since = usableMarkerCommit(project, marker.commit)
    if (since === null) {
      note = `The marker commit ${marker.commit} is not in the history of HEAD (the history was rewritten). Every domain is listed.`
    }
  } else if (marker.kind === "bad") {
    note = `The marker file .llm-wiki/semantic-lint.json cannot be used: ${marker.reason}. Every domain is listed.`
  }

  const touched = new Set<string>()
  let mechanismsChanged: boolean
  if (since === null) {
    // No baseline: every page counts as changed.
    const pages = readWikiPages(project, { allowMissingWiki: true })
    for (const page of pages) for (const domain of domainsOfPage(page.path, page.markdown)) touched.add(domain)
    mechanismsChanged = pages.some((page) => page.path.toLowerCase().startsWith(MECHANISMS_FOLDER))
  } else {
    const changed = changedPaths(project, since)
    for (const { path, status } of changed) {
      if (!isPagePath(path)) continue
      // The old version tells the domains that the page left; the new one, the domains it joined.
      if (status !== "A") for (const domain of domainsOfPage(path, showFile(project, since, path))) touched.add(domain)
      if (status !== "D") for (const domain of domainsOfPage(path, showFile(project, "HEAD", path))) touched.add(domain)
    }
    mechanismsChanged = changed.some(({ path }) => path.toLowerCase().startsWith(MECHANISMS_FOLDER))
  }

  return {
    ok: true,
    since,
    domains: orderedDomains(config, touched, since === null),
    mechanismsChanged,
    ingestsSince: head === null ? 0 : countIngests(project, since),
    ...(note === undefined ? {} : { note }),
  }
}

/**
 * The domains to report, in the order of the domain lists. Without a baseline every domain of this wiki is
 * listed; the domains of the reading wiki are listed only when a page names them.
 */
function orderedDomains(config: LintProject, touched: ReadonlySet<string>, everyOwnDomain: boolean): string[] {
  const own = ownDomains(config)
  return [...(everyOwnDomain ? own : own.filter((domain) => touched.has(domain))), ...libraryOnlyDomains(config).filter((domain) => touched.has(domain))]
}

/** The `domain` (a hypothesis: `to_domain`) and the `also` domains of a page. */
function domainsOfPage(path: string, markdown: string): string[] {
  const page = structurePageFromMarkdown(path, markdown)
  return [...(page.domain === null ? [] : [page.domain]), ...page.also]
}

/**
 * The full sha of the marker commit when it is an ancestor of `HEAD`, else null. The commit may be unknown
 * (the history was rewritten and the object is gone), or known and on another line of history.
 */
function usableMarkerCommit(project: string, commit: string): string | null {
  const found = readGit(project, ["rev-parse", "--verify", "--quiet", `${commit}^{commit}`])
  if (found.status !== 0) return null
  const sha = found.stdout.trim()
  // Exit 0: an ancestor (or HEAD itself). Exit 1: not an ancestor.
  return readGit(project, ["merge-base", "--is-ancestor", sha, "HEAD"]).status === 0 ? sha : null
}

/**
 * The files under `wiki/` that differ between `since` and `HEAD`, with the paths relative to the project folder.
 * Renames are off, so a renamed page is a deleted page and an added one.
 */
function changedPaths(project: string, since: string): ChangedPath[] {
  const result = readGit(project, ["diff", "--name-status", "--no-renames", "--relative", "-z", since, "HEAD", "--", "wiki/"])
  if (result.status !== 0) throw new Error(result.stderr.trim() || "git diff failed")
  const fields = result.stdout.split("\0").filter((field) => field !== "")
  const changed: ChangedPath[] = []
  for (let index = 0; index + 1 < fields.length; index += 2) {
    const letter = fields[index][0]
    changed.push({ path: fields[index + 1], status: letter === "A" || letter === "D" ? letter : "M" })
  }
  return changed
}

/** The text of a file at a commit. `./` makes the path relative to the project folder, not to the repository. */
function showFile(project: string, revision: string, path: string): string {
  const result = readGit(project, ["show", `${revision}:./${path}`])
  if (result.status !== 0) throw new Error(result.stderr.trim() || `git show ${revision}:${path} failed`)
  return result.stdout.replace(/^﻿/, "")
}

/** The commits after `since` (all commits without it) whose subject starts with `ingest:`. */
function countIngests(project: string, since: string | null): number {
  const result = readGit(project, ["log", "--format=%s", since === null ? "HEAD" : `${since}..HEAD`])
  if (result.status !== 0) throw new Error(result.stderr.trim() || "git log failed")
  return result.stdout.split("\n").filter((subject) => subject.startsWith(INGEST_PREFIX)).length
}
