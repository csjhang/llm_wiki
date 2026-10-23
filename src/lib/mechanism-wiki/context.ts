/**
 * Mechanism wiki context.
 *
 * A project is a mechanism wiki if and only if `<project>/domains.yaml` exists.
 * `loadMechanismContext` reads the files that say what the wiki is (`wiki.yaml`),
 * which domains it has (`domains.yaml`), how each domain is read (`lenses/*.md`),
 * and what each page type looks like (`schema/page-types/*.md`). Ingest,
 * indexing, and review code call it once and pass the result along.
 */
import { listDirectory, readFile } from "@/commands/fs"
import { isAbsolutePath, normalizePath } from "@/lib/path-utils"
import { domainParent, KNOWN_LENSES, parseDomainsYaml } from "@/lib/wiki-config/domains"
import type { DomainsConfig } from "@/lib/wiki-config/domains"
import type { ConfigIssue } from "@/lib/wiki-config/types"
import { parseWikiYaml } from "@/lib/wiki-config/wiki-identity"
import type { WikiIdentity } from "@/lib/wiki-config/wiki-identity"
import { hasOwn } from "@/lib/wiki-config/yaml-util"
import type { FileNode } from "@/types/wiki"

export interface LensDoc {
  /** File stem of the lens file: `hardware` for `lenses/hardware.md`. */
  id: string
  /** The whole file. */
  text: string
  /**
   * The Fields, Evidence standard, and Strength rules sections only, in file
   * order, each with its heading. The Example section is left out: its fence
   * holds a sample page whose frontmatter and links look like a real page.
   */
  promptText: string
}

export interface MechanismContext {
  /** The path the caller passed in. */
  projectPath: string
  identity: WikiIdentity
  domains: DomainsConfig
  /** Every `lenses/*.md` file. The key is the file stem. */
  lenses: Record<string, LensDoc>
  /** Text of `schema/page-types/<type>.md`. The key is the file stem. */
  pageTypeRules: Record<string, string>
  /** The wiki's own path for a reading wiki. The resolved library path for a work wiki. */
  mechanismLibraryPath: string | null
  /**
   * Problems found while loading. They never stop the load. `path` starts with
   * the file name: `wiki.yaml`, `domains.yaml:domains.hardware.lens`, `lenses/x.md`.
   */
  configIssues: ConfigIssue[]
}

const DOMAINS_FILE = "domains.yaml"
const WIKI_FILE = "wiki.yaml"
const LENSES_DIR = "lenses"
const PAGE_TYPES_DIR = "schema/page-types"

/**
 * Load the mechanism context of a project. Returns null when the project has
 * no `domains.yaml`, which means it is not a mechanism wiki. A file that is
 * present but invalid does not throw: the problem goes to `configIssues` and
 * the value falls back to an empty or default one.
 */
export async function loadMechanismContext(projectPath: string): Promise<MechanismContext | null> {
  const base = normalizePath(projectPath).replace(/\/+$/, "")
  const at = (relative: string): string => `${base}/${relative}`

  const domainsText = await readOptional(at(DOMAINS_FILE))
  if (domainsText === null) return null

  const configIssues: ConfigIssue[] = []
  const [wikiText, lensFiles, pageTypeFiles] = await Promise.all([
    readOptional(at(WIKI_FILE)),
    listMarkdownFiles(at(LENSES_DIR)),
    listMarkdownFiles(at(PAGE_TYPES_DIR)),
  ])
  const [lensTexts, pageTypeTexts] = await Promise.all([
    readAll(lensFiles, LENSES_DIR, configIssues),
    readAll(pageTypeFiles, PAGE_TYPES_DIR, configIssues),
  ])

  const identity = resolveIdentity(wikiText, configIssues)

  const lenses = Object.fromEntries(
    lensTexts.map(({ stem, text }) => [stem, buildLensDoc(stem, text, configIssues)]),
  ) as Record<string, LensDoc>
  const pageTypeRules = Object.fromEntries(
    pageTypeTexts.map(({ stem, text }) => [stem, text]),
  ) as Record<string, string>

  // A lens file makes its stem a known lens, even when the file cannot be read.
  const knownLenses = [...new Set([...KNOWN_LENSES, ...lensFiles.map((file) => file.stem)])]
  const domains = resolveDomains(domainsText, knownLenses, configIssues)

  return {
    projectPath,
    identity,
    domains,
    lenses,
    pageTypeRules,
    mechanismLibraryPath: resolveLibraryPath(projectPath, identity),
    configIssues,
  }
}

