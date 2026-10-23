/**
 * mechanism-template-contract.test.ts — contract for templates/mechanism-wiki/.
 *
 * Reads the template files straight from the repo root. AI agents read these
 * files in fresh sessions, so the tests check that the entry files point to
 * real files, that the config examples parse, and that sentences stay short.
 * Later sub-project 0 tasks add more checks to this file.
 */
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { findLongSentences } from "@/test-helpers/ste-check"
import { parseDomainsYaml } from "@/lib/wiki-config/domains"
import { parseHeptabaseYaml } from "@/lib/wiki-config/heptabase-config"
import {
  HYPOTHESIS_SECTIONS,
  MECHANISM_SECTIONS,
  type SectionHeading,
} from "@/lib/wiki-config/section-headings"

const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url))
const TEMPLATE_DIR = join(REPO_ROOT, "templates", "mechanism-wiki")

/** The exact `##` headings that docs/glossary.md must contain, in this order. */
const GLOSSARY_TERMS = [
  "Wiki",
  "Reading wiki",
  "Work wiki",
  "Source",
  "Article",
  "Note",
  "Domain",
  "Lens",
  "Mechanism",
  "Instance",
  "Fusion",
  "Hypothesis page",
  "Relation",
  "Analogy",
  "Stack",
  "Analogy strength",
  "Mirror card",
  "Card map",
  "Review queue",
] as const

/** The seven page types and their directories (Global Constraints). */
const PAGE_TYPES: Array<[type: string, directory: string]> = [
  ["source", "wiki/sources/"],
  ["entity", "wiki/entities/"],
  ["concept", "wiki/concepts/"],
  ["comparison", "wiki/comparisons/"],
  ["query", "wiki/queries/"],
  ["mechanism", "wiki/mechanisms/"],
  ["hypothesis", "wiki/hypotheses/"],
]

/** The seven rule files, one per page type. */
const RULE_FILES = PAGE_TYPES.map(([type]) => `schema/page-types/${type}.md`)

/** Sections that every rule file has, in this order. */
const RULE_FILE_SECTIONS = ["Purpose", "Location", "Frontmatter", "Rules", "Example", "Checklist"] as const

/** Only these two rule files have a `## Sections` table, between Frontmatter and Rules. */
const RULE_FILES_WITH_SECTIONS = ["mechanism", "hypothesis"]

/** Files written for AI agents. Every sentence in them must stay short. */
const AI_FACING_FILES = [
  "CLAUDE.md",
  "AGENTS.md",
  "schema.md",
  "docs/glossary.md",
  "schema/writing-rules.md",
  ...RULE_FILES,
]

function readTemplate(relativePath: string): string {
  return readFileSync(join(TEMPLATE_DIR, relativePath), "utf8")
}

