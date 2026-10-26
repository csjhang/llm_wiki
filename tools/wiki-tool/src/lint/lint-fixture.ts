/**
 * Test helpers for the `lint` commands: a mechanism wiki that is a git repository, with a domain list of
 * three domains (not in alphabetical order), and helpers to commit changes and to read the lint output.
 * Slugs, domains, and titles are placeholders. Not part of the bundle: only test files import it.
 */
import { execFileSync } from "node:child_process"
import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { localDate } from "@/lib/mechanism-wiki/lint-structure"
import { runCli } from "../cli"
import { makeProject, pageText, writeProjectFile } from "../test-project"

/** The domains of the test wiki, in file order. */
export const DOMAINS = ["hardware/async-circuits", "business/inventory", "physics/waves"] as const
export const [HARDWARE, BUSINESS, PHYSICS] = DOMAINS

export const DOMAINS_YAML = [
  "version: 1",
  "domains:",
  ...DOMAINS.flatMap((domain) => [`  ${domain}:`, `    lens: ${domain.split("/")[0]}`, `    description: Placeholder domain ${domain}`]),
  "",
].join("\n")

/** A wiki project with `domains.yaml` and the given files. Not a git repository yet. */
export function makeWiki(files: Record<string, string> = {}): string {
  return makeProject({ "domains.yaml": DOMAINS_YAML, ...files }, { noHeptabaseYaml: true })
}

/** The identity of the test commits, and no git config of the machine (global or system). */
const GIT_ENV = {
  GIT_AUTHOR_NAME: "T",
  GIT_AUTHOR_EMAIL: "t@example.com",
  GIT_COMMITTER_NAME: "T",
  GIT_COMMITTER_EMAIL: "t@example.com",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
}

export function git(project: string, ...args: string[]): string {
  return execFileSync("git", ["-C", project, ...args], { encoding: "utf8", env: { ...process.env, ...GIT_ENV } })
}

/**
 * Make the project a git repository. The folder `.llm-wiki/` is ignored, as in a real project, unless
 * `ignoreLlmWiki` is false: then a careless `git add -A` would take the marker, and a test can see it.
 */
export function initRepo(project: string, options: { ignoreLlmWiki?: boolean } = {}): void {
  git(project, "init", "--quiet")
  git(project, "config", "commit.gpgsign", "false")
  if (options.ignoreLlmWiki !== false) writeFileSync(join(project, ".git", "info", "exclude"), ".llm-wiki/\n")
}

/** A wiki that is a git repository with no commit. */
export function makeRepo(files: Record<string, string> = {}, options: { ignoreLlmWiki?: boolean } = {}): string {
  const project = makeWiki(files)
  initRepo(project, options)
  return project
}

/** Write the files (a `null` value deletes the file), commit everything, and return the new HEAD. */
export function commit(project: string, subject: string, files: Record<string, string | null> = {}): string {
  for (const [path, text] of Object.entries(files)) {
    const full = join(project, path)
    if (text === null) {
      rmSync(full)
    } else {
      mkdirSync(dirname(full), { recursive: true })
      writeFileSync(full, text)
    }
  }
  git(project, "add", "-A")
  git(project, "commit", "--quiet", "--allow-empty", "--no-verify", "-m", subject)
  return head(project)
}

export function head(project: string): string {
  return git(project, "rev-parse", "HEAD").trim()
}

/** Write the semantic lint marker. */
export function setMarker(project: string, commitSha: string): void {
  writeProjectFile(project, ".llm-wiki/semantic-lint.json", JSON.stringify({ commit: commitSha, at: "2026-10-01T00:00:00.000Z" }))
}

/** A page with frontmatter fields and a short body. */
export function page(fields: Record<string, string | string[]>, body?: string): string {
  return pageText(fields, body)
}

/** A concept page in `domain`. */
export function conceptPage(domain: string, extra: Record<string, string | string[]> = {}): string {
  return page({ type: "concept", title: "Placeholder concept", domain, ...extra })
}

/** A draft hypothesis page from `from` to `to`, updated today (so it is not stale). */
export function hypothesisPage(from: string, to: string, extra: Record<string, string | string[]> = {}): string {
  return page({
    type: "hypothesis",
    title: "Placeholder hypothesis",
    from_domain: from,
    to_domain: to,
    status: "draft",
    updated: localDate(),
    ...extra,
  })
}

/** The local date of today, as `YYYY-MM-DD`. The same function as the lint uses (tested in lint-structure.test.ts). */
export { localDate }

export function mechanismPage(extra: Record<string, string | string[]> = {}): string {
  return page({ type: "mechanism", title: "Placeholder mechanism", ...extra })
}

export interface LintRun<T> {
  exitCode: number
  output: T
}

/** Run `wiki-tool lint <command>` for a project. */
export async function runLint<T = Record<string, unknown>>(command: string, project: string, ...rest: string[]): Promise<LintRun<T>> {
  const result = await runCli(["lint", command, "--project", project, ...rest])
  return { exitCode: result.exitCode, output: result.output as T }
}
