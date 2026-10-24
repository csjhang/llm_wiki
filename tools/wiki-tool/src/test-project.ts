/**
 * Test helpers for the commands that read a wiki project: plan-down and record.
 *
 * makeProject writes a project folder with wiki.yaml, heptabase.yaml, and the given files.
 * Ids are placeholders (00000000-0000-4000-8000-0000000000NN) and titles are generic.
 * Not part of the bundle: only test files import it.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

export function id(n: number): string {
  return `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`
}

/** The property ids of the fixture database (fixtures/read_database.json), by heptabase.yaml key. */
export const PROPERTY_IDS = {
  domain: id(42),
  page_type: id(45),
  wiki: id(50),
  status: id(54),
  wiki_page: id(57),
  last_synced: id(58),
  hypothesis_status: id(59),
  strength: id(64),
}

const tempDirs: string[] = []

export function removeProjects(): void {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop() as string, { recursive: true, force: true })
  }
}

export function writeProjectFile(project: string, relativePath: string, text: string): void {
  const path = join(project, relativePath)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text)
}

export interface ProjectOptions {
  /** The `id` of wiki.yaml. The fixture database has the options reading, work, and test. */
  wikiId?: string
  /** Leave heptabase.yaml out. */
  noHeptabaseYaml?: boolean
}

/** A project folder with the config files and `files` (project-relative path to text). */
export function makeProject(files: Record<string, string> = {}, options: ProjectOptions = {}): string {
  const project = mkdtempSync(join(tmpdir(), "wiki-tool-mirror-"))
  tempDirs.push(project)
  writeProjectFile(project, "wiki.yaml", `version: 1\nid: ${options.wikiId ?? "test"}\nrole: reading\n`)
  if (!options.noHeptabaseYaml) {
    const properties = Object.entries(PROPERTY_IDS).map(([key, value]) => `  ${key}: ${value}`)
    const lines = ["version: 1", "roots:", `  - ${id(12)}`, "tags:", `  ingest: ${id(5)}`, `  mirror: ${id(4)}`]
    writeProjectFile(project, "heptabase.yaml", [...lines, "properties:", ...properties, ""].join("\n"))
  }
  for (const [path, text] of Object.entries(files)) writeProjectFile(project, path, text)
  return project
}

/** A wiki page: the frontmatter fields (strings and lists of strings) and a body. */
export function pageText(fields: Record<string, string | string[]>, body = "Body text."): string {
  const lines = ["---"]
  for (const [key, value] of Object.entries(fields)) {
    lines.push(`${key}: ${Array.isArray(value) ? `[${value.map((item) => JSON.stringify(item)).join(", ")}]` : JSON.stringify(value)}`)
  }
  lines.push("---", "", body, "")
  return lines.join("\n")
}