/**
 * Lens of a domain. A domain that is not listed uses its nearest listed
 * ancestor: `hardware/async-circuits/handshakes` uses `hardware/async-circuits`.
 * Null when no ancestor is listed or the lens has no file.
 */
export function lensForDomain(ctx: MechanismContext, domain: string): LensDoc | null {
  let candidate: string | null = domain
  while (candidate !== null) {
    if (hasOwn(ctx.domains.domains, candidate)) {
      const lensId = ctx.domains.domains[candidate].lens
      return hasOwn(ctx.lenses, lensId) ? ctx.lenses[lensId] : null
    }
    candidate = domainParent(candidate)
  }
  return null
}

/** The `promptText` of a lens file. Exported for tests. */
export function extractLensPromptText(markdown: string): string {
  const picked: string[] = []
  const seen = new Set<string>()
  for (const section of splitLevelTwoSections(markdown)) {
    const name = normalizeHeadingName(section.heading)
    if (!PROMPT_SECTIONS.has(name) || seen.has(name)) continue
    seen.add(name)
    picked.push(section.lines.join("\n").trimEnd())
  }
  return picked.join("\n\n")
}

// --- files -------------------------------------------------------------

async function readOptional(path: string): Promise<string | null> {
  try {
    return await readFile(path)
  } catch {
    return null
  }
}

interface MarkdownFile {
  stem: string
  path: string
}

/** Direct `.md` children of a folder, sorted by name. A missing folder is empty. */
async function listMarkdownFiles(dir: string): Promise<MarkdownFile[]> {
  let nodes: FileNode[]
  try {
    nodes = await listDirectory(dir, { maxDepth: 1 })
  } catch {
    return []
  }
  return nodes
    .filter((node) => !node.is_dir && node.name.endsWith(".md") && node.name.length > ".md".length)
    .map((node) => ({ stem: node.name.slice(0, -".md".length), path: `${dir}/${node.name}` }))
    .sort((a, b) => (a.stem < b.stem ? -1 : a.stem > b.stem ? 1 : 0))
}

/** Read every file. One that cannot be read becomes an issue and is left out. */
async function readAll(
  files: MarkdownFile[],
  dirName: string,
  issues: ConfigIssue[],
): Promise<{ stem: string; text: string }[]> {
  const results = await Promise.all(
    files.map(async (file) => ({ file, text: await readOptional(file.path) })),
  )
  const loaded: { stem: string; text: string }[] = []
  for (const { file, text } of results) {
    if (text === null) {
      issues.push({ path: `${dirName}/${file.stem}.md`, message: "could not read the file" })
    } else {
      loaded.push({ stem: file.stem, text })
    }
  }
  return loaded
}

// --- config ------------------------------------------------------------

function defaultIdentity(): WikiIdentity {
  return { version: 1, id: "reading", role: "reading", mechanism_library: null }
}

function fileIssue(file: string, issue: ConfigIssue): ConfigIssue {
  return { path: issue.path === "" ? file : `${file}:${issue.path}`, message: issue.message }
}

function resolveIdentity(text: string | null, issues: ConfigIssue[]): WikiIdentity {
  if (text === null) {
    issues.push({
      path: WIKI_FILE,
      message: 'the file is missing; treating this wiki as a reading wiki with id "reading"',
    })
    return defaultIdentity()
  }
  const parsed = parseWikiYaml(text)
  if (parsed.ok) return parsed.value
  issues.push(...parsed.issues.map((issue) => fileIssue(WIKI_FILE, issue)))
  return defaultIdentity()
}

