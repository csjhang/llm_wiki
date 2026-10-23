/**
 * apply-template.test.ts — writes a project template to disk through a
 * `TemplateFs`. The tests use a fake `TemplateFs` that records every call
 * in order, so they check both what gets written and the order of the calls.
 */
import { describe, expect, it } from "vitest"
import { applyTemplate, type TemplateFs } from "@/lib/apply-template"
import { getTemplate, type WikiTemplate } from "@/lib/templates"

type Call = { op: "writeFile"; path: string; content: string } | { op: "createDirectory"; path: string }

function makeFakeFs() {
  const calls: Call[] = []
  const fs: TemplateFs = {
    async writeFile(path, content) {
      calls.push({ op: "writeFile", path, content })
    },
    async createDirectory(path) {
      calls.push({ op: "createDirectory", path })
    },
  }
  return { fs, calls }
}

function makeTemplate(overrides: Partial<WikiTemplate> = {}): WikiTemplate {
  return {
    id: "test",
    name: "Test",
    description: "Test template",
    icon: "T",
    schema: "SCHEMA",
    purpose: "PURPOSE",
    extraDirs: [],
    ...overrides,
  }
}

const indexOfCall = (calls: Call[], op: Call["op"], path: string) =>
  calls.findIndex((c) => c.op === op && c.path === path)

describe("applyTemplate", () => {
  it("writes schema, purpose, dirs, and files", async () => {
    const { fs, calls } = makeFakeFs()
    const template = makeTemplate({
      extraDirs: ["wiki/mechanisms"],
      files: { "lenses/ai.md": "x", "docs/glossary.md": "y" },
    })
    await applyTemplate("/p", template, fs)

    expect(calls).toContainEqual({ op: "writeFile", path: "/p/schema.md", content: "SCHEMA" })
    expect(calls).toContainEqual({ op: "writeFile", path: "/p/purpose.md", content: "PURPOSE" })
    expect(calls).toContainEqual({ op: "createDirectory", path: "/p/wiki/mechanisms" })
    expect(calls).toContainEqual({ op: "createDirectory", path: "/p/lenses" })
    expect(calls).toContainEqual({ op: "createDirectory", path: "/p/docs" })
    expect(calls).toContainEqual({ op: "writeFile", path: "/p/lenses/ai.md", content: "x" })
    expect(calls).toContainEqual({ op: "writeFile", path: "/p/docs/glossary.md", content: "y" })
  })

  it("creates parent folders before files and only once", async () => {
    const { fs, calls } = makeFakeFs()
    const template = makeTemplate({
      files: { "schema/page-types/a.md": "a", "schema/page-types/b.md": "b" },
    })
    await applyTemplate("/p", template, fs)

    const schemaDirs = calls.filter((c) => c.op === "createDirectory" && c.path === "/p/schema")
    const typeDirs = calls.filter((c) => c.op === "createDirectory" && c.path === "/p/schema/page-types")
    expect(schemaDirs).toHaveLength(1)
    expect(typeDirs).toHaveLength(1)

    const schemaDir = indexOfCall(calls, "createDirectory", "/p/schema")
    const typeDir = indexOfCall(calls, "createDirectory", "/p/schema/page-types")
    const writeA = indexOfCall(calls, "writeFile", "/p/schema/page-types/a.md")
    const writeB = indexOfCall(calls, "writeFile", "/p/schema/page-types/b.md")
    expect(schemaDir).toBeGreaterThanOrEqual(0)
    expect(schemaDir).toBeLessThan(typeDir)
    expect(typeDir).toBeLessThan(writeA)
    expect(typeDir).toBeLessThan(writeB)
  })

  it("creates a parent that is also an extraDir only once", async () => {
    const { fs, calls } = makeFakeFs()
    const template = makeTemplate({
      extraDirs: ["raw/sources/heptabase"],
      files: { "raw/notes.md": "n" },
    })
    await applyTemplate("/p", template, fs)

    // Extra dirs are created, and the parent "raw" of a template file is created at most once.
    expect(calls.filter((c) => c.op === "createDirectory" && c.path === "/p/raw")).toHaveLength(1)
    expect(calls.filter((c) => c.op === "createDirectory" && c.path === "/p/raw/sources/heptabase")).toHaveLength(1)
  })

  it("normalizes project path separators", async () => {
    const { fs, calls } = makeFakeFs()
    const template = makeTemplate({
      extraDirs: ["wiki/mechanisms"],
      files: { "schema/page-types/a.md": "a" },
    })
    await applyTemplate("C:\\w\\p\\", template, fs)

    expect(calls.length).toBeGreaterThan(0)
    for (const call of calls) {
      expect(call.path.startsWith("C:/w/p/")).toBe(true)
      expect(call.path).not.toContain("//")
      expect(call.path).not.toContain("\\")
    }
  })

  it("strips a trailing slash from a forward-slash project path", async () => {
    const { fs, calls } = makeFakeFs()
    await applyTemplate("/p/", makeTemplate(), fs)
    expect(calls.map((c) => c.path)).toEqual(["/p/schema.md", "/p/purpose.md"])
  })

  it("works for templates without files", async () => {
    const { fs, calls } = makeFakeFs()
    const general = getTemplate("general")
    await applyTemplate("/p", general, fs)
    expect(calls).toEqual([
      { op: "writeFile", path: "/p/schema.md", content: general.schema },
      { op: "writeFile", path: "/p/purpose.md", content: general.purpose },
    ])

    const research = getTemplate("research")
    const second = makeFakeFs()
    await applyTemplate("/p", research, second.fs)
    expect(second.calls.map((c) => `${c.op}:${c.path}`)).toEqual([
      "writeFile:/p/schema.md",
      "writeFile:/p/purpose.md",
      ...research.extraDirs.map((d) => `createDirectory:/p/${d}`),
    ])
  })
})

