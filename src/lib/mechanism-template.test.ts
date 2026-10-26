/**
 * mechanism-template.test.ts — the "Mechanism Wiki" project template.
 *
 * The template files live in `templates/mechanism-wiki/` and are bundled into
 * the app with `import.meta.glob`. These tests check that every file loads,
 * that the bundled text equals the file on disk, and that the template is
 * registered in the template list.
 */
import { readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { MECHANISM_TEMPLATE_FILES, mechanismTemplate } from "@/lib/mechanism-template"
import { getTemplate, templates } from "@/lib/templates"

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url))
const TEMPLATE_DIR = join(REPO_ROOT, "templates", "mechanism-wiki")

describe("mechanism template files", () => {
  it("loads all template files", () => {
    const keys = Object.keys(MECHANISM_TEMPLATE_FILES)
    for (const expected of [
      "CLAUDE.md",
      "AGENTS.md",
      "schema.md",
      "purpose.md",
      "domains.yaml",
      "wiki.yaml",
      "heptabase.example.yaml",
      "docs/glossary.md",
      "schema/writing-rules.md",
      "schema/page-types/mechanism.md",
      "lenses/hardware.md",
      ".claude/settings.json",
      "README.md",
    ]) {
      expect(keys).toContain(expected)
    }
    for (const key of keys) {
      expect(key.startsWith("/")).toBe(false)
      expect(key).not.toContain("\\")
    }
  })

  it("file content matches disk", () => {
    const onDisk = readFileSync(join(TEMPLATE_DIR, "docs", "glossary.md"), "utf-8")
    expect(onDisk.length).toBeGreaterThan(0)
    expect(MECHANISM_TEMPLATE_FILES["docs/glossary.md"]).toBe(onDisk)
  })

  it("loads the files of a dot folder: .claude/settings.json is in the bundle and equals the file", () => {
    const onDisk = readFileSync(join(TEMPLATE_DIR, ".claude", "settings.json"), "utf-8")
    expect(onDisk.length).toBeGreaterThan(0)
    expect(MECHANISM_TEMPLATE_FILES[".claude/settings.json"]).toBe(onDisk)
  })

  it("bundles every file of the template folder, dot folders included", () => {
    const walk = (directory: string): string[] =>
      readdirSync(join(TEMPLATE_DIR, directory), { withFileTypes: true }).flatMap((entry) => {
        const relative = directory === "" ? entry.name : `${directory}/${entry.name}`
        return entry.isDirectory() ? walk(relative) : [relative]
      })
    expect(Object.keys(MECHANISM_TEMPLATE_FILES).sort()).toEqual(walk("").sort())
  })

  it("loads yaml files as raw text", () => {
    const onDisk = readFileSync(join(TEMPLATE_DIR, "domains.yaml"), "utf-8")
    expect(MECHANISM_TEMPLATE_FILES["domains.yaml"]).toBe(onDisk)
  })
})

describe("mechanism template definition", () => {
  it("template is registered", () => {
    expect(getTemplate("mechanism").id).toBe("mechanism")
    expect(templates.map((t) => t.id)).toContain("mechanism")
    expect(getTemplate("mechanism")).toBe(mechanismTemplate)
  })

  it("has the specified display fields and directories", () => {
    expect(mechanismTemplate.name).toBe("Mechanism Wiki")
    expect(mechanismTemplate.icon).toBe("🧩")
    expect(mechanismTemplate.description).toBe(
      "Cross-domain mechanisms, fusion hypotheses, and Heptabase sync",
    )
    expect(mechanismTemplate.extraDirs).toEqual([
      "wiki/mechanisms",
      "wiki/hypotheses",
      "wiki/indexes",
      "raw/sources/heptabase",
    ])
  })

  it("uses schema.md and purpose.md for the schema and purpose fields", () => {
    expect(mechanismTemplate.schema).toBe(MECHANISM_TEMPLATE_FILES["schema.md"])
    expect(mechanismTemplate.purpose).toBe(MECHANISM_TEMPLATE_FILES["purpose.md"])
  })

  it("schema and purpose are not duplicated in files", () => {
    const files = mechanismTemplate.files ?? {}
    expect(files).not.toHaveProperty("schema.md")
    expect(files).not.toHaveProperty("purpose.md")
    expect(Object.keys(files).length).toBe(Object.keys(MECHANISM_TEMPLATE_FILES).length - 2)
  })
})
