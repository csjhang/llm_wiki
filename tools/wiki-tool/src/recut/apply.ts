/**
 * `wiki-tool recut apply` - run a recut (rename, move, split, or merge of domains) and commit it once.
 *
 * `--project P --plan F` gives `{ ok: true, sha, pages, mergeCandidates?, notes? }`. `F` is the path of a JSON file with
 * the plan (see `plan.ts`), or the JSON itself when it starts with `{`. `pages` are the wiki pages that changed;
 * `sha` is the new commit. A merge always gives `mergeCandidates`: pairs of pages with the same slug that the merge
 * brings into one domain (the skill files them as `duplicate` reviews). `notes` are things to tell the user.
 *
 * The command checks everything before it writes anything: the plan against `domains.yaml` and the pages, the work
 * tree (ruling U2, `work-tree.ts`), and the text of every file that changes. Then it:
 * 1. rewrites `domains.yaml` as text (`domains-file.ts`), so comments stay;
 * 2. rewrites the domain keys of the pages and the Known instances lines (`page-edits.ts`), touching no other byte;
 * 3. rebuilds the domain index with the pure renderers of the app, writes the files that changed, and removes the index
 *    files of the domains that are gone;
 * 4. commits all of these files in one commit `recut: <op> <from> → <to> (<N> pages)`, where N counts the changed wiki
 *    pages only (ruling U7), through `commitPathsLocked`;
 * 5. after the commit, gives the dismissed fusion pairs the new names (ruling U5; not committed).
 *
 * When the commit fails, every file goes back to what it was and the command exits with the problem. Nothing is pushed.
 */
import { existsSync, readFileSync, rmSync } from "node:fs"
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
import { type CommitResult, commitPathsLocked, isGitWorkTree } from "../git"
import { GIT_LOCK_BUSY_MESSAGE } from "../git-lock"
import { type CommandResult, resolveInProject, writeFileAtomic } from "../io"
import { loadLintProject, notMechanismWiki, parseLintArgs } from "../lint/project"
import { compareText } from "../mirror-pages"
import { remapDismissedPairs } from "./dismissed"
import { DomainsFileError, editDomainsYaml } from "./domains-file"
import { computePageEdits } from "./page-edits"
import { createMapper, type DomainChanges, findMergeCandidates, parseRecutPlan, planDomains, planTitle, type RecutPlan, validateRecutPlan } from "./plan"
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

  const { sources, blocked } = readPageSources(project)
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

  const afterPath = new Map(pageEdits.edits.map((edit) => [edit.path, edit.after]))
  const indexed = sources.map((source) => indexedPageFromMarkdown(source.page.path, (afterPath.get(source.page.path) ?? source.text).replace(/^\uFEFF/, "")))
  const indexFiles: Array<[string, string]> = [
    [ROOT_INDEX_PATH, renderRootIndex(indexed, changes.next)],
    [MECHANISM_INDEX_PATH, renderMechanismIndex(indexed)],
    ...Object.keys(changes.next.domains)
      .sort(compareText)
      .map((domain): [string, string] => [domainIndexPath(domain), renderDomainIndex(domain, indexed)]),
  ]

  const mergeCandidates = plan.op === "merge" ? findMergeCandidates(plan, sources.map((source) => source.page)) : null
  const files = new FileChanges(project)
  let committed: CommitResult
  try {
    for (const edit of pageEdits.edits) files.write(edit.path, edit.after)
    files.write(DOMAINS_FILE, domains.text)
    for (const [path, text] of indexFiles) if (currentText(project, path) !== text) files.write(path, text)
    for (const domain of changes.removed) {
      if (existsSync(resolveInProject(project, domainIndexPath(domain)))) files.remove(domainIndexPath(domain))
    }
    const message = buildActionCommitMessage("recut", planTitle(plan), pageEdits.edits.map((edit) => edit.path))
    committed = await commitPathsLocked(project, files.paths(), message)
  } catch (error) {
    // The lock stayed with another tool for the whole wait: a known state, not a bug.
    if (error instanceof Error && error.message === GIT_LOCK_BUSY_MESSAGE) return failed(files, error.message)
    files.restore()
    throw error
  }
  if (!committed.ok) return failed(files, committed.problem)

  // The commit is done. What follows must not undo it.
  const notes = [...changes.notes, ...pageEdits.notes]
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

/** Put the files back and return the problem as the result of the command. */
function failed(files: FileChanges, problem: string): CommandResult {
  const unrestored = files.restore()
  const extra = unrestored.length > 0 ? [`these files could not be put back, restore them with git: ${unrestored.join(", ")}`] : []
  return { ok: false, problems: [problem, ...extra] }
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
): { ok: true; text: string } | { ok: false; problem: string } {
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
  return { ok: true, text }
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

  write(path: string, text: string): void {
    this.remember(path)
    writeFileAtomic(resolveInProject(this.project, path), text)
  }

  remove(path: string): void {
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

  private remember(path: string): void {
    if (this.originals.has(path)) return
    try {
      this.originals.set(path, readFileSync(resolveInProject(this.project, path)))
    } catch {
      this.originals.set(path, null)
    }
  }
}