describe("applyTemplate output language", () => {
  const PURPOSE = "# Purpose\n\nOutput language:\n<!-- Write the language here. -->\n\n## Goal\n"

  const purposeWritten = async (outputLanguage?: string, purpose = PURPOSE): Promise<string> => {
    const { fs, calls } = makeFakeFs()
    await applyTemplate("/p", makeTemplate({ purpose }), fs, { outputLanguage })
    const call = calls.find((c) => c.op === "writeFile" && c.path === "/p/purpose.md")
    if (call?.op !== "writeFile") throw new Error("purpose.md was not written")
    return call.content
  }

  it("fills the empty Output language line and keeps the hint under it", async () => {
    expect(await purposeWritten("Traditional Chinese")).toBe(
      "# Purpose\n\nOutput language: Traditional Chinese\n<!-- Write the language here. -->\n\n## Goal\n",
    )
  })

  it("leaves purpose.md as it is for auto, an empty value, or no value", async () => {
    expect(await purposeWritten("auto")).toBe(PURPOSE)
    expect(await purposeWritten("")).toBe(PURPOSE)
    expect(await purposeWritten("  ")).toBe(PURPOSE)
    expect(await purposeWritten(undefined)).toBe(PURPOSE)
    const { fs, calls } = makeFakeFs()
    await applyTemplate("/p", makeTemplate({ purpose: PURPOSE }), fs)
    expect(calls).toContainEqual({ op: "writeFile", path: "/p/purpose.md", content: PURPOSE })
  })

  it("keeps a line that already has a value, and a purpose with no such line", async () => {
    const filled = "Output language: English\n"
    expect(await purposeWritten("Japanese", filled)).toBe(filled)
    expect(await purposeWritten("Japanese", "PURPOSE")).toBe("PURPOSE")
  })

  it("keeps CRLF line endings and does not treat $ in the value as a replacement pattern", async () => {
    expect(await purposeWritten("A$&B", "Output language:\r\n<!-- hint -->\r\n")).toBe(
      "Output language: A$&B\r\n<!-- hint -->\r\n",
    )
  })

  it("fills the line of the real Mechanism Wiki template, and writes its other files unchanged", async () => {
    const mechanism = getTemplate("mechanism")
    const { fs, calls } = makeFakeFs()
    await applyTemplate("/p", mechanism, fs, { outputLanguage: "Traditional Chinese" })
    const purpose = calls.find((c) => c.op === "writeFile" && c.path === "/p/purpose.md")
    expect(purpose?.op === "writeFile" ? purpose.content : "").toMatch(/^Output language: Traditional Chinese\r?$/m)
    expect(calls).toContainEqual({ op: "writeFile", path: "/p/schema.md", content: mechanism.schema })
    expect(calls).toContainEqual({ op: "writeFile", path: "/p/CLAUDE.md", content: mechanism.files?.["CLAUDE.md"] })
  })
})
