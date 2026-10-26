/**
 * Section headings of mechanism pages and hypothesis pages.
 *
 * The template rule files `schema/page-types/mechanism.md` and `hypothesis.md`
 * list the same headings in a `## Sections` table. A contract test keeps the
 * two lists equal. Wiki pages use the heading of the output language, so a
 * reader of a page must accept all three variants.
 */
import type { OutputLanguage } from "@/lib/output-language-options"

export interface SectionHeading {
  /** Stable id of the section. Code refers to a section by key, never by text. */
  key: string
  en: string
  /** Traditional Chinese. */
  zhHant: string
  /** Simplified Chinese. */
  zhHans: string
}

/** Sections of a mechanism page, in page order. */
export const MECHANISM_SECTIONS: readonly SectionHeading[] = [
  { key: "parts", en: "Parts", zhHant: "組成", zhHans: "组成" },
  { key: "flows", en: "Flows", zhHant: "流動", zhHans: "流动" },
  { key: "constraints", en: "Constraints and trade-offs", zhHant: "約束與取捨", zhHans: "约束与取舍" },
  { key: "why", en: "Why it works", zhHant: "為什麼有效", zhHans: "为什么有效" },
  { key: "failure", en: "Failure conditions", zhHant: "失效條件", zhHans: "失效条件" },
  { key: "instances", en: "Known instances", zhHant: "已知實例", zhHans: "已知实例" },
]

/** Sections of a hypothesis page, in page order. */
export const HYPOTHESIS_SECTIONS: readonly SectionHeading[] = [
  { key: "claim", en: "One-line hypothesis", zhHant: "一句話假說", zhHans: "一句话假说" },
  { key: "mapping", en: "Role mapping", zhHant: "角色對照表", zhHans: "角色对照表" },
  { key: "gaps", en: "Gaps and impact", zhHant: "套不上的部分與影響", zhHans: "套不上的部分与影响" },
  { key: "verify", en: "What to verify", zhHant: "要驗證的事", zhHans: "要验证的事" },
  { key: "search", en: "Search keywords", zhHant: "建議搜尋關鍵字", zhHans: "建议搜索关键词" },
  { key: "related", en: "Related pages", zhHant: "相關頁面", zhHans: "相关页面" },
]

/**
 * Heading text to write for `section` in `language`. The two Chinese values
 * map to their own variant. Every other value, including "auto", gives English.
 */
export function headingFor(section: SectionHeading, language: OutputLanguage): string {
  if (language === "Traditional Chinese") return section.zhHant
  if (language === "Chinese") return section.zhHans
  return section.en
}

/** Trim spaces, then one trailing ASCII or full-width colon, then spaces again. */
function normalizeHeading(text: string): string {
  return text.trim().replace(/[:：]$/, "").trim()
}

function isLevelTwo(line: string): boolean {
  return /^##(?:[ \t]|$)/.test(line)
}

/**
 * True when `line` is the level-2 heading of `section`. The heading text must
 * equal the English, Traditional Chinese, or Simplified Chinese variant after
 * `normalizeHeading`. The English variant ignores letter case ("## Why It
 * Works" is `why`). The two Chinese variants must match exactly.
 */
function isHeadingOf(line: string, section: SectionHeading): boolean {
  if (!isLevelTwo(line)) return false
  const text = normalizeHeading(line.slice(2))
  return text.toLowerCase() === section.en.toLowerCase() || text === section.zhHant || text === section.zhHans
}

/**
 * Body of the level-2 section of `section` in `markdown`, or null when absent.
 *
 * A heading matches as `isHeadingOf` says. The body runs to the next level-2
 * heading, or to the end of the text, and is trimmed.
 */
export function findSection(markdown: string, section: SectionHeading): string | null {
  const lines = markdown.split(/\r?\n/)
  const range = sectionLineRange(lines, section)
  return range === null ? null : lines.slice(range.start, range.end).join("\n").trim()
}

/**
 * Where the body of the first level-2 section of `section` is in `lines` (the lines of a page, without line
 * breaks): `start` is the first line after the heading, and `end` is the line of the next level-2 heading, or
 * `lines.length`. Null when the section is absent. The heading matches as `isHeadingOf` says, so a caller that
 * edits the body in place reads the section exactly as `findSection` does.
 */
export function sectionLineRange(lines: readonly string[], section: SectionHeading): { start: number; end: number } | null {
  const heading = lines.findIndex((line) => isHeadingOf(line, section))
  if (heading === -1) return null
  const next = lines.findIndex((line, index) => index > heading && isLevelTwo(line))
  return { start: heading + 1, end: next === -1 ? lines.length : next }
}

/**
 * `markdown` without every level-2 section of `section`: the heading line and the
 * body up to the next level-2 heading (or the end). Matching is the one of
 * `findSection`, so all three language variants go. Text without such a section
 * comes back as it is. Otherwise the result has `\n` line breaks.
 */
export function removeSection(markdown: string, section: SectionHeading): string {
  const lines = markdown.split(/\r?\n/)
  if (!lines.some((line) => isHeadingOf(line, section))) return markdown
  const kept: string[] = []
  let removing = false
  for (const line of lines) {
    if (isLevelTwo(line)) removing = isHeadingOf(line, section)
    if (!removing) kept.push(line)
  }
  return kept.join("\n")
}
