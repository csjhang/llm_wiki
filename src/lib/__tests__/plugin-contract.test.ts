/**
 * plugin-contract.test.ts — contract for the llm-wiki Claude Code plugin.
 *
 * Reads the plugin files straight from the repo root. Later sub-projects add
 * skill folders under plugins/llm-wiki/skills/, and the frontmatter test below
 * covers every new folder without edits.
 */
import { execFileSync } from "node:child_process"
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import yaml from "js-yaml"
import { describe, expect, it } from "vitest"
import { findLongSentences } from "@/test-helpers/ste-check"

const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url))
const PLUGIN_DIR = join(REPO_ROOT, "plugins", "llm-wiki")
const SKILLS_DIR = join(PLUGIN_DIR, "skills")

function readJson(relativePath: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(REPO_ROOT, relativePath), "utf8")) as Record<string, unknown>
}

/**
 * SPDX id of the root LICENSE. The unmodified GPL-3.0 text always carries the
 * generic "or any later version" wording in its appendix. That wording does
 * not grant later versions to this program, so the id stays "-only".
 */
function licenseSpdxId(): string {
  const text = readFileSync(join(REPO_ROOT, "LICENSE"), "utf8")
  if (/GNU GENERAL PUBLIC LICENSE\s+Version 3,/.test(text)) return "GPL-3.0-only"
  throw new Error("Unrecognized root LICENSE")
}

function skillFolders(): string[] {
  if (!existsSync(SKILLS_DIR)) return []
  return readdirSync(SKILLS_DIR)
    .filter((entry) => statSync(join(SKILLS_DIR, entry)).isDirectory())
    .sort()
}

/** The Markdown files in the `reference` folder of a skill, if it has one. */
function referenceFiles(skillDir: string): string[] {
  const dir = join(skillDir, "reference")
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((entry) => entry.endsWith(".md"))
    .sort()
    .map((entry) => join(dir, entry))
}

function readFrontmatter(skillFile: string): Record<string, unknown> {
  const text = readFileSync(skillFile, "utf8")
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)
  if (!match) throw new Error(`No frontmatter in ${skillFile}`)
  const parsed = yaml.load(match[1])
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error(`Frontmatter is not a mapping in ${skillFile}`)
  }
  return parsed as Record<string, unknown>
}

