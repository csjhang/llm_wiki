/**
 * mechanism-template-contract.test.ts — contract for templates/mechanism-wiki/.
 *
 * Reads the template files straight from the repo root. AI agents read these
 * files in fresh sessions, so the tests check that the entry files point to
 * real files, that the config examples parse, and that sentences stay short.
 * Later sub-project 0 tasks add more checks to this file.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { findLongSentences } from "@/test-helpers/ste-check"
import { KNOWN_LENSES, parseDomainsYaml } from "@/lib/wiki-config/domains"
import { parseHeptabaseYaml } from "@/lib/wiki-config/heptabase-config"
import { parseWikiYaml } from "@/lib/wiki-config/wiki-identity"
import {
  HYPOTHESIS_SECTIONS,
  MECHANISM_SECTIONS,
  findSection,
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

/** The one sentence that says when a claim counts as sourced. Controller ruling R12. */
const COUNTING_SENTENCE =
  "A claim counts as sourced when its section has at least one `[[<source-page-slug>]]` link that supports it."

/** The exact form of a known-instance line, in every language. Controller ruling R13. */
const INSTANCE_LINE_FORM = "`- [[<slug>]] (<domain>): <local term>`"

/** The four lens files, one per known lens. */
const LENS_FILES = KNOWN_LENSES.map((id) => `lenses/${id}.md`)

/** The `## ` sections of a lens file, in order. */
const LENS_SECTIONS = ["Purpose", "Fields", "Evidence standard", "Strength rules", "Example"] as const

/** A lens explains every mechanism section except Known instances. These are the `###` headings of its Fields section. */
const LENS_FIELDS = MECHANISM_SECTIONS.filter((section) => section.key !== "instances").map((section) => section.en)

/** The three analogy strength levels, in the order of the lens Strength rules section. */
const STRENGTH_LEVELS = ["surface", "structural", "mathematical"] as const

/**
 * Controller ruling R16, stack readings of the strength levels. Every lens (Strength rules)
 * and hypothesis.md (Rules) must carry these phrases.
 */
const STACK_PHRASES = [
  "only a general dependency is known",
  "each upper-layer part maps to named base-layer components",
  "the equations or the trade-off curve of the base layer define the behavior of the upper layer",
]

/** Controller ruling R16, what evidence decides. Every lens (Evidence standard) and hypothesis.md must carry these phrases. */
const STATUS_PHRASES = ["evidence from the top two ranks", "stays open", "`testing` at most", "at least one row"]

/** Words that describe what parts exchange. A Parts line gives a role and must not use them. */
const EXCHANGE_WORDS = ["傳遞", "送到", "交給", "付費", "收費", "通往", "帶出", "相加", "輸出"]

/** Files written for AI agents. Every sentence in them must stay short. */
const AI_FACING_FILES = [
  "CLAUDE.md",
  "AGENTS.md",
  "schema.md",
  "docs/glossary.md",
  "schema/writing-rules.md",
  ...RULE_FILES,
  ...LENS_FILES,
]

function readTemplate(relativePath: string): string {
  return readFileSync(join(TEMPLATE_DIR, relativePath), "utf8")
}

