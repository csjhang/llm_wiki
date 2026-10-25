/**
 * Test helpers for `fuse check` and `fuse commit`: a wiki project with a domain list and two evidence pages, and a
 * builder for hypothesis pages. Slugs, domains, and titles are placeholders. Not part of the bundle: only test files
 * import it.
 */
import { makeProject, writeProjectFile } from "../test-project"

export const DOMAINS_YAML = [
  "version: 1",
  "domains:",
  "  hardware/async-circuits:",
  "    lens: hardware",
  "    description: Digital circuits without a global clock",
  "  business/inventory:",
  "    lens: business",
  "    description: Stock and replenishment",
  "",
].join("\n")

/** The page that a mapping row cites, and a query page that a verify row can link. Both are in the wiki. */
export const EVIDENCE_PAGE = "restock-policy"
export const QUERY_PAGE = "open-question"

/** A wiki project (a reading wiki) with `domains.yaml`, an evidence page, and a query page. */
export function makeWiki(files: Record<string, string> = {}): string {
  return makeProject(
    {
      "domains.yaml": DOMAINS_YAML,
      [`wiki/concepts/${EVIDENCE_PAGE}.md`]: `---\ntype: concept\ntitle: Restock policy\n---\n# Restock policy\n`,
      [`wiki/queries/${QUERY_PAGE}.md`]: `---\ntype: query\ntitle: Open question\n---\n# Open question\n`,
      ...files,
    },
    { noHeptabaseYaml: true },
  )
}

/** Overwrite `wiki.yaml` so that the project is a work wiki with the given library path. */
export function makeWorkWiki(project: string, library: string): void {
  writeProjectFile(project, "wiki.yaml", `version: 1\nid: work\nrole: work\nmechanism_library: ${library}\n`)
}

export type SectionKey = "claim" | "mapping" | "gaps" | "verify" | "search" | "related"

export const HEADINGS: Record<"en" | "zhHant" | "zhHans", Record<SectionKey, string>> = {
  en: {
    claim: "One-line hypothesis",
    mapping: "Role mapping",
    gaps: "Gaps and impact",
    verify: "What to verify",
    search: "Search keywords",
    related: "Related pages",
  },
  zhHant: {
    claim: "一句話假說",
    mapping: "角色對照表",
    gaps: "套不上的部分與影響",
    verify: "要驗證的事",
    search: "建議搜尋關鍵字",
    related: "相關頁面",
  },
  zhHans: {
    claim: "一句话假说",
    mapping: "角色对照表",
    gaps: "套不上的部分与影响",
    verify: "要验证的事",
    search: "建议搜索关键词",
    related: "相关页面",
  },
}

/** A markdown table. `header` and each row are lists of cells. */
export function table(header: string[], rows: string[][]): string {
  const line = (cells: string[]): string => `| ${cells.join(" | ")} |`
  return [line(header), line(header.map(() => "---")), ...rows.map(line)].join("\n")
}

export function mappingTable(rows: string[][]): string {
  return table(["Mechanism part", "Target counterpart", "Fits?", "Reason"], rows)
}

/** The verify table. A row is `[claim, evidence needed, how to refute]`. */
export function verifyTable(rows: string[][]): string {
  return table(["Claim", "Evidence needed", "How to refute"], rows)
}

export const VALID_FIELDS: Record<string, string> = {
  type: "hypothesis",
  title: "Threshold restocking saves effort",
  mechanism: "event-driven",
  from_domain: "hardware/async-circuits",
  to_domain: "business/inventory",
  relation: "analogy",
  strength: "structural",
  status: "draft",
}

export const VALID_VERIFY_ROWS = [
  ["Threshold restocking needs less labor", "Labor records of both ways", "The labor records are not lower"],
  ["The system can warn at once", "Alert settings", "The alert log shows late warnings"],
]

const DEFAULT_SECTIONS: Record<SectionKey, string> = {
  claim: "Event-driven computing explains why threshold restocking saves effort.",
  mapping: mappingTable([
    ["Event", "Stock below the threshold", "fits", `[[${EVIDENCE_PAGE}]] uses the threshold as the trigger.`],
    ["Detector", "System alert", "unknown", "No page says whether the system can warn at once."],
  ]),
  gaps: `- Approval delays the order. [[${EVIDENCE_PAGE}]]`,
  verify: verifyTable(VALID_VERIFY_ROWS),
  search: "- reorder point policy\n- continuous review inventory\n- event-driven replenishment",
  related: `- [[${EVIDENCE_PAGE}]]`,
}

export interface PageOptions {
  /** Frontmatter fields to set; `null` leaves a field out. */
  fields?: Record<string, string | null>
  /** Section bodies to set; `null` leaves the section out. */
  sections?: Partial<Record<SectionKey, string | null>>
  /** The language of the headings. The default is English. */
  headings?: keyof typeof HEADINGS
}

const SECTION_ORDER: SectionKey[] = ["claim", "mapping", "gaps", "verify", "search", "related"]

/** A hypothesis page that passes `fuse check` (in a project made by `makeWiki`) unless the options change it. */
export function hypothesisPage(options: PageOptions = {}): string {
  const fields = { ...VALID_FIELDS, ...options.fields }
  const lines = ["---"]
  for (const [key, value] of Object.entries(fields)) {
    if (value !== null) lines.push(`${key}: ${JSON.stringify(value)}`)
  }
  lines.push('tags: ["fusion"]', "related: []", 'sources: ["notes.md"]', "created: 2026-01-15", "updated: 2026-01-15", "---")
  lines.push("# Threshold restocking saves effort", "")
  const headings = HEADINGS[options.headings ?? "en"]
  for (const key of SECTION_ORDER) {
    const body = options.sections && key in options.sections ? options.sections[key] : DEFAULT_SECTIONS[key]
    if (body === null || body === undefined) continue
    lines.push(`## ${headings[key]}`, "", body, "")
  }
  return lines.join("\n")
}
