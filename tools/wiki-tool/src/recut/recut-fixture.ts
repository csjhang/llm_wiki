/**
 * Test helpers for the `recut` commands: a mechanism wiki that is a git repository with one commit, a small tree of
 * placeholder domains, and pages that use them in every way a recut must follow (domain, also, hypothesis keys, Known
 * instances lines). The domain index files are in the first commit too, so a recut writes only what it changes.
 * Domains, slugs, and titles are placeholders. Not part of the bundle: only test files import it.
 */
import { readFileSync, readdirSync, statSync } from "node:fs"
import { join, relative } from "node:path"
import { type IndexedPage, domainIndexPath, indexedPageFromMarkdown, MECHANISM_INDEX_PATH, renderDomainIndex, renderMechanismIndex, renderRootIndex, ROOT_INDEX_PATH } from "@/lib/mechanism-wiki/domain-index-render"
import { parseDomainsYaml } from "@/lib/wiki-config/domains"
import { runCli } from "../cli"
import { commit, git, initRepo } from "../lint/lint-fixture"
import { makeProject, writeProjectFile } from "../test-project"

export const ALPHA = "example/alpha"
export const CHILD = "example/alpha/child"
export const BETA = "example/beta"
export const ZETA = "example/zeta"

export const DOMAINS_YAML = [
  "# Domain list of the recut test wiki.",
  "version: 1",
  "domains:",
  "  # The first domain.",
  `  ${ALPHA}:`,
  "    lens: hardware",
  "    description: Alpha domain # kept",
  "    whiteboards: []",
  `  ${CHILD}:`,
  "    lens: hardware",
  "    description: Child of alpha",
  `  ${BETA}:`,
  "    lens: business",
  "    description: Beta domain",
  `  ${ZETA}:`,
  "    lens: physics",
  "    description: Zeta domain",
  "",
].join("\n")

/** A concept page of alpha. Its frontmatter has comments, quotes, and spacing that a recut must keep. */
export const ONE = [
  "---",
  "# Written by hand; the comment stays.",
  'title:   "One: a placeholder"   # quoted',
  "type: concept",
  `domain: ${ALPHA}   # the domain`,
  "sources: [ 'raw/sources/a.md' ,  \"raw/sources/b.md\" ]",
  "created: 2026-10-01",
  "---",
  "",
  "# One",
  "",
  "Body with trailing spaces.  ",
  "",
].join("\n")

export const TWO = ["---", "type: concept", "title: Two", `domain: ${CHILD}`, "---", "", "# Two", ""].join("\n")

/** An entity page of beta that also lists alpha. */
export const THREE = ["---", "type: entity", "title: Three", `domain: ${BETA}`, `also: [${ALPHA}]`, "---", "", "# Three", ""].join("\n")

/** A hypothesis page from alpha to beta. */
export const IDEA = [
  "---",
  "type: hypothesis",
  "title: Idea",
  `from_domain: ${ALPHA}`,
  `to_domain: ${BETA}`,
  "status: draft",
  "updated: 2026-10-01",
  "---",
  "",
  "# Idea",
  "",
].join("\n")

export const FOUR = ["---", "type: concept", "title: Four", `domain: ${ZETA}`, "---", "", "# Four", ""].join("\n")

/** A mechanism page with two instance lines. */
export const HANDSHAKE = [
  "---",
  "type: mechanism",
  "title: Handshake",
  "---",
  "",
  "# Handshake",
  "",
  "## Parts",
  "",
  `- [[one]] (${ALPHA}): not an instance line, it is in another section`,
  "",
  "## Known instances",
  "",
  `- [[one]] (${ALPHA}): request and acknowledge`,
  `- [[three]] (${BETA}): order and delivery`,
  "",
].join("\n")

export const PAGE_FILES: Record<string, string> = {
  "wiki/concepts/one.md": ONE,
  "wiki/concepts/two.md": TWO,
  "wiki/entities/three.md": THREE,
  "wiki/hypotheses/idea.md": IDEA,
  "wiki/concepts/four.md": FOUR,
  "wiki/mechanisms/handshake.md": HANDSHAKE,
  "wiki/log.md": "# Log\n\n## [2026-10-01] ingest | placeholder\n",
}

export interface RecutRepoOptions {
  /** A folder of the repository that holds the wiki. The repository is above the project. */
  prefix?: string
  /** Leave `.llm-wiki/` out of the ignore list, so that a careless `git add -A` would take it. */
  ignoreLlmWiki?: boolean
}