describe("llm-wiki plugin contract", () => {
  it("marketplace lists the llm-wiki plugin", () => {
    const marketplace = readJson(".claude-plugin/marketplace.json") as {
      name: string
      plugins: Array<{ name: string; source: string }>
    }
    expect(marketplace.name).toBe("llm-wiki-mechanism")
    expect(marketplace.plugins).toHaveLength(1)
    expect(marketplace.plugins[0].name).toBe("llm-wiki")
    expect(marketplace.plugins[0].source).toBe("./plugins/llm-wiki")
    expect(statSync(join(REPO_ROOT, marketplace.plugins[0].source)).isDirectory()).toBe(true)
  })

  it("plugin manifest matches marketplace", () => {
    const manifest = readJson("plugins/llm-wiki/.claude-plugin/plugin.json") as {
      name: string
      version: string
      description: string
      license: string
    }
    expect(manifest.name).toBe("llm-wiki")
    expect(manifest.version).toMatch(/^\d+\.\d+\.\d+$/)
    expect(typeof manifest.description).toBe("string")
    expect(manifest.description.trim().length).toBeGreaterThan(0)
    expect(manifest.license).toBe(licenseSpdxId())
  })

  it("every skill has valid frontmatter", () => {
    const folders = skillFolders()
    expect(folders.length).toBeGreaterThan(0)
    for (const folder of folders) {
      const frontmatter = readFrontmatter(join(SKILLS_DIR, folder, "SKILL.md"))
      expect(frontmatter.name, `${folder}: name`).toBe(folder)
      expect(folder, `${folder}: folder name`).toMatch(/^wiki(-[a-z]+)*$/)
      expect(typeof frontmatter.description, `${folder}: description type`).toBe("string")
      const description = frontmatter.description as string
      expect(description.trim().length, `${folder}: description length`).toBeGreaterThan(0)
      expect(description.length, `${folder}: description max`).toBeLessThanOrEqual(1024)
    }
  })

  it("skill list includes wiki", () => {
    expect(statSync(join(SKILLS_DIR, "wiki")).isDirectory()).toBe(true)
  })

  it("every panel entry names an existing skill folder", () => {
    const panel = yaml.load(readFileSync(join(PLUGIN_DIR, "panel.yaml"), "utf8")) as {
      buttons: Array<{ skill: string }>
    }
    expect(panel.buttons.length).toBeGreaterThan(0)
    const folders = skillFolders()
    for (const button of panel.buttons) {
      expect(folders, `panel.yaml: ${button.skill}`).toContain(button.skill)
      expect(existsSync(join(SKILLS_DIR, button.skill, "SKILL.md")), `${button.skill}: SKILL.md`).toBe(true)
    }
  })

  it("every script that a SKILL.md names exists", () => {
    // A path is `<plugin dir>/scripts/x.mjs`, `<base>/scripts/x.mjs`, `<base>/../../scripts/x.mjs`,
    // or `scripts/x.mjs` (from the base directory of the skill).
    const reference = /(?:(<plugin dir>|<base>)\/)?((?:\.\.\/)*)scripts\/([A-Za-z0-9._-]+\.mjs)/g
    const named: string[] = []
    const missing: string[] = []
    for (const folder of skillFolders()) {
      const skillDir = join(SKILLS_DIR, folder)
      const text = readFileSync(join(skillDir, "SKILL.md"), "utf8")
      for (const match of text.matchAll(reference)) {
        const root = match[1] === "<plugin dir>" ? PLUGIN_DIR : skillDir
        const script = resolve(root, match[2], "scripts", match[3])
        named.push(`${folder}: ${match[0]}`)
        if (!existsSync(script)) missing.push(`${folder}: ${match[0]} -> ${script}`)
      }
    }
    // The guard fails when the pattern stops matching, so a rename cannot hide a missing script.
    expect(named.some((entry) => entry.includes("wiki-tool.mjs"))).toBe(true)
    expect(missing).toEqual([])
  })

  it("skill files and the plugin README keep sentences short", () => {
    const files = [
      ...skillFolders().map((folder) => join(SKILLS_DIR, folder, "SKILL.md")),
      ...skillFolders().flatMap((folder) => referenceFiles(join(SKILLS_DIR, folder))),
      join(PLUGIN_DIR, "README.md"),
    ]
    expect(files.length).toBeGreaterThan(1)
    for (const file of files) {
      expect(findLongSentences(file, readFileSync(file, "utf8")), file).toEqual([])
    }
  })

  it("the manifest description and the README claim only what the skills do", () => {
    const manifest = readJson("plugins/llm-wiki/.claude-plugin/plugin.json") as { description: string }
    const readme = readFileSync(join(PLUGIN_DIR, "README.md"), "utf8")
    const cases: Array<[label: string, text: string]> = [
      ["plugin.json description", manifest.description],
      ["README.md", readme],
    ]
    for (const [label, text] of cases) {
      // No skill ingests a source or queries the wiki. The app ingests.
      expect(text, label).not.toMatch(/ingest sources|query the wiki|cause-and-effect/i)
      // The jobs of the skills: sync, fuse, lint, recut, undo.
      for (const job of ["Heptabase", "fuse", "hypothes", "lint", "recut", "undo"]) {
        expect(text.toLowerCase(), `${label}: ${job}`).toContain(job.toLowerCase())
      }
    }
    // The README says who ingests, and it uses the glossary meaning of mechanism.
    expect(readme).toMatch(/app ingests/i)
    expect(readme).toContain("a structure that repeats across domains")
  })

  it("no template file is git-ignored", () => {
    const paths = ["templates/mechanism-wiki/docs/glossary.md", "templates/mechanism-wiki/AGENTS.md"]
    let ignored = ""
    try {
      ignored = execFileSync("git", ["check-ignore", "--no-index", ...paths], {
        cwd: REPO_ROOT,
        encoding: "utf8",
      })
    } catch (error) {
      // Exit code 1 means no path is ignored. That is the passing case.
      if ((error as { status?: number }).status !== 1) throw error
    }
    expect(ignored.trim()).toBe("")
  })
})
