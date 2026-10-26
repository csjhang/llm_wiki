/**
 * `wiki-tool recut apply` - run a recut (rename, move, split, or merge of domains) and commit it once.
 *
 * `--project P --plan F` gives `{ ok: true, sha, pages, mergeCandidates?, notes? }`. `F` is the path of a JSON file with
 * the plan (see `plan.ts`), or the JSON itself when it starts with `{`. `pages` are the wiki pages that changed;
 * `sha` is the new commit. A merge always gives `mergeCandidates`: pairs of pages with the same name that the merge
 * brings into one domain (the skill files them as `duplicate` reviews). `notes` are things to tell the user.
 *
 * The command checks everything before it writes anything: the plan against `domains.yaml` and the pages, the work
 * tree (ruling U2, `work-tree.ts`), the text of every file that changes, that no file it writes is outside the project
 * (a link can lead out), that no reference to a removed domain is left in any page (a page whose frontmatter the edit
 * cannot reach stops the recut, it is never skipped), and that no page changed since it was read. Then it:
 * 1. rewrites `domains.yaml` as text (`domains-file.ts`), so comments stay;
 * 2. rewrites the domain keys of the pages and the Known instances lines (`page-edits.ts`), touching no other byte;
 * 3. rebuilds the domain index with the pure renderers of the app, writes the files that changed, and removes the index
 *    files of the domains that are gone;
 * 4. commits all of these files in one commit `recut: <op> <from> → <to> (<N> pages)`, where N counts the changed wiki
 *    pages only (ruling U7), through `commitPathsLocked`;
 * 5. after the commit, gives the dismissed fusion pairs the new names (ruling U5; not committed).
 *
 * In a reading wiki, `notes` also says which domain names changed: a work wiki that reads this wiki keeps the old names in
 * the `from_domain` and `to_domain` of its hypothesis pages, and its pages need the new names (ruling U21).
 *
 * When the commit fails, the files are taken out of the index, every file goes back to what it was, and the command exits
 * with the problem, so a failed recut leaves the work tree as it found it. Nothing is pushed.
 */
import { readFileSync, rmSync } from "node:fs"
import { buildActionCommitMessage } from "@/lib/commit-message"
import {
  domainIndexPath,
  indexedPageFromMarkdown,
  MECHANISM_INDEX_PATH,
  renderDomainIndex,
  renderMechanismIndex,
  renderRootIndex,
  ROOT_INDEX_PATH,
} from "@/lib/mechanism-wiki/domain-index-render"
import { type DomainsConfig, parseDomainsYaml } from "@/lib/wiki-config/domains"
import { knownLenses } from "../cmd-snapshot"
import { type CommitResult, commitPathsLocked, isGitWorkTree, unstagePathsLocked } from "../git"
import { GIT_LOCK_BUSY_MESSAGE } from "../git-lock"
import { type CommandResult, resolveInProject, writeFileAtomic } from "../io"
import { loadLintProject, notMechanismWiki, parseLintArgs } from "../lint/project"
import { compareText } from "../mirror-pages"
import { remapDismissedPairs } from "./dismissed"
import { DomainsFileError, editDomainsYaml } from "./domains-file"
import { insideProblem, lexists } from "./inside"
import { computePageEdits, findLeftoverRefs } from "./page-edits"
import { createMapper, type DomainChanges, findMergeCandidates, libraryNote, parseRecutPlan, planDomains, planTitle, type RecutPlan, validateRecutPlan } from "./plan"
import { readPageSources } from "./read-pages"
import { uncommittedChanges } from "./work-tree"

const DOMAINS_FILE = "domains.yaml"
const MAX_NAMED_FILES = 10