function resolveDomains(
  text: string,
  knownLenses: readonly string[],
  issues: ConfigIssue[],
): DomainsConfig {
  const parsed = parseDomainsYaml(text, knownLenses)
  if (parsed.ok) return parsed.value
  issues.push(...parsed.issues.map((issue) => fileIssue(DOMAINS_FILE, issue)))
  return { version: 1, domains: {} }
}

function buildLensDoc(id: string, text: string, issues: ConfigIssue[]): LensDoc {
  const promptText = extractLensPromptText(text)
  if (promptText === "") {
    issues.push({
      path: `${LENSES_DIR}/${id}.md`,
      message: "has no Fields, Evidence standard, or Strength rules section, so it adds nothing to a prompt",
    })
  }
  return { id, text, promptText }
}

// --- library path ------------------------------------------------------

function resolveLibraryPath(projectPath: string, identity: WikiIdentity): string | null {
  if (identity.role === "reading") return projectPath
  const library = identity.mechanism_library
  if (library === null) return null
  return isAbsolutePath(library) ? library : resolveRelativePath(projectPath, library)
}

/** `relative` against `base`: forward slashes, no `.` or empty segments, `..` applied. */
function resolveRelativePath(base: string, relative: string): string {
  const joined = normalizePath(base)
  // "/", "C:/", "//" (a UNC share), or "" for a relative base.
  const prefix = /^(?:[A-Za-z]:)?\/*/.exec(joined)?.[0] ?? ""
  const segments: string[] = []
  const parts = [...joined.slice(prefix.length).split("/"), ...normalizePath(relative).split("/")]
  for (const part of parts) {
    if (part === "" || part === ".") continue
    if (part !== "..") {
      segments.push(part)
    } else if (segments.length > 0 && segments[segments.length - 1] !== "..") {
      segments.pop()
    } else if (prefix === "") {
      segments.push("..")
    }
    // A rooted path stays at its root.
  }
  return prefix + segments.join("/")
}

// --- lens sections -----------------------------------------------------

/** Names of the lens sections that go into a prompt, as `normalizeHeadingName` gives them. */
const PROMPT_SECTIONS: ReadonlySet<string> = new Set(["fields", "evidence standard", "strength rules"])

interface LevelTwoSection {
  /** Text after `## `. */
  heading: string
  /** The heading line, then the body lines up to the next level-2 heading. */
  lines: string[]
}

/**
 * Split markdown into level-2 sections. A `## ` line inside a fenced code block
 * is not a heading. Text before the first level-2 heading belongs to no section.
 */
function splitLevelTwoSections(markdown: string): LevelTwoSection[] {
  const sections: LevelTwoSection[] = []
  let current: LevelTwoSection | null = null
  let fence: { char: string; length: number } | null = null

  for (const line of markdown.split(/\r?\n/)) {
    if (fence !== null) {
      if (closesFence(line, fence)) fence = null
    } else {
      fence = opensFence(line)
      const heading = fence === null ? /^##(?:[ \t]+(.*))?$/.exec(line) : null
      if (heading !== null) {
        current = { heading: heading[1] ?? "", lines: [] }
        sections.push(current)
      }
    }
    current?.lines.push(line)
  }
  return sections
}

/** The fence that `line` opens, or null. A backtick fence cannot have a backtick in its info string. */
function opensFence(line: string): { char: string; length: number } | null {
  const match = /^[ \t]*(`{3,}|~{3,})(.*)$/.exec(line)
  if (match === null) return null
  const char = match[1][0]
  if (char === "`" && match[2].includes("`")) return null
  return { char, length: match[1].length }
}

/** A closing fence uses the same character, at least as many times, and has nothing after it. */
function closesFence(line: string, fence: { char: string; length: number }): boolean {
  const match = /^[ \t]*(`{3,}|~{3,})[ \t]*$/.exec(line)
  return match !== null && match[1][0] === fence.char && match[1].length >= fence.length
}

/** Lowercase; drop a closing `##` run and one trailing ASCII or full-width colon. */
function normalizeHeadingName(heading: string): string {
  return heading
    .replace(/[ \t]+#+[ \t]*$/, "")
    .trim()
    .replace(/[:：]$/, "")
    .trim()
    .toLowerCase()
}