/** Lines of `markdown` with their fence state. A fence line itself counts as inside a fence. */
function linesOutsideFences(markdown: string): Array<{ line: string; inFence: boolean }> {
  let open = false
  return markdown.split(/\r?\n/).map((line) => {
    if (/^\s*(```|~~~)/.test(line)) {
      open = !open
      return { line, inFence: true }
    }
    return { line, inFence: open }
  })
}

/**
 * Body of a `## <heading>` section, up to the next `## ` heading. Throws when missing.
 * A `## ` line inside a fenced code block is not a heading.
 */
function sectionBody(markdown: string, heading: string): string {
  const lines = linesOutsideFences(markdown)
  const start = lines.findIndex((entry) => !entry.inFence && entry.line.trim() === `## ${heading}`)
  if (start === -1) throw new Error(`Missing section "## ${heading}"`)
  const rest = lines.slice(start + 1)
  const end = rest.findIndex((entry) => !entry.inFence && /^## /.test(entry.line))
  return (end === -1 ? rest : rest.slice(0, end)).map((entry) => entry.line).join("\n")
}

/** Text of every `## ` heading outside fenced code blocks, in file order. */
function secondLevelHeadings(markdown: string): string[] {
  return linesOutsideFences(markdown)
    .filter((entry) => !entry.inFence && /^## /.test(entry.line))
    .map((entry) => entry.line.slice(3).trim())
}

/** First backticked span of each numbered list item. */
function numberedItems(body: string): Array<{ line: string; path: string }> {
  const items: Array<{ line: string; path: string }> = []
  for (const line of body.split(/\r?\n/)) {
    if (!/^\d+\.\s/.test(line)) continue
    const path = /`([^`]+)`/.exec(line)?.[1]
    if (path === undefined) throw new Error(`Read order item has no backticked path: ${line}`)
    items.push({ line, path })
  }
  return items
}

describe("mechanism template: glossary", () => {
  it("glossary defines every term", () => {
    const text = readTemplate("docs/glossary.md")
    const headings = secondLevelHeadings(text)
    for (const term of GLOSSARY_TERMS) {
      expect(headings, `heading "${term}"`).toContain(term)
      const paragraph = sectionBody(text, term).trim()
      expect(paragraph.length, `definition of "${term}"`).toBeGreaterThan(0)
    }
    const order = GLOSSARY_TERMS.map((term) => headings.indexOf(term))
    expect(order, "terms keep the contract order").toEqual([...order].sort((a, b) => a - b))
  })

  it("glossary Domain agrees with schema.md: mechanism and hypothesis pages have no single domain", () => {
    const domain = sectionBody(readTemplate("docs/glossary.md"), "Domain")
    expect(domain).toMatch(/except a mechanism page or a hypothesis page/)
  })
})

describe("mechanism template: entry files", () => {
  it("CLAUDE.md read order points to real files", () => {
    const items = numberedItems(sectionBody(readTemplate("CLAUDE.md"), "Read order"))
    expect(items.map((item) => item.path)).toEqual([
      "docs/glossary.md",
      "purpose.md",
      "schema.md",
      "domains.yaml",
      "schema/writing-rules.md",
      "schema/page-types/<type>.md",
      "lenses/<lens>.md",
      "heptabase.yaml",
    ])
    // Only concrete paths are checked. A path with <...> names a folder that a
    // later task creates, and heptabase.yaml is optional: wiki-hepta init writes it.
    const concrete = items.filter((item) => !item.path.includes("<") && !/\(optional\)/i.test(item.line))
    expect(concrete.length).toBeGreaterThanOrEqual(5)
    for (const item of concrete) {
      expect(existsSync(join(TEMPLATE_DIR, item.path)), item.path).toBe(true)
    }
  })

  it("CLAUDE.md read order explains the placeholders", () => {
    const body = sectionBody(readTemplate("CLAUDE.md"), "Read order")
    const lineOf = (path: string): string => body.split(/\r?\n/).find((line) => line.includes(`\`${path}\``)) ?? ""
    expect(lineOf("schema/page-types/<type>.md")).toContain("`type:`")
    expect(lineOf("lenses/<lens>.md")).toContain("`lens:`")
    expect(lineOf("lenses/<lens>.md")).toContain("`lenses:`")
  })

  it("CLAUDE.md rules name the raw/ exception and the output language source", () => {
    const rules = sectionBody(readTemplate("CLAUDE.md"), "Rules")
    expect(rules).toContain("`wiki-sync`")
    expect(rules).toContain("raw/sources/heptabase/")
    expect(rules).toContain("`Output language:`")
    expect(rules).toContain("`purpose.md`")
  })

  it("CLAUDE.md rules section has at most five lines", () => {
    const rules = sectionBody(readTemplate("CLAUDE.md"), "Rules")
      .split(/\r?\n/)
      .filter((line) => line.trim() !== "")
    expect(rules.length).toBeGreaterThan(0)
    expect(rules.length).toBeLessThanOrEqual(5)
  })

  it("AGENTS.md points to CLAUDE.md", () => {
    const lines = readTemplate("AGENTS.md").trimEnd().split(/\r?\n/)
    expect(lines.length).toBeLessThanOrEqual(5)
    expect(lines.join("\n")).toContain("CLAUDE.md")
  })

  it("purpose.md has an empty Output language line with a hint", () => {
    const text = readTemplate("purpose.md")
    expect(text).toMatch(/^Output language:[ \t]*\r?\n<!--[\s\S]+?-->/m)
  })

  it("purpose.md has the four headings and a hint under each", () => {
    const text = readTemplate("purpose.md")
    expect(text).toMatch(/^# Purpose\r?\n\s*<!--[\s\S]+?-->/)
    for (const heading of ["Goal", "Key questions", "Out of scope"]) {
      expect(sectionBody(text, heading), heading).toMatch(/<!--[\s\S]+?-->/)
    }
  })
})

describe("mechanism template: schema.md", () => {
  it("schema.md lists the seven page types", () => {
    const rows = sectionBody(readTemplate("schema.md"), "Page types")
      .split(/\r?\n/)
      .filter((line) => line.trim().startsWith("|"))
      .map((line) => line.split("|").slice(1, -1).map((cell) => cell.replace(/`/g, "").trim()))
    expect(rows[0]).toEqual(["Type", "Directory", "Purpose"])
    const dataRows = rows.slice(2) // skip the header and the separator row
    expect(dataRows.map((row) => [row[0], row[1]])).toEqual(PAGE_TYPES)
    for (const row of dataRows) expect(row[2].length, `purpose of ${row[0]}`).toBeGreaterThan(0)
  })

  it("schema.md names the output language source", () => {
    const text = readTemplate("schema.md")
    expect(text).toContain("`Output language:`")
    expect(text).toContain("`purpose.md`")
  })

  it("schema.md bare-slug rule covers only related and instances; sources keep file names", () => {
    const body = sectionBody(readTemplate("schema.md"), "Cross-references")
    expect(body).toContain('`sources: ["paper.md"]`')
    expect(body).toMatch(/`related:`.*`instances:`/)
    expect(body).not.toMatch(/in frontmatter/i)
  })

  it("schema.md defines ingest and mechanism library", () => {
    const text = readTemplate("schema.md")
    expect(text).toMatch(/An ingest is /)
    expect(text).toMatch(/The mechanism library is /)
  })

  it("schema.md has the sections that the ingest prompt relies on", () => {
    expect(secondLevelHeadings(readTemplate("schema.md"))).toEqual([
      "Page types",
      "File names",
      "Frontmatter",
      "Domains",
      "Mechanisms",
      "Index and log",
      "Cross-references",
      "Contradictions",
    ])
  })
})

describe("mechanism template: config files", () => {
  it("domains.yaml is valid", () => {
    const result = parseDomainsYaml(readTemplate("domains.yaml"))
    expect(result.issues).toEqual([])
    expect(result.ok).toBe(true)
  })

  it("heptabase example is valid", () => {
    const result = parseHeptabaseYaml(readTemplate("heptabase.example.yaml"))
    expect(result.issues).toEqual([])
    expect(result.ok).toBe(true)
  })

  it("heptabase example uses only placeholder ids", () => {
    const ids = readTemplate("heptabase.example.yaml").match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g)
    expect(ids?.length).toBeGreaterThan(0)
    for (const id of ids ?? []) expect(id).toMatch(/^00000000-0000-4000-8000-0000000000\d\d$/)
  })
})

describe("mechanism template: writing rules", () => {
  it("writing-rules.md ends with the source section", () => {
    const text = readTemplate("schema/writing-rules.md")
    const headings = secondLevelHeadings(text)
    expect(headings[headings.length - 1]).toBe("Source of these rules")
    const body = sectionBody(text, "Source of these rules")
    expect(body).toContain("ASD-STE100")
    expect(body).toMatch(/copyright/i)
    expect(body).toContain("ASD-STE100, Issue 9 (2025)")
    expect(body).toContain(".gitignore")
    expect(body).toMatch(/never commit/i)
  })

  it("writing-rules.md explains the example marks and what a sources entry is", () => {
    const text = readTemplate("schema/writing-rules.md")
    expect(text).toContain("壞")
    expect(text).toMatch(/壞.*marks a bad example/)
    expect(text).toMatch(/好.*marks a good example/)
    expect(sectionBody(text, "7. Cite a source for every claim")).toContain("source file")
  })
})

/** Cells of every table row in `body`, without the separator row. Backticks are removed. */
function tableRows(body: string): string[][] {
  return body
    .split(/\r?\n/)
    .filter((line) => line.trim().startsWith("|"))
    .map((line) => line.split("|").slice(1, -1).map((cell) => cell.replace(/`/g, "").trim()))
    .filter((cells) => !cells.every((cell) => /^:?-+:?$/.test(cell)))
}

describe("mechanism template: page-type rule files", () => {
  it("every page type has a rule file", () => {
    for (const file of RULE_FILES) {
      expect(existsSync(join(TEMPLATE_DIR, file)), file).toBe(true)
    }
  })

  it("rule files have the required sections", () => {
    for (const [type] of PAGE_TYPES) {
      const text = readTemplate(`schema/page-types/${type}.md`)
      expect(text.split(/\r?\n/)[0], `${type} title`).toBe(`# Page type: ${type}`)
      const expected: string[] = [...RULE_FILE_SECTIONS]
      if (RULE_FILES_WITH_SECTIONS.includes(type)) expected.splice(3, 0, "Sections")
      expect(secondLevelHeadings(text), type).toEqual(expected)
    }
  })

  it("rule files name their directory in the Location section", () => {
    for (const [type, directory] of PAGE_TYPES) {
      const text = readTemplate(`schema/page-types/${type}.md`)
      expect(sectionBody(text, "Location"), type).toContain(`\`${directory}\``)
    }
  })

  it("every Frontmatter table has the columns Field, Required, and Rule and lists the app fields", () => {
    for (const [type] of PAGE_TYPES) {
      const rows = tableRows(sectionBody(readTemplate(`schema/page-types/${type}.md`), "Frontmatter"))
      expect(rows[0], type).toEqual(["Field", "Required", "Rule"])
      const fields = rows.slice(1).map((row) => row[0])
      for (const field of ["type", "title", "tags", "related", "sources", "created", "updated"]) {
        expect(fields, `${type} field ${field}`).toContain(field)
      }
    }
  })

  it("Frontmatter fields follow schema.md for each page type", () => {
    const fieldsOf = (type: string): string[] =>
      tableRows(sectionBody(readTemplate(`schema/page-types/${type}.md`), "Frontmatter"))
        .slice(1)
        .map((row) => row[0])
    for (const type of ["source", "entity", "concept", "comparison", "query"]) {
      expect(fieldsOf(type), type).toContain("domain")
      expect(fieldsOf(type), type).toContain("also")
    }
    expect(fieldsOf("source")).toContain("source_kind")
    for (const type of ["mechanism", "hypothesis"]) {
      expect(fieldsOf(type), type).not.toContain("domain")
    }
    expect(fieldsOf("mechanism")).toEqual(expect.arrayContaining(["lenses", "instances"]))
    expect(fieldsOf("hypothesis")).toEqual(
      expect.arrayContaining([
        "mechanism",
        "from_domain",
        "to_domain",
        "relation",
        "strength",
        "status",
        "heptabase_whiteboard",
      ]),
    )
  })

  it("mechanism and hypothesis sections match the code", () => {
    const cases: Array<[file: string, expected: readonly SectionHeading[]]> = [
      ["schema/page-types/mechanism.md", MECHANISM_SECTIONS],
      ["schema/page-types/hypothesis.md", HYPOTHESIS_SECTIONS],
    ]
    for (const [file, expected] of cases) {
      const rows = tableRows(sectionBody(readTemplate(file), "Sections"))
      expect(rows[0], file).toEqual(["Key", "English", "Traditional Chinese", "Simplified Chinese"])
      expect(rows.slice(1), file).toEqual(expected.map((s) => [s.key, s.en, s.zhHant, s.zhHans]))
    }
  })

  it("examples use the defined headings", () => {
    const cases: Array<[file: string, sections: readonly SectionHeading[]]> = [
      ["schema/page-types/mechanism.md", MECHANISM_SECTIONS],
      ["schema/page-types/hypothesis.md", HYPOTHESIS_SECTIONS],
    ]
    for (const [file, sections] of cases) {
      const example = sectionBody(readTemplate(file), "Example")
      const headings = example.split(/\r?\n/).filter((line) => /^## /.test(line)).map((line) => line.trim())
      for (const section of sections) {
        expect(headings, `${file} ${section.key}`).toContain(`## ${section.zhHant}`)
      }
    }
  })

  it("every Example block is one fenced Traditional Chinese page with frontmatter", () => {
    for (const [type] of PAGE_TYPES) {
      const example = sectionBody(readTemplate(`schema/page-types/${type}.md`), "Example")
      const fence = example.match(/^(```|~~~)/m)
      expect(fence, `${type} example fence`).not.toBeNull()
      expect(example, `${type} example frontmatter`).toMatch(new RegExp(`^type: ${type}$`, "m"))
      expect(example, `${type} example language`).toMatch(/[\u4e00-\u9fff]/)
    }
  })

  it("rule files do not use an example UUID outside the placeholder form", () => {
    for (const file of RULE_FILES) {
      const ids = readTemplate(file).match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g) ?? []
      for (const id of ids) expect(id, file).toMatch(/^00000000-0000-4000-8000-0000000000\d\d$/)
    }
  })

  it("mechanism.md and hypothesis.md settle the cross-wiki rules", () => {
    const mechanism = readTemplate("schema/page-types/mechanism.md")
    expect(mechanism).toMatch(/Only a reading wiki writes mechanism pages/)
    const hypothesis = readTemplate("schema/page-types/hypothesis.md")
    expect(hypothesis).toContain("reading:<slug>")
    expect(hypothesis).toMatch(/lens of `to_domain`/)
    expect(hypothesis).toMatch(/lens of `from_domain`/)
  })
})

describe("mechanism template: sentence length", () => {
  it("AI-facing files keep sentences short", () => {
    for (const file of AI_FACING_FILES) {
      expect(findLongSentences(file, readTemplate(file)), file).toEqual([])
    }
  })
})

describe("ste-check", () => {
  const words26 = Array.from({ length: 26 }, (_, i) => `word${i + 1}`).join(" ")
  const words25 = Array.from({ length: 25 }, (_, i) => `word${i + 1}`).join(" ")

  it("ste-check unit: reports a 26-word sentence", () => {
    const found = findLongSentences("a.md", `Short one.\n${words26}.\n`)
    expect(found).toEqual([{ file: "a.md", line: 2, words: 26, sentence: `${words26}.` }])
  })

  it("ste-check unit: accepts a 25-word sentence", () => {
    expect(findLongSentences("a.md", `${words25}.\n`)).toEqual([])
  })

  it("ste-check unit: skips code fences, table rows, and CJK lines", () => {
    expect(findLongSentences("a.md", "```\n" + words26 + ".\n```\n")).toEqual([])
    expect(findLongSentences("a.md", "~~~ts\n" + words26 + ".\n~~~\n")).toEqual([])
    expect(findLongSentences("a.md", `| ${words26}. | b |\n`)).toEqual([])
    expect(findLongSentences("a.md", `${words26} 中文.\n`)).toEqual([])
  })

  it("ste-check unit: skips frontmatter and headings", () => {
    expect(findLongSentences("a.md", `---\ndescription: ${words26}.\n---\nShort.\n`)).toEqual([])
    expect(findLongSentences("a.md", `# ${words26}\n`)).toEqual([])
  })

  it("ste-check unit: checks text after a code fence ends", () => {
    const found = findLongSentences("a.md", "```\nx\n```\n" + words26 + ".\n")
    expect(found.map((violation) => violation.line)).toEqual([4])
  })

  it("ste-check unit: splits on . ! ? and ;", () => {
    const text = `${words25.split(" ").slice(0, 20).join(" ")}; ${words25.split(" ").slice(0, 20).join(" ")}! Ok?\n`
    expect(findLongSentences("a.md", text)).toEqual([])
  })

  it("ste-check unit: does not split on a dot inside a file name", () => {
    const text = `Read schema.md and purpose.md and ${words25.split(" ").slice(0, 21).join(" ")}.\n`
    expect(findLongSentences("a.md", text).map((violation) => violation.words)).toEqual([26])
  })

  it("ste-check unit: joins a sentence that wraps over lines", () => {
    const half = words26.split(" ")
    const text = `${half.slice(0, 13).join(" ")}\n${half.slice(13).join(" ")}.\n`
    expect(findLongSentences("a.md", text)).toEqual([
      { file: "a.md", line: 1, words: 26, sentence: `${words26}.` },
    ])
  })

  it("ste-check unit: treats each list item as its own sentence", () => {
    const text = `- ${words25.split(" ").slice(0, 15).join(" ")}\n- ${words25.split(" ").slice(0, 15).join(" ")}\n1. ${words25.split(" ").slice(0, 15).join(" ")}\n`
    expect(findLongSentences("a.md", text)).toEqual([])
  })

  it("ste-check unit: honors a custom limit", () => {
    expect(findLongSentences("a.md", "One two three.\n", 2).map((violation) => violation.words)).toEqual([3])
  })
})