export async function recutApply(args: string[]): Promise<CommandResult> {
  const parsed = parseLintArgs(args, ["plan"], ["plan"])
  if (!parsed.ok) return parsed.result
  const { project, values } = parsed

  const config = loadLintProject(project)
  if (config === null) return notMechanismWiki(project)
  if (config.blockingProblems.length > 0) {
    return { ok: false, problems: config.blockingProblems.map((problem) => `${problem}. Run "lint structure" for the details`) }
  }
  if (!isGitWorkTree(project)) return { ok: false, problems: [`not inside a git work tree: ${project}`] }
  const dirty = uncommittedChanges(project)
  if (dirty.length > 0) {
    const shown = dirty.slice(0, MAX_NAMED_FILES).join(", ")
    const named = dirty.length > MAX_NAMED_FILES ? `${shown} and ${dirty.length - MAX_NAMED_FILES} more` : shown
    return { ok: false, problems: [`the working tree has uncommitted changes: ${named}. Commit or stash them, then run the recut again.`] }
  }

  const planText = readPlanText(values.plan)
  if (!planText.ok) return { ok: false, problems: [planText.problem] }
  const planned = parseRecutPlan(planText.text)
  if (!planned.ok) return { ok: false, problems: planned.problems }
  const { plan } = planned

  let read: ReturnType<typeof readPageSources>
  try {
    read = readPageSources(project)
  } catch (error) {
    return { ok: false, problems: [`cannot read the pages of the wiki: ${error instanceof Error ? error.message : String(error)}`] }
  }
  const { sources, blocked } = read
  const lenses = knownLenses(project)
  const problems = validateRecutPlan({ plan, domains: config.domains, pages: sources.map((source) => source.page), lenses })
  if (problems.length > 0) return { ok: false, problems }

  // Everything that changes, computed in memory first.
  const changes = planDomains(plan, config.domains)
  const domains = editedDomainsFile(project, plan, changes, lenses)
  if (!domains.ok) return { ok: false, problems: [domains.problem] }
  const pageEdits = computePageEdits(plan, sources)
  const editProblems = [
    ...pageEdits.problems,
    ...pageEdits.edits.filter((edit) => blocked.has(edit.path)).map((edit) => `${edit.path}: ${blocked.get(edit.path)}, so a recut cannot edit it safely`),
  ]
  if (editProblems.length > 0) return { ok: false, problems: editProblems }
  const leftovers = findLeftoverRefs(sources, pageEdits, changes.removed)
  if (leftovers.length > 0) return { ok: false, problems: leftovers }

  const afterPath = new Map(pageEdits.edits.map((edit) => [edit.path, edit.after]))
  const indexed = sources.map((source) => indexedPageFromMarkdown(source.page.path, (afterPath.get(source.page.path) ?? source.text).replace(/^\uFEFF/, "")))
  const indexFiles: Array<[string, string]> = [
    [ROOT_INDEX_PATH, renderRootIndex(indexed, changes.next)],
    [MECHANISM_INDEX_PATH, renderMechanismIndex(indexed)],
    ...Object.keys(changes.next.domains)
      .sort(compareText)
      .map((domain): [string, string] => [domainIndexPath(domain), renderDomainIndex(domain, indexed)]),
  ]

  const writes = indexFiles.filter(([path, text]) => currentText(project, path) !== text).map(([path]) => path)
  // A link that leads nowhere, or loops, is something to remove too: `insideProblem` below refuses it, so it is not skipped.
  const removals = changes.removed.map(domainIndexPath).filter((path) => lexists(resolveInProject(project, path)))
  const outside = [DOMAINS_FILE, ...writes, ...removals].flatMap((path) => {
    const problem = insideProblem(project, path)
    return problem === null ? [] : [`${path}: ${problem}, so a recut does not write it`]
  })
  if (outside.length > 0) return { ok: false, problems: outside }

  const expected = [...pageEdits.edits.map((edit): [string, string] => [edit.path, edit.before]), [DOMAINS_FILE, domains.before] as [string, string]]
  const stale = expected.filter(([path, before]) => changedSince(project, path, before)).map(([path]) => path)
  if (stale.length > 0) return { ok: false, problems: stale.map(staleProblem) }

  const mergeCandidates = plan.op === "merge" ? findMergeCandidates(plan, sources.map((source) => source.page)) : null
  const files = new FileChanges(project)
  let committed: CommitResult
  try {
    for (const edit of pageEdits.edits) files.write(edit.path, edit.after, edit.before)
    files.write(DOMAINS_FILE, domains.text, domains.before)
    for (const [path, text] of indexFiles) if (writes.includes(path)) files.write(path, text)
    for (const path of removals) files.remove(path)
    const message = buildActionCommitMessage("recut", planTitle(plan), pageEdits.edits.map((edit) => edit.path))
    committed = await commitPathsLocked(project, files.paths(), message)
  } catch (error) {
    if (error instanceof ChangedWhileRunning) return failed(project, files, staleProblem(error.path), false)
    // The lock stayed with another tool for the whole wait: a known state, not a bug. The commit did not start.
    if (error instanceof Error && error.message === GIT_LOCK_BUSY_MESSAGE) return failed(project, files, error.message, false)
    await failed(project, files, "", true)
    throw error
  }
  if (!committed.ok) return failed(project, files, committed.problem, true)

  // The commit is done. What follows must not undo it.
  const notes = [...changes.notes, ...pageEdits.notes]
  // A work wiki may name the domains of this wiki (ruling U21). It is a reading wiki when wiki.yaml says so or is missing.
  const reading = config.identity.role === "reading" ? libraryNote(plan, changes) : null
  if (reading !== null) notes.push(reading)
  if (plan.op !== "split") {
    const mapper = createMapper(plan)
    try {
      remapDismissedPairs(project, (domain) => mapper.map(domain, ""))
    } catch (error) {
      notes.push(`The dismissed fusion pairs in .llm-wiki/fusion-dismissed.json were not updated: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  return {
    ok: true,
    sha: committed.sha,
    pages: pageEdits.edits.map((edit) => edit.path),
    ...(mergeCandidates === null ? {} : { mergeCandidates }),
    ...(notes.length > 0 ? { notes } : {}),
  }
}

/**
 * Undo the recut and return the problem as the result of the command. When the commit may have staged the files, they are
 * taken out of the index first (under the git lock). Then every file goes back to what it was.
 */
async function failed(project: string, files: FileChanges, problem: string, staged: boolean): Promise<CommandResult> {
  const extra: string[] = []
  if (staged) {
    try {
      const unstaged = await unstagePathsLocked(project, files.paths())
      if (!unstaged.ok) extra.push(`the files could not be taken out of the index, run "git reset" for them: ${unstaged.problem}`)
    } catch (error) {
      extra.push(`the files could not be taken out of the index, run "git reset" for them: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  const unrestored = files.restore()
  if (unrestored.length > 0) extra.push(`these files could not be put back, restore them with git: ${unrestored.join(", ")}`)
  return { ok: false, problems: [...(problem === "" ? [] : [problem]), ...extra] }
}

/** The problem for a file that another tool changed while the recut ran. The skill `wiki-recut` names it. */
export function staleProblem(path: string): string {
  return `${path} changed while the recut ran, so nothing was written. Run the recut again.`
}

/** True when the file on disk is not the text that the recut read. */
function changedSince(project: string, path: string, before: string): boolean {
  try {
    return !readFileSync(resolveInProject(project, path)).equals(Buffer.from(before, "utf8"))
  } catch {
    return true
  }
}

/** A file changed between the read of the recut and the write of it. */
class ChangedWhileRunning extends Error {
  constructor(readonly path: string) {
    super(`${path} changed while the recut ran`)
  }
}

function readPlanText(option: string): { ok: true; text: string } | { ok: false; problem: string } {
  if (option.trimStart().startsWith("{")) return { ok: true, text: option }
  try {
    return { ok: true, text: readFileSync(option, "utf8") }
  } catch {
    return { ok: false, problem: `cannot read the plan file: ${option}` }
  }
}

/** The text of `domains.yaml` after the recut, read back with the parser and checked against the plan. */
function editedDomainsFile(
  project: string,
  plan: RecutPlan,
  changes: DomainChanges,
  lenses: readonly string[],
): { ok: true; text: string; before: string } | { ok: false; problem: string } {
  // A byte order mark stays where it is.
  const original = readFileSync(resolveInProject(project, DOMAINS_FILE), "utf8")
  const bom = original.startsWith("\uFEFF") ? "\uFEFF" : ""
  let text: string
  try {
    text = bom + editDomainsYaml(original.slice(bom.length), { renames: changes.renames, replacements: changes.replacements })
  } catch (error) {
    if (error instanceof DomainsFileError) return { ok: false, problem: `${error.message}. Change it by hand, or write the plan another way.` }
    throw error
  }
  const read = parseDomainsYaml(text.slice(bom.length), lenses)
  if (!read.ok) {
    const issues = read.issues.map((issue) => (issue.path === "" ? issue.message : `${issue.path}: ${issue.message}`))
    return { ok: false, problem: `${DOMAINS_FILE} would not be valid after the ${plan.op}: ${issues.join("; ")}` }
  }
  if (!sameDomains(read.value, changes.next)) {
    return { ok: false, problem: `${DOMAINS_FILE} would not read back as planned after the ${plan.op}, so nothing was changed` }
  }
  return { ok: true, text, before: original }
}

function sameDomains(a: DomainsConfig, b: DomainsConfig): boolean {
  const normal = (config: DomainsConfig): string =>
    JSON.stringify(Object.keys(config.domains).sort(compareText).map((name) => [name, config.domains[name]]))
  return normal(a) === normal(b)
}

function currentText(project: string, path: string): string | null {
  try {
    return readFileSync(resolveInProject(project, path), "utf8")
  } catch {
    return null
  }
}

/**
 * The files a recut writes or removes, with the bytes they had before the first change, so that a failed commit can put
 * them back. Paths are relative to the project folder.
 */
class FileChanges {
  private readonly originals = new Map<string, Buffer | null>()

  constructor(private readonly project: string) {}

  paths(): string[] {
    return [...this.originals.keys()]
  }

  /** Write `text`. With `before`, the file must still hold that text: another tool may have written it since it was read. */
  write(path: string, text: string, before?: string): void {
    this.mustBeInside(path)
    this.remember(path)
    if (before !== undefined && changedSince(this.project, path, before)) throw new ChangedWhileRunning(path)
    writeFileAtomic(resolveInProject(this.project, path), text)
  }

  remove(path: string): void {
    this.mustBeInside(path)
    this.remember(path)
    rmSync(resolveInProject(this.project, path), { force: true })
  }

  /** Put every file back. Returns the paths that could not be put back. */
  restore(): string[] {
    const failures: string[] = []
    for (const [path, bytes] of this.originals) {
      try {
        const full = resolveInProject(this.project, path)
        if (bytes === null) rmSync(full, { force: true })
        else writeFileAtomic(full, bytes)
      } catch {
        failures.push(path)
      }
    }
    this.originals.clear()
    return failures
  }

  /** The last guard before a write: nothing is written or removed through a link that leads out of the project. */
  private mustBeInside(path: string): void {
    const problem = insideProblem(this.project, path)
    if (problem !== null) throw new Error(`${path}: ${problem}`)
  }

  private remember(path: string): void {
    if (this.originals.has(path)) return
    try {
      this.originals.set(path, readFileSync(resolveInProject(this.project, path)))
    } catch {
      this.originals.set(path, null)
    }
  }
}