/**
 * A wiki project that is a git repository with one commit of everything: `domains.yaml`, the pages of `PAGE_FILES`,
 * the given `files` (a `null` value leaves a page out), and the domain index files for exactly those pages. Returns the
 * project folder, which is a folder of the repository when `prefix` is given.
 */
export function makeRecutRepo(files: Record<string, string | null> = {}, options: RecutRepoOptions = {}): string {
  const prefix = options.prefix === undefined ? "" : `${options.prefix}/`
  const all: Record<string, string> = { "domains.yaml": DOMAINS_YAML, ...PAGE_FILES }
  for (const [path, text] of Object.entries(files)) {
    if (text === null) delete all[path]
    else all[path] = text
  }
  const root = makeProject({}, { noHeptabaseYaml: true })
  for (const [path, text] of Object.entries(all)) writeProjectFile(root, `${prefix}${path}`, text)
  const project = prefix === "" ? root : join(root, options.prefix as string)
  for (const [path, text] of Object.entries(indexFiles(project))) writeProjectFile(project, path, text)
  initRepo(root, { ignoreLlmWiki: options.ignoreLlmWiki })
  commit(root, "initial")
  return project
}

/** The domain index files for the pages and the domain list that are in the project folder now. */
export function indexFiles(project: string): Record<string, string> {
  const domains = parseDomainsYaml(readFileSync(join(project, "domains.yaml"), "utf8"))
  if (!domains.ok) throw new Error("the fixture domains.yaml is not valid")
  const pages: IndexedPage[] = markdownFiles(join(project, "wiki"))
    .map((file) => relative(project, file).replace(/\\/g, "/"))
    .filter((path) => !["wiki/index.md", "wiki/log.md", "wiki/overview.md"].includes(path) && !path.startsWith("wiki/indexes/"))
    .map((path) => indexedPageFromMarkdown(path, readFileSync(join(project, path), "utf8")))
  const files: Record<string, string> = {
    [ROOT_INDEX_PATH]: renderRootIndex(pages, domains.value),
    [MECHANISM_INDEX_PATH]: renderMechanismIndex(pages),
  }
  for (const domain of Object.keys(domains.value.domains)) files[domainIndexPath(domain)] = renderDomainIndex(domain, pages)
  return files
}

function markdownFiles(folder: string): string[] {
  const found: string[] = []
  for (const name of readdirSync(folder)) {
    const path = join(folder, name)
    if (statSync(path).isDirectory()) found.push(...markdownFiles(path))
    else if (name.endsWith(".md")) found.push(path)
  }
  return found
}

export function read(project: string, path: string): string {
  return readFileSync(join(project, path), "utf8")
}

/** The status of the work tree, as `git status --porcelain` prints it. Empty for a clean tree. */
export function status(project: string): string {
  return git(project, "status", "--porcelain")
}

/** The files of the last commit with their status letters, in path order: `M domains.yaml`. */
export function lastCommitFiles(project: string): string[] {
  return git(project, "show", "--name-status", "--no-renames", "--format=", "HEAD")
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => line.replace(/\t/, " "))
    .sort((a, b) => (a.slice(2) < b.slice(2) ? -1 : a.slice(2) > b.slice(2) ? 1 : 0))
}

export function lastSubject(project: string): string {
  return git(project, "log", "-1", "--format=%s").trim()
}

export function lastBody(project: string): string {
  return git(project, "log", "-1", "--format=%b").trim()
}

export interface RecutRun<T> {
  exitCode: number
  output: T
}

export interface ApplyOutput {
  ok: boolean
  sha?: string | null
  pages?: string[]
  mergeCandidates?: Array<{ a: string; b: string }>
  notes?: string[]
  problems?: string[]
}

/** Run `wiki-tool recut <command>` for a project. */
export async function runRecut<T = ApplyOutput>(command: string, project: string, ...rest: string[]): Promise<RecutRun<T>> {
  const result = await runCli(["recut", command, "--project", project, ...rest])
  return { exitCode: result.exitCode, output: result.output as unknown as T }
}

/** Run `recut apply` with the plan as inline JSON. */
export function applyPlan(project: string, plan: unknown): Promise<RecutRun<ApplyOutput>> {
  return runRecut("apply", project, "--plan", JSON.stringify(plan))
}
