/**
 * What the `lint` commands read from a mechanism wiki project, and the option handling they share.
 *
 * `loadLintProject` reads `wiki.yaml`, `domains.yaml`, and, in a work wiki, the `domains.yaml` of the reading wiki
 * (`mechanism_library`). It fills the same config problems as the app (`runMechanismStructuralLint` in
 * `src/lib/mechanism-wiki/lint-run.ts`, ruling U14): each problem is text that names its file, and
 * `configProblemText` builds it. A problem never throws. The reading of pages is in `readWikiPages`.
 */
import { existsSync, readFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { isDomainIndexPath } from "@/lib/mechanism-wiki/domain-index-render"
import { type ConfigProblemSource, configProblemText } from "@/lib/mechanism-wiki/lint-structure"
import { type DomainsConfig, parseDomainsYaml } from "@/lib/wiki-config/domains"
import type { ConfigIssue } from "@/lib/wiki-config/types"
import { DEFAULT_LINT_THRESHOLDS, parseWikiYaml, type WikiIdentity } from "@/lib/wiki-config/wiki-identity"
import { type ArgSpec, parseArgs } from "../args"
import { knownLenses } from "../cmd-snapshot"
import { type CommandResult, isDirectory } from "../io"

const DOMAINS_FILE = "domains.yaml"
const WIKI_FILE = "wiki.yaml"
const UNREADABLE_MESSAGE = "could not read the file"
const MISSING_WIKI_MESSAGE = 'the file is missing; treating this wiki as a reading wiki with id "reading"'

/** The pages that the app keeps in `wiki/`. They are no pages of the wiki. */
const NON_PAGE_PATHS: ReadonlySet<string> = new Set(["wiki/index.md", "wiki/log.md", "wiki/overview.md"])

export interface LintProject {
  /** `wiki.yaml`. The default reading identity when the file is missing or not valid. */
  identity: WikiIdentity
  /** `domains.yaml` of this wiki. Empty when the file is not valid. */
  domains: DomainsConfig
  /** `domains.yaml` of the reading wiki. Null for a reading wiki, and when the file is missing or not valid. */
  libraryDomains: DomainsConfig | null
  /** Every config problem, as text for `StructureInput.configProblems`. */
  configProblems: string[]
  /**
   * The problems after which the list of domains is not reliable: all of `configProblems` but the one for a missing
   * `wiki.yaml`, which is a plain reading wiki. `changed-domains` and `batch` need the list, so they stop on these.
   */
  blockingProblems: string[]
}

/**
 * The project at `project`, or null when it has no `domains.yaml`: it is not a mechanism wiki. A file that is
 * missing, cannot be read, or is not valid is a config problem, not an error.
 */
export function loadLintProject(project: string): LintProject | null {
  const root = resolve(project)
  if (!existsSync(join(root, DOMAINS_FILE))) return null

  const configProblems: string[] = []
  const blockingProblems: string[] = []
  const report = (issues: ConfigIssue[], source: ConfigProblemSource, blocking = true): void => {
    for (const issue of issues) {
      const text = configProblemText(issue, source)
      configProblems.push(text)
      if (blocking) blockingProblems.push(text)
    }
  }

  const wiki = readIdentity(root)
  report(wiki.issues, "this", wiki.status === "invalid")
  const own = readDomains(root)
  report(own.issues, "this")

  let libraryDomains: DomainsConfig | null = null
  if (wiki.identity.role === "work" && wiki.identity.mechanism_library !== null) {
    const library = resolve(root, wiki.identity.mechanism_library.replace(/\\/g, "/"))
    const found = readDomains(library)
    if (found.exists) {
      libraryDomains = found.domains
      report(found.issues, "library")
    } else {
      report([{ path: DOMAINS_FILE, message: `the file is missing at ${library.replace(/\\/g, "/")}` }], "library")
    }
  }
  return { identity: wiki.identity, domains: own.domains ?? { version: 1, domains: {} }, libraryDomains, configProblems, blockingProblems }
}

/** The lint thresholds and the role of a wiki without `wiki.yaml`. */
function defaultIdentity(): WikiIdentity {
  return { version: 1, id: "reading", role: "reading", mechanism_library: null, lint: { ...DEFAULT_LINT_THRESHOLDS } }
}

/** The text of a file without a byte order mark. Null when the file is missing; undefined when it cannot be read. */
function readText(path: string): string | null | undefined {
  if (!existsSync(path)) return null
  try {
    return readFileSync(path, "utf8").replace(/^﻿/, "")
  } catch {
    return undefined
  }
}

/** An issue of `file`, with the file name at the start of its path (as the app does). */
function fileIssue(file: string, issue: ConfigIssue): ConfigIssue {
  return { path: issue.path === "" ? file : `${file}:${issue.path}`, message: issue.message }
}

function readIdentity(root: string): { identity: WikiIdentity; status: "ok" | "missing" | "invalid"; issues: ConfigIssue[] } {
  const text = readText(join(root, WIKI_FILE))
  if (text === null) {
    return { identity: defaultIdentity(), status: "missing", issues: [{ path: WIKI_FILE, message: MISSING_WIKI_MESSAGE }] }
  }
  if (text === undefined) {
    return { identity: defaultIdentity(), status: "invalid", issues: [{ path: WIKI_FILE, message: UNREADABLE_MESSAGE }] }
  }
  const parsed = parseWikiYaml(text)
  if (parsed.ok) return { identity: parsed.value, status: "ok", issues: [] }
  return { identity: defaultIdentity(), status: "invalid", issues: parsed.issues.map((issue) => fileIssue(WIKI_FILE, issue)) }
}

/** `domains.yaml` in the wiki folder `root`. `domains` is null when the file is missing or not valid. */
function readDomains(root: string): { exists: boolean; domains: DomainsConfig | null; issues: ConfigIssue[] } {
  const text = readText(join(root, DOMAINS_FILE))
  if (text === null) return { exists: false, domains: null, issues: [] }
  if (text === undefined) return { exists: true, domains: null, issues: [{ path: DOMAINS_FILE, message: UNREADABLE_MESSAGE }] }
  const parsed = parseDomainsYaml(text, knownLenses(root))
  if (parsed.ok) return { exists: true, domains: parsed.value, issues: [] }
  return { exists: true, domains: null, issues: parsed.issues.map((issue) => fileIssue(DOMAINS_FILE, issue)) }
}

// --- domains and pages --------------------------------------------------

/** The domains of this wiki, in the order of `domains.yaml`. */
export function ownDomains(project: LintProject): string[] {
  return Object.keys(project.domains.domains)
}

/** The domains of the reading wiki that this wiki does not list, in its order. Empty in a reading wiki. */
export function libraryOnlyDomains(project: LintProject): string[] {
  if (project.identity.role !== "work" || project.libraryDomains === null) return []
  const own = new Set(ownDomains(project))
  return Object.keys(project.libraryDomains.domains).filter((domain) => !own.has(domain))
}

/** True for the path of a page of the wiki: a file under `wiki/` that is not one of the pages of the app. */
export function isPagePath(path: string): boolean {
  const key = path.replace(/\\/g, "/").toLowerCase()
  return key.startsWith("wiki/") && key.endsWith(".md") && !isDomainIndexPath(key) && !NON_PAGE_PATHS.has(key)
}

// --- options -------------------------------------------------------------

/** The options of a lint command: `--project` and the extra `values`. */
export type LintArgs = { ok: true; project: string; values: Record<string, string> } | { ok: false; result: CommandResult }

/**
 * Parse the options of a lint command. `--project` is required and must be a folder. A problem comes back as the
 * result that the command returns.
 */
export function parseLintArgs(args: string[], extraValues: readonly string[] = [], required: readonly string[] = []): LintArgs {
  const spec: ArgSpec = { values: ["project", ...extraValues] }
  const { parsed, problems } = parseArgs(args, spec)
  for (const name of ["project", ...required]) {
    if (parsed.values[name] === undefined) problems.push(`missing option: --${name}`)
  }
  const project = parsed.values.project
  if (problems.length > 0 || project === undefined) return { ok: false, result: { ok: false, problems } }
  if (!isDirectory(project)) return { ok: false, result: { ok: false, problems: [`project folder not found: ${project}`] } }
  return { ok: true, project, values: parsed.values }
}

/** The result of a project that has no `domains.yaml`. */
export function notMechanismWiki(project: string): CommandResult {
  return { ok: false, problems: [`not a mechanism wiki: ${DOMAINS_FILE} is missing in ${project}`] }
}