/** Paths, relative to the template folder, of every `.md` file under it. */
function templateMarkdownFiles(directory = ""): string[] {
  return readdirSync(join(TEMPLATE_DIR, directory), { withFileTypes: true }).flatMap((entry) => {
    const relative = directory === "" ? entry.name : `${directory}/${entry.name}`
    if (entry.isDirectory()) return templateMarkdownFiles(relative)
    return entry.name.endsWith(".md") ? [relative] : []
  })
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

describe("mechanism template: term alignment", () => {
  it("glossary Mechanism and schema.md Mechanisms name the sections with the heading words, in order", () => {
    const names = LENS_FIELDS.map((field) => field.toLowerCase())
    expect(names).toEqual(["parts", "flows", "constraints and trade-offs", "why it works", "failure conditions"])
    const cases: Array<[label: string, body: string]> = [
      ["docs/glossary.md Mechanism", sectionBody(readTemplate("docs/glossary.md"), "Mechanism")],
      ["schema.md Mechanisms", sectionBody(readTemplate("schema.md"), "Mechanisms")],
    ]
    for (const [label, body] of cases) {
      let from = 0
      for (const name of names) {
        const at = body.indexOf(name, from)
        expect(at, `${label} names "${name}" after the previous section`).toBeGreaterThanOrEqual(0)
        from = at + name.length
      }
      // One term, one meaning: the old words "components" and "flow" are gone.
      expect(body, label).not.toMatch(/\bcomponents?\b/i)
      expect(body, label).not.toMatch(/\bflow\b/i)
    }
  })

  it("a lens explains each field: no template file says \"what each part means\"", () => {
    // "Parts" is one section name. A lens explains each field, that is, each section.
    for (const file of templateMarkdownFiles()) {
      expect(readTemplate(file), file).not.toMatch(/each part\b[^.]*\bmeans?\b/i)
    }
    const cases: Array<[file: string, section: string]> = [
      ["docs/glossary.md", "Lens"],
      ["schema.md", "Mechanisms"],
      ["schema/page-types/mechanism.md", "Purpose"],
    ]
    for (const [file, section] of cases) {
      const body = sectionBody(readTemplate(file), section)
      expect(body, `${file} ${section}`).toMatch(/what each field\b[^.]*\bmeans\b/)
      expect(body, `${file} ${section} defines a field`).toMatch(/A field is one of (?:the six|these|those) sections/)
    }
  })
})

describe("mechanism template: entry files", () => {
  it("CLAUDE.md read order points to real files", () => {
    const items = numberedItems(sectionBody(readTemplate("CLAUDE.md"), "Read order"))
    expect(items.map((item) => item.path)).toEqual([
      "docs/glossary.md",
      "purpose.md",
      "wiki.yaml",
      "schema.md",
      "domains.yaml",
      "schema/writing-rules.md",
      "schema/page-types/<type>.md",
      "lenses/<lens>.md",
      "heptabase.yaml",
    ])
    // Only concrete paths are checked here. A path with <...> is checked by the
    // placeholder test below, and heptabase.yaml is optional: wiki-hepta init writes it.
    const concrete = items.filter((item) => !item.path.includes("<") && !/\(optional\)/i.test(item.line))
    expect(concrete.length).toBeGreaterThanOrEqual(5)
    for (const item of concrete) {
      expect(existsSync(join(TEMPLATE_DIR, item.path)), item.path).toBe(true)
    }
  })

  it("every <...> placeholder path in the CLAUDE.md read order names a folder that exists in the template", () => {
    const items = numberedItems(sectionBody(readTemplate("CLAUDE.md"), "Read order"))
    const placeholders = items.filter((item) => item.path.includes("<"))
    expect(placeholders.map((item) => item.path)).toEqual(["schema/page-types/<type>.md", "lenses/<lens>.md"])
    for (const item of placeholders) {
      // The folder is everything before the path segment that holds the placeholder.
      const folder = item.path.slice(0, Math.max(0, item.path.lastIndexOf("/", item.path.indexOf("<"))))
      const directory = join(TEMPLATE_DIR, folder)
      expect(existsSync(directory) && statSync(directory).isDirectory(), `${item.path} needs the folder ${folder}/`).toBe(true)
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

  it("wiki.yaml is valid", () => {
    const result = parseWikiYaml(readTemplate("wiki.yaml"))
    expect(result.issues).toEqual([])
    expect(result.ok).toBe(true)
    if (!result.ok) return
    // The template is a reading wiki. A work wiki sets role: work and a library path.
    expect(result.value).toEqual({ version: 1, id: "reading", role: "reading", mechanism_library: null })
  })

  it("heptabase example holds Heptabase settings only: wiki identity lives in wiki.yaml", () => {
    const text = readTemplate("heptabase.example.yaml")
    expect(text).not.toMatch(/^wiki_id:/m)
    expect(text).not.toMatch(/^mechanism_library:/m)
    expect(text).toContain("`id` in `wiki.yaml`")
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

/** A parsed `## Example` block: the page inside the fence, split into frontmatter, intro, and sections. */
interface ExamplePage {
  /** Text between the two `---` lines. */
  frontmatter: string
  /** Raw file names in the `sources` field. */
  sourceFiles: string[]
  /** Page text after the frontmatter. */
  body: string
  /** Lines between the `# ` title and the first `## ` heading, trimmed. */
  intro: string
  /** Level-2 sections in order: heading text and body. */
  sections: Array<{ heading: string; body: string }>
}

function parseExample(type: string): ExamplePage {
  return parseExampleBlock(type, sectionBody(readTemplate(`schema/page-types/${type}.md`), "Example"))
}

/** Parse the `## Example` body of a rule file or a lens file. `label` names the file in error messages. */
function parseExampleBlock(label: string, example: string): ExamplePage {
  const fenced = /^```markdown\r?\n([\s\S]*?)\r?\n```/m.exec(example)
  if (fenced === null) throw new Error(`${label}: Example has no markdown fence`)
  const parts = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/.exec(fenced[1])
  if (parts === null) throw new Error(`${label}: Example has no frontmatter`)
  const [, frontmatter, body] = parts
  const sourcesLine = /^sources: \[(.*)\]$/m.exec(frontmatter)?.[1] ?? ""
  const sourceFiles = [...sourcesLine.matchAll(/"([^"]+)"/g)].map((match) => match[1])
  const lines = body.split(/\r?\n/)
  const firstSection = lines.findIndex((line) => /^## /.test(line))
  const head = firstSection === -1 ? lines : lines.slice(0, firstSection)
  const intro = head.filter((line) => !/^# /.test(line)).join("\n").trim()
  const sections: ExamplePage["sections"] = []
  for (const line of firstSection === -1 ? [] : lines.slice(firstSection)) {
    if (/^## /.test(line)) sections.push({ heading: line.slice(3).trim(), body: "" })
    else sections[sections.length - 1].body += `${line}\n`
  }
  return { frontmatter, sourceFiles, body, intro, sections }
}

/** Slugs of the `[[slug]]` links in `text`. */
function linkSlugs(text: string): string[] {
  return [...text.matchAll(/\[\[([^\]]+)\]\]/g)].map((match) => match[1])
}

/** True when `text` links at least one source page, that is, a page named after a file in `sourceFiles`. */
function linksASourcePage(text: string, sourceFiles: string[]): boolean {
  return linkSlugs(text).some((slug) => sourceFiles.includes(`${slug}.md`))
}

/** The Parts and Flows rules of mechanism.md, checked on one example page. */
function expectPartsAndFlowsFollowRules(label: string, page: ExamplePage): void {
  const parts = findSection(page.body, MECHANISM_SECTIONS[0]) ?? ""
  const flows = findSection(page.body, MECHANISM_SECTIONS[1]) ?? ""
  const partRows = parts.split(/\r?\n/).filter((line) => line.startsWith("- ")).map((line) => line.slice(2).split("："))
  const names = partRows.map(([name]) => name)
  expect(names.length, `${label} parts`).toBeGreaterThanOrEqual(3)
  for (const [name, role] of partRows) {
    // A part line gives the role of one part. It does not name the other parts.
    for (const other of names.filter((candidate) => candidate !== name)) {
      expect(role, `${label}: role of ${name} must not name ${other}`).not.toContain(other)
    }
  }
  // A Parts line gives a role. It does not describe what the parts exchange.
  for (const line of parts.split(/\r?\n/).filter((l) => l.startsWith("- "))) {
    for (const word of EXCHANGE_WORDS) expect(line, `${label}: Parts line must not use "${word}"`).not.toContain(word)
  }
  const flowLines = flows.split(/\r?\n/).filter((line) => line.startsWith("- "))
  expect(flowLines.length, `${label} flows`).toBeGreaterThan(0)
  for (const line of flowLines) {
    // A flow line names at least one part with the name that Parts uses.
    expect(names.some((name) => line.includes(name)), `${label}: flow line "${line}"`).toBe(true)
  }
}

/** The known-instance line form of mechanism.md, checked on one example page. */
function expectInstanceLinesFollowForm(label: string, page: ExamplePage): void {
  const instances = findSection(page.body, MECHANISM_SECTIONS[5]) ?? ""
  const lines = instances.split(/\r?\n/).filter((line) => line.trim() !== "")
  expect(lines.length, `${label} instance lines`).toBeGreaterThan(0)
  for (const line of lines) {
    // ASCII punctuation only around the link, the domain, and the colon.
    expect(line, `${label}: ${line}`).toMatch(/^- \[\[[a-z0-9-]+\]\] \([a-z0-9-]+(?:\/[a-z0-9-]+)*\): \S.*$/)
  }
  const slugs = linkSlugs(instances)
  const frontmatterSlugs = /^instances: \[(.*)\]$/m.exec(page.frontmatter)?.[1].split(",").map((slug) => slug.trim()) ?? []
  expect([...slugs].sort(), `${label} instances equal the frontmatter`).toEqual([...frontmatterSlugs].sort())
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

  it("same-name pages: never rename an old file; only the new page gets the suffix (schema.md, entity.md, concept.md agree)", () => {
    const texts: Array<[string, string]> = [
      ["schema.md", sectionBody(readTemplate("schema.md"), "File names")],
      ["entity.md", readTemplate("schema/page-types/entity.md")],
      ["concept.md", readTemplate("schema/page-types/concept.md")],
    ]
    for (const [file, text] of texts) {
      expect(text, file).toContain("Never rename an existing file")
      expect(text, file).toContain("`--<last-domain-segment>` to the new page only")
      expect(text, file).not.toMatch(/both file names/)
      expect(text, file).toMatch(/one line at the top of each of the two pages/i)
    }
    expect(readTemplate("schema/page-types/entity.md")).not.toMatch(/^- Rename a file/m)
  })

  it("the counting sentence for a sourced claim appears in writing-rules.md and in the five claim-writing rule files", () => {
    expect(sectionBody(readTemplate("schema/writing-rules.md"), "7. Cite a source for every claim")).toContain(
      COUNTING_SENTENCE,
    )
    for (const type of ["entity", "concept", "comparison", "query", "mechanism"]) {
      expect(readTemplate(`schema/page-types/${type}.md`), type).toContain(COUNTING_SENTENCE)
    }
  })

  it("entity, concept, comparison, query, and mechanism examples link a source page in every section that holds claims", () => {
    // A section counts as sourced when it links a page named after a file in `sources`.
    // The mechanism one-line summary and Known instances, and the query to-do list, hold no claim of their own.
    const exempt: Record<string, string[]> = {
      mechanism: ["已知實例"],
      query: ["要查的事"],
    }
    for (const type of ["entity", "concept", "comparison", "query", "mechanism"]) {
      const page = parseExample(type)
      expect(page.sourceFiles.length, `${type} sources`).toBeGreaterThan(0)
      if (type !== "mechanism") {
        expect(linksASourcePage(page.intro, page.sourceFiles), `${type} intro`).toBe(true)
      }
      for (const section of page.sections) {
        if ((exempt[type] ?? []).includes(section.heading)) continue
        expect(linksASourcePage(section.body, page.sourceFiles), `${type} section ${section.heading}`).toBe(true)
      }
    }
  })

  it("query example starts with the question; comparison example opens with every compared page linked", () => {
    const query = parseExample("query")
    expect(query.intro.split(/\r?\n/)[0], "query first line").toMatch(/？$/)
    const comparison = parseExample("comparison")
    const related = /^related: \[(.*)\]$/m.exec(comparison.frontmatter)?.[1].split(",").map((slug) => slug.trim()) ?? []
    expect(related.length).toBeGreaterThanOrEqual(2)
    const opening = comparison.intro.split(/\r?\n/)[0]
    expect(linkSlugs(opening)).toEqual(expect.arrayContaining(related))
  })

  it("mechanism.md: Parts and Flows rules agree with the example", () => {
    const rules = readTemplate("schema/page-types/mechanism.md")
    expect(rules).toMatch(/Parts: Name each part and its role in one line\./)
    expect(rules).toMatch(/Flows: .*Name the parts by the names that Parts uses\./)
    expectPartsAndFlowsFollowRules("mechanism", parseExample("mechanism"))
  })

  it("mechanism.md fixes the known-instance line form", () => {
    expect(readTemplate("schema/page-types/mechanism.md")).toContain(INSTANCE_LINE_FORM)
    expectInstanceLinesFollowForm("mechanism", parseExample("mechanism"))
  })

  it("mechanism.md and hypothesis.md explain which heading language each output language uses", () => {
    for (const type of ["mechanism", "hypothesis"]) {
      const sections = sectionBody(readTemplate(`schema/page-types/${type}.md`), "Sections")
      expect(sections, type).toContain("`Traditional Chinese` uses the Traditional Chinese headings")
      expect(sections, type).toContain("`Chinese` is the app value for Simplified Chinese")
      expect(sections, type).toContain("`auto` and every other language use the English headings")
    }
  })

  it("hypothesis.md settles unknown rows, from_domain, and the uncited one-line hypothesis", () => {
    const text = readTemplate("schema/page-types/hypothesis.md")
    expect(text).toMatch(/"Fits\?" set to "unknown"/)
    expect(text).toMatch(/The one-line hypothesis needs no citation\./)
    const fields = sectionBody(text, "Frontmatter")
    const fromRow = fields.split(/\r?\n/).find((line) => line.startsWith("| `from_domain`")) ?? ""
    expect(fromRow).toMatch(/user or the whiteboard/)
    expect(fromRow).not.toMatch(/Known instances/)
    const page = parseExample("hypothesis")
    const mapping = findSection(page.body, HYPOTHESIS_SECTIONS[1]) ?? ""
    const fits = tableRows(mapping).slice(1).map((row) => row[2])
    expect(new Set(fits)).toEqual(new Set(["套得上", "部分套得上", "套不上", "不確定"]))
  })

  it("source.md says what the app prompt gives; comparison.md defines the main subject", () => {
    expect(readTemplate("schema/page-types/source.md")).toContain(
      "The app prompt gives the file name of the summary page.",
    )
    const comparison = readTemplate("schema/page-types/comparison.md")
    expect(comparison).toContain("The main subject is the first page named in the title.")
    expect(comparison).toContain("If it is not clear, ask the user.")
  })

  it("every Example starts with a line about Latin slugs and CJK file names", () => {
    for (const [type] of PAGE_TYPES) {
      const example = sectionBody(readTemplate(`schema/page-types/${type}.md`), "Example")
      const firstLine = example.split(/\r?\n/).find((line) => line.trim() !== "") ?? ""
      expect(firstLine, type).toContain("Latin")
      expect(firstLine, type).toContain("CJK")
      expect(firstLine, type).toContain("`schema.md`")
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

/** Text of every `### ` heading in `body`, in order. */
function thirdLevelHeadings(body: string): string[] {
  return body
    .split(/\r?\n/)
    .filter((line) => /^### /.test(line))
    .map((line) => line.slice(4).trim())
}

/** The non-empty lines under each `### ` heading of a Fields section. Lines above the first heading are skipped. */
function fieldEntries(fields: string): Array<{ heading: string; lines: string[] }> {
  const entries: Array<{ heading: string; lines: string[] }> = []
  for (const line of fields.split(/\r?\n/)) {
    if (/^### /.test(line)) entries.push({ heading: line.slice(4).trim(), lines: [] })
    else if (line.trim() !== "" && entries.length > 0) entries[entries.length - 1].lines.push(line)
  }
  return entries
}

describe("mechanism template: lens files", () => {
  it("every known lens has a file, and there are no extra files", () => {
    const files = readdirSync(join(TEMPLATE_DIR, "lenses")).sort()
    expect(files).toEqual(KNOWN_LENSES.map((id) => `${id}.md`).sort())
  })

  it("lens files have the required structure", () => {
    for (const id of KNOWN_LENSES) {
      const text = readTemplate(`lenses/${id}.md`)
      expect(text.split(/\r?\n/)[0], `${id} title`).toBe(`# Lens: ${id}`)
      expect(secondLevelHeadings(text), id).toEqual([...LENS_SECTIONS])
      expect(sectionBody(text, "Purpose").trim().length, `${id} Purpose`).toBeGreaterThan(0)
      expect(thirdLevelHeadings(sectionBody(text, "Fields")), `${id} Fields`).toEqual(LENS_FIELDS)
      const items = sectionBody(text, "Evidence standard")
        .split(/\r?\n/)
        .filter((line) => /^\d+\. /.test(line))
      expect(items.length, `${id} evidence items`).toBeGreaterThanOrEqual(3)
      // The list is ordered: it counts 1, 2, 3, and so on.
      expect(items.map((line) => Number.parseInt(line, 10)), `${id} evidence numbering`).toEqual(items.map((_, i) => i + 1))
    }
  })

  it("each lens field has one Write line and one Do not write line", () => {
    for (const id of KNOWN_LENSES) {
      const entries = fieldEntries(sectionBody(readTemplate(`lenses/${id}.md`), "Fields"))
      expect(entries.map((entry) => entry.heading), id).toEqual(LENS_FIELDS)
      for (const entry of entries) {
        expect(entry.lines.length, `${id} ${entry.heading} lines`).toBe(2)
        expect(entry.lines[0], `${id} ${entry.heading}`).toMatch(/^Write: \S/)
        expect(entry.lines[1], `${id} ${entry.heading}`).toMatch(/^Do not write: \S/)
      }
    }
  })

  it("lens Strength rules share the level rules and add one domain sentence", () => {
    const shared: string[][] = []
    const domainSentences: string[] = []
    for (const id of KNOWN_LENSES) {
      const lines = sectionBody(readTemplate(`lenses/${id}.md`), "Strength rules")
        .split(/\r?\n/)
        .filter((line) => line.trim() !== "")
      // One lead-in line, one line for each level, and one domain sentence.
      expect(lines.length, `${id} Strength rules lines`).toBe(5)
      expect(lines[0], `${id} lead-in`).not.toMatch(/^- /)
      STRENGTH_LEVELS.forEach((level, index) => {
        expect(lines[index + 1], `${id} ${level}`).toMatch(new RegExp(`^- \`${level}\`: \\S`))
      })
      expect(lines[1], `${id} surface`).toContain("words look alike")
      expect(lines[1], `${id} surface`).toMatch(/do not match one to one/)
      expect(lines[2], `${id} structural`).toMatch(/one[- ]to[- ]one/)
      expect(lines[3], `${id} mathematical`).toContain("same equations")
      expect(lines[3], `${id} mathematical`).toContain("same trade-off curve")
      expect(lines[4], `${id} domain sentence`).not.toMatch(/^- /)
      shared.push(lines.slice(0, 4))
      domainSentences.push(lines[4])
    }
    // The four lenses use the same level rules. Only the domain sentence differs.
    for (const lines of shared) expect(lines).toEqual(shared[0])
    expect(new Set(domainSentences).size, "domain sentences differ").toBe(KNOWN_LENSES.length)
  })

  it("R16: lens Strength rules say that strength is the kind of match, and read each level for analogy and stack", () => {
    for (const id of KNOWN_LENSES) {
      const lines = sectionBody(readTemplate(`lenses/${id}.md`), "Strength rules")
        .split(/\r?\n/)
        .filter((line) => line.trim() !== "")
      expect(lines[0], `${id} lead-in`).toContain("`strength` measures the kind of match that the hypothesis claims.")
      expect(lines[0], `${id} lead-in`).toContain("not from evidence")
      expect(lines[0], `${id} lead-in`).toContain("`relation`")
      const levels = lines.slice(1, 4).join("\n")
      for (const phrase of STACK_PHRASES) expect(levels, `${id}: ${phrase}`).toContain(phrase)
    }
  })

  it("R16: lens Evidence standard says what evidence decides, and the old strength sentence is gone", () => {
    const shared: string[][] = []
    for (const id of KNOWN_LENSES) {
      const body = sectionBody(readTemplate(`lenses/${id}.md`), "Evidence standard")
      expect(body, `${id} old sentence`).not.toMatch(/sets `strength` by this standard/)
      expect(body, `${id} old sentence`).not.toContain("Do not claim more than the evidence supports")
      expect(body, `${id} strength`).toContain("Evidence does not set `strength`.")
      expect(body, `${id} role mapping`).toContain('"Fits?"')
      expect(body, `${id} role mapping`).toContain('"unknown"')
      expect(body, `${id} role mapping`).toContain('"What to verify"')
      expect(body, `${id} status`).toContain("`supported`")
      expect(body, `${id} status`).toContain("`refuted`")
      for (const phrase of STATUS_PHRASES) expect(body, `${id}: ${phrase}`).toContain(phrase)
      // The lead-in and the closing rules are equal in the four lenses. Only the ranked list differs.
      shared.push(body.split(/\r?\n/).filter((line) => line.trim() !== "" && !/^\d+\. /.test(line)))
    }
    for (const lines of shared) expect(lines).toEqual(shared[0])
  })

  it("R16: hypothesis.md sets strength from the Strength rules, and agrees with the lenses on stack and status", () => {
    const text = readTemplate("schema/page-types/hypothesis.md")
    expect(text).not.toContain("Set `strength` by the evidence standard")
    expect(text).not.toContain("Do not claim more than the evidence supports")
    expect(text).toContain("Set `strength` from the Strength rules in the lens of `to_domain`.")
    expect(text).toContain("`strength` measures the kind of match that the hypothesis claims. Evidence does not set it.")
    expect(sectionBody(text, "Rules")).toMatch(/^- Raise or lower `strength` because of the rank of the evidence\.$/m)
    const strengthRow = tableRows(sectionBody(text, "Frontmatter")).find((row) => row[0] === "strength") ?? []
    expect(strengthRow[2], "strength row").toContain("Strength rules")
    expect(strengthRow[2], "strength row").not.toMatch(/evidence/i)
    for (const phrase of [...STACK_PHRASES, ...STATUS_PHRASES]) expect(text, phrase).toContain(phrase)
    expect(text).toContain("`status: supported`")
    expect(text).toContain("`status: refuted`")
    // Every phrase that hypothesis.md shares with the lenses also appears in each lens.
    for (const id of KNOWN_LENSES) {
      const lens = readTemplate(`lenses/${id}.md`)
      for (const phrase of [...STACK_PHRASES, ...STATUS_PHRASES]) expect(lens, `${id}: ${phrase}`).toContain(phrase)
    }
  })

  it("lens Purpose says where the Fields and the Evidence standard apply, and names the lenses: list", () => {
    for (const id of KNOWN_LENSES) {
      const purpose = sectionBody(readTemplate(`lenses/${id}.md`), "Purpose")
      expect(purpose, `${id} Purpose`).toContain("Concept, entity, and source pages use only the Evidence standard.")
      expect(purpose, `${id} Purpose`).toContain("The Fields section applies to mechanism pages.")
      expect(purpose, `${id} Purpose`).toContain(`Add \`${id}\` to its \`lenses:\` list.`)
      expect(purpose, `${id} Purpose`).not.toMatch(/`lenses`\s+field/)
    }
  })

  it("physics Constraints names the approximation that the page states", () => {
    const entry = fieldEntries(sectionBody(readTemplate("lenses/physics.md"), "Fields")).find(
      (candidate) => candidate.heading === "Constraints and trade-offs",
    )
    expect(entry?.lines[0]).toContain("Name the approximation that the page states, and the scale where it holds.")
  })

  it("every lens Example starts with a line about Latin slugs and CJK file names", () => {
    for (const id of KNOWN_LENSES) {
      const example = sectionBody(readTemplate(`lenses/${id}.md`), "Example")
      const firstLine = example.split(/\r?\n/).find((line) => line.trim() !== "") ?? ""
      expect(firstLine, id).toContain("Latin")
      expect(firstLine, id).toContain("CJK")
      expect(firstLine, id).toContain("`schema.md`")
      // The second line says that the example uses domain words, and a real page does not.
      const secondLine = example.split(/\r?\n/).filter((line) => line.trim() !== "")[1] ?? ""
      expect(secondLine, `${id} second line`).toContain("domain words")
      expect(secondLine, `${id} second line`).toContain("domain-neutral")
      expect(secondLine, `${id} second line`).toContain("`schema/page-types/mechanism.md`")
    }
  })

  it("every lens Example is one fenced Traditional Chinese mechanism page that follows mechanism.md", () => {
    const hanLetter = /[\u4e00-\u9fff]/
    /** Number of list lines in the section at `index` of MECHANISM_SECTIONS. */
    const listLines = (page: ExamplePage, index: number): number =>
      (findSection(page.body, MECHANISM_SECTIONS[index]) ?? "").split(/\r?\n/).filter((line) => line.startsWith("- ")).length
    const within = (label: string, count: number, min: number, max: number): void => {
      expect(count, label).toBeGreaterThanOrEqual(min)
      expect(count, label).toBeLessThanOrEqual(max)
    }
    for (const id of KNOWN_LENSES) {
      const example = sectionBody(readTemplate(`lenses/${id}.md`), "Example")
      expect(example, `${id} language`).toMatch(hanLetter)
      expect(example.split(/\r?\n/).filter((line) => /^\s*(```|~~~)/.test(line)).length, `${id} fences`).toBe(2)
      const page = parseExampleBlock(id, example)
      expect(page.frontmatter, `${id} type`).toMatch(/^type: mechanism$/m)
      expect(page.frontmatter, `${id} lenses`).toMatch(new RegExp(`^lenses: \\[${id}\\]$`, "m"))
      expect(page.frontmatter, `${id} domain field`).not.toMatch(/^(domain|also):/m)
      expect(page.sourceFiles.length, `${id} sources`).toBeGreaterThan(0)
      expect(page.intro.startsWith("一句話："), `${id} one-line summary`).toBe(true)
      // The six sections in order, with the Traditional Chinese headings.
      expect(page.sections.map((section) => section.heading), `${id} headings`).toEqual(
        MECHANISM_SECTIONS.map((section) => section.zhHant),
      )
      // Length rules of mechanism.md.
      within(`${id} parts`, listLines(page, 0), 3, 7)
      within(`${id} flows`, listLines(page, 1), 3, 7)
      within(`${id} constraints`, listLines(page, 2), 2, 5)
      within(`${id} failure conditions`, listLines(page, 4), 1, 5)
      const why = findSection(page.body, MECHANISM_SECTIONS[3]) ?? ""
      within(`${id} why sentences`, why.split("。").filter((sentence) => sentence.trim() !== "").length, 1, 5)
      expectPartsAndFlowsFollowRules(id, page)
      expectInstanceLinesFollowForm(id, page)
      // Every trade-off line states a gain and its cost.
      for (const line of (findSection(page.body, MECHANISM_SECTIONS[2]) ?? "").split(/\r?\n/).filter((l) => l.startsWith("- "))) {
        expect(line, `${id}: trade-off line states a cost`).toContain("代價是")
      }
      // Writing rule 5: a Chinese sentence has at most 40 characters. A link does not count.
      for (const sentence of page.body.replace(/\[\[[^\]]+\]\]/g, "").split(/[。！？\n]/)) {
        expect(sentence.trim().length, `${id}: "${sentence.trim()}"`).toBeLessThanOrEqual(40)
      }
      // Every section except Known instances links a source page.
      for (const section of page.sections) {
        if (section.heading === MECHANISM_SECTIONS[5].zhHant) continue
        expect(linksASourcePage(section.body, page.sourceFiles), `${id} section ${section.heading}`).toBe(true)
      }
    }
  })

  it("ai Example uses one word, 模組, for the module and never 層; physics Example states its conservation law", () => {
    expect(sectionBody(readTemplate("lenses/ai.md"), "Example")).not.toContain("層")
    const page = parseExampleBlock("physics", sectionBody(readTemplate("lenses/physics.md"), "Example"))
    const constraints = findSection(page.body, MECHANISM_SECTIONS[2]) ?? ""
    expect(constraints).toMatch(/^- 能量守恆：.*等於/m)
  })
})

/** Text of every template file that an agent reads: the Markdown files and the YAML files. */
function templateTextFiles(directory = ""): string[] {
  return readdirSync(join(TEMPLATE_DIR, directory), { withFileTypes: true }).flatMap((entry) => {
    const relative = directory === "" ? entry.name : `${directory}/${entry.name}`
    if (entry.isDirectory()) return templateTextFiles(relative)
    return /\.(md|ya?ml)$/.test(entry.name) ? [relative] : []
  })
}

/** The phrase that A1 repeats in schema.md, mechanism.md, and concept.md. Case does not matter. */
const WRITE_BOTH_PHRASE =
  "write the concept or entity page for the domain-specific thing, and write or update a mechanism page that lists it as an instance"

/** Controller ruling R19, repeated in schema.md, the glossary, and hypothesis.md. */
const HYPOTHESIS_DOMAIN_SENTENCE =
  "For indexes, lint, and Heptabase, the domain of a hypothesis page is its `to_domain`."

/** Ways to say each output language. A3 and A4 ask every file that reads the language to know them. */
const TRADITIONAL_CHINESE_NAMES = ["繁體中文", "zh-TW", "zh-Hant", "Traditional Chinese"]
const SIMPLIFIED_CHINESE_NAMES = ["简体中文", "zh-CN", "zh-Hans", "Simplified Chinese", "Chinese"]

/** Final review fixes for sub-project 0 (items A1 to A14). */
describe("mechanism template: final review fixes", () => {
  it("A1: a mechanism page can start with one instance, and the concept page is still written", () => {
    const sentence = "A mechanism page can start with one instance."
    expect(sectionBody(readTemplate("docs/glossary.md"), "Mechanism")).toContain(sentence)
    const cases: Array<[label: string, text: string]> = [
      ["schema.md Mechanisms", sectionBody(readTemplate("schema.md"), "Mechanisms")],
      ["mechanism.md", readTemplate("schema/page-types/mechanism.md")],
      ["concept.md", readTemplate("schema/page-types/concept.md")],
    ]
    for (const [label, text] of cases) {
      expect(text.toLowerCase(), label).toContain(WRITE_BOTH_PHRASE)
    }
    expect(cases[0][1], "schema.md Mechanisms").toContain(sentence)
    expect(cases[1][1], "mechanism.md").toContain(sentence)
    const concept = readTemplate("schema/page-types/concept.md")
    expect(concept, "concept.md must not say mechanism page instead of concept page").not.toMatch(
      /is not a concept|Use a mechanism page/,
    )
  })

  it("A2 (R19): the domain of a hypothesis page is its to_domain for indexes, lint, and Heptabase", () => {
    expect(sectionBody(readTemplate("schema.md"), "Domains")).toContain(HYPOTHESIS_DOMAIN_SENTENCE)
    expect(sectionBody(readTemplate("docs/glossary.md"), "Domain")).toContain(HYPOTHESIS_DOMAIN_SENTENCE)
    expect(readTemplate("schema/page-types/hypothesis.md")).toContain(HYPOTHESIS_DOMAIN_SENTENCE)
    const body = sectionBody(readTemplate("CLAUDE.md"), "Read order")
    const lensItem = body.split(/\r?\n/).find((line) => line.includes("`lenses/<lens>.md`")) ?? ""
    expect(lensItem).toMatch(/hypothesis page/)
    expect(lensItem).toContain("the lens of `to_domain` and the lens of `from_domain`")
  })

  it("A3: only a reading wiki writes pages in the mechanisms directory", () => {
    const types = sectionBody(readTemplate("schema.md"), "Page types")
    expect(types).toContain("Only a reading wiki writes pages in this directory.")
    expect(types).not.toContain("has this directory")
  })

  it("A4: the output language is read by meaning in CLAUDE.md, schema.md, mechanism.md, and hypothesis.md", () => {
    const files = ["CLAUDE.md", "schema.md", "schema/page-types/mechanism.md", "schema/page-types/hypothesis.md"]
    for (const file of files) {
      const text = readTemplate(file)
      for (const name of [...TRADITIONAL_CHINESE_NAMES, ...SIMPLIFIED_CHINESE_NAMES]) {
        expect(text, `${file}: ${name}`).toContain(name)
      }
    }
    for (const file of ["schema/page-types/mechanism.md", "schema/page-types/hypothesis.md"]) {
      const sections = sectionBody(readTemplate(file), "Sections")
      expect(sections, file).toContain("`auto` and every other language use the English headings")
    }
    for (const file of ["CLAUDE.md", "schema.md"]) {
      const text = readTemplate(file)
      expect(text, file).toContain("If that line is empty, ask the user.")
      expect(text, file).not.toContain("If it is empty")
    }
  })

  it("A5: a mechanism wiki has only the seven page types", () => {
    expect(sectionBody(readTemplate("schema.md"), "Page types")).toContain(
      "Use only these seven types. Do not write synthesis, thesis, methodology, or finding pages in a mechanism wiki.",
    )
  })

  it("A6: a same-name file name that exists already takes the full domain path", () => {
    const rule = "If the `--<last-domain-segment>` file name already exists, use the full domain path instead."
    const how = "Replace each `/` in the domain with `--`."
    const example = "`attention` in `ai/architecture` becomes `attention--ai--architecture.md`"
    const cases: Array<[string, string]> = [
      ["schema.md File names", sectionBody(readTemplate("schema.md"), "File names")],
      ["entity.md", readTemplate("schema/page-types/entity.md")],
      ["concept.md", readTemplate("schema/page-types/concept.md")],
    ]
    for (const [label, text] of cases) {
      expect(text, label).toContain(rule)
      expect(text, label).toContain(how)
      expect(text, label).toContain(example)
    }
  })

  it("A7: hypothesis.md citation rules win for a hypothesis page", () => {
    const rule7 = sectionBody(readTemplate("schema/writing-rules.md"), "7. Cite a source for every claim")
    expect(rule7).toContain("The rules in `schema/page-types/hypothesis.md` win for a hypothesis page.")
    expect(rule7).toContain("A hypothesis page may cite any wiki page.")
    expect(rule7).toContain("Every other page cites source pages.")
    const hypothesis = readTemplate("schema/page-types/hypothesis.md")
    expect(hypothesis).toContain("These citation rules win over rule 7 in `schema/writing-rules.md`.")
    expect(hypothesis).toContain("A hypothesis page may cite any wiki page.")
  })

  it("A8: from_domain and to_domain come from domains.yaml of this wiki or of the reading wiki", () => {
    const text = readTemplate("schema/page-types/hypothesis.md")
    const rules = sectionBody(text, "Rules")
    expect(rules).toContain(
      "Take `from_domain` and `to_domain` from `domains.yaml` of this wiki. In a work wiki, you can also take them from `domains.yaml` of the reading wiki.",
    )
    expect(rules).toContain("Do not invent a domain.")
    for (const field of ["from_domain", "to_domain"]) {
      const row = tableRows(sectionBody(text, "Frontmatter")).find((cells) => cells[0] === field) ?? []
      expect(row[2], `${field} row`).toContain("domains.yaml")
    }
  })

  it("A9 (R17): a stack names from_domain as the base layer and to_domain as the upper layer", () => {
    const sentence = "In a stack, `from_domain` is the base layer and `to_domain` is the upper layer."
    expect(readTemplate("schema/page-types/hypothesis.md")).toContain(sentence)
    expect(sectionBody(readTemplate("schema.md"), "Frontmatter")).toContain(sentence)
    const stack = sectionBody(readTemplate("docs/glossary.md"), "Stack")
    expect(stack).toContain("base layer")
    expect(stack).toContain("upper layer")
    expect(stack).toContain("`from_domain` is the base layer")
    const strength = sectionBody(readTemplate("docs/glossary.md"), "Analogy strength")
    expect(strength).toContain("For a stack,")
    for (const phrase of STACK_PHRASES) expect(strength, phrase).toContain(phrase)
    for (const file of templateMarkdownFiles()) {
      expect(readTemplate(file), file).not.toMatch(/lower[- ]layer/i)
    }
    for (const id of KNOWN_LENSES) {
      expect(sectionBody(readTemplate(`lenses/${id}.md`), "Strength rules"), id).toContain("base-layer")
    }
  })

  it("A10 (R18): draft, testing, and supported have separate conditions", () => {
    const text = readTemplate("schema/page-types/hypothesis.md")
    expect(text).toContain("The Rules section has the condition for each value.")
    expect(text).not.toContain("Rules has the conditions for the other values")
    const rules = sectionBody(text, "Rules")
    expect(rules).toContain("`draft` means you wrote the page and have not tested it.")
    expect(rules).toContain(
      'Change `draft` to `testing` when at least one row under "What to verify" links a query page that holds evidence.',
    )
    expect(rules).toContain('`supported` also needs at least one row under "What to verify".')
    expect(rules).toContain("A page with zero rows stays `draft`.")
    // Ruling S15: `fuse check` asks every row of a supported page for an evidence link, and one row of a refuted page.
    expect(rules).toContain('Link the page that holds the evidence in the "Evidence needed" cell of every row.')
    expect(rules).toContain(
      'Link the page that holds this evidence in the "Evidence needed" cell of that row. The other rows can have no link.',
    )
  })

  it("A11: the unknown rule covers parts, flows, and constraints; the one-line exemption is repeated", () => {
    const text = readTemplate("schema/page-types/hypothesis.md")
    const rules = sectionBody(text, "Rules")
    expect(rules).toContain(
      'If a part, a flow, or a constraint has no supporting page in this wiki, write its mapping row with "Fits?" set to "unknown".',
    )
    const doNot = rules.slice(rules.indexOf("### Do not"), rules.indexOf("### What to write in each section"))
    expect(doNot).toContain("The one-line hypothesis is the exception.")
    const checklist = sectionBody(text, "Checklist")
    expect(checklist).toContain("every claim except the one-line hypothesis")
    for (const id of KNOWN_LENSES) {
      expect(sectionBody(readTemplate(`lenses/${id}.md`), "Evidence standard"), id).toContain(
        'write "unknown" in the output language',
      )
    }
  })

  it("A12: the instance line defines <domain>, and the Parts example gives roles only", () => {
    const text = readTemplate("schema/page-types/mechanism.md")
    expect(text).toContain("`<domain>` is the full domain path, for example `ai/architecture`.")
    const page = parseExample("mechanism")
    const parts = findSection(page.body, MECHANISM_SECTIONS[0]) ?? ""
    expect(parts).not.toContain("訊息")
    expect(parts).toContain("通道：連接各個部分的路徑")
    expect(page.body).not.toContain("訊息")
  })

  it("A13: the Heptabase example names the real command, and no template file says wiki-hepta", () => {
    expect(readTemplate("heptabase.example.yaml")).toContain("wiki-tool hepta init")
    for (const file of templateTextFiles()) {
      expect(readTemplate(file), file).not.toContain("wiki-hepta")
    }
  })

  it("A14: the domains.yaml comment does not hard-code the lens ids", () => {
    const text = readTemplate("domains.yaml")
    expect(text).toContain("`lenses/`")
    expect(text).toContain("without `.md`")
    // The example entry names one lens. The comment does not list the four ids.
    const comments = text.split(/\r?\n/).filter((line) => line.startsWith("#")).join("\n")
    const mentioned = KNOWN_LENSES.filter((id) => new RegExp(`\\b${id}\\b`).test(comments))
    expect(mentioned.length, "lens ids named in comments").toBeLessThanOrEqual(1)
    expect(text).not.toMatch(/must be one of/)
  })
})

/** The sentence that follows every "write or update a mechanism page" instruction. */
const WORK_WIKI_SENTENCE = "In a work wiki, send a `new-mechanism` review item instead."

/** Sub-project 2, Task 1: the `role` field of `wiki.yaml` is the test for a reading wiki or a work wiki. */
describe("mechanism template: wiki identity", () => {
  it("CLAUDE.md read order lists wiki.yaml after purpose.md and says what it holds", () => {
    const body = sectionBody(readTemplate("CLAUDE.md"), "Read order")
    const line = body.split(/\r?\n/).find((l) => l.includes("`wiki.yaml`")) ?? ""
    expect(line).toContain("`role`")
    expect(line).toContain("reading wiki")
    expect(line).toContain("work wiki")
  })

  it("the glossary entries for a reading wiki and a work wiki name the role field of wiki.yaml", () => {
    const glossary = readTemplate("docs/glossary.md")
    const reading = sectionBody(glossary, "Reading wiki")
    const work = sectionBody(glossary, "Work wiki")
    expect(reading).toContain("`role` field of `wiki.yaml`")
    expect(reading).toContain("`role: reading`")
    expect(work).toContain("`role` field of `wiki.yaml`")
    expect(work).toContain("`role: work`")
    expect(work).toContain("`mechanism_library`")
    expect(work).toContain("The term is used most in `wiki.yaml`.")
  })

  it("schema.md, mechanism.md, and hypothesis.md name the role field of wiki.yaml as the test", () => {
    const hypothesisRow =
      sectionBody(readTemplate("schema/page-types/hypothesis.md"), "Frontmatter")
        .split(/\r?\n/)
        .find((line) => line.startsWith("| `mechanism`")) ?? ""
    const cases: Array<[label: string, text: string]> = [
      ["schema.md Mechanisms", sectionBody(readTemplate("schema.md"), "Mechanisms")],
      ["mechanism.md Location", sectionBody(readTemplate("schema/page-types/mechanism.md"), "Location")],
      ["hypothesis.md mechanism field", hypothesisRow],
    ]
    for (const [label, text] of cases) {
      expect(text, label).toContain("`role` field of `wiki.yaml`")
    }
    expect(cases[2][1]).toContain("`role: work`")
  })

  it("a work wiki sends a new-mechanism review item wherever a file says to write or update a mechanism page", () => {
    const cases: Array<[label: string, text: string]> = [
      ["schema.md Mechanisms", sectionBody(readTemplate("schema.md"), "Mechanisms")],
      ["mechanism.md Purpose", sectionBody(readTemplate("schema/page-types/mechanism.md"), "Purpose")],
      ["concept.md Purpose", sectionBody(readTemplate("schema/page-types/concept.md"), "Purpose")],
    ]
    for (const [label, text] of cases) {
      expect(text.toLowerCase(), label).toContain(WRITE_BOTH_PHRASE)
      expect(text, label).toContain(WORK_WIKI_SENTENCE)
    }
  })

  it("every file that says write or update a mechanism page also gives the work wiki exception", () => {
    for (const file of templateMarkdownFiles()) {
      const text = readTemplate(file)
      if (!text.toLowerCase().includes("write or update a mechanism page")) continue
      expect(text, file).toContain(WORK_WIKI_SENTENCE)
    }
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
