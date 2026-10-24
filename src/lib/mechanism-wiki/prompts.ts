/**
 * Prompt sections for the ingest of a mechanism wiki.
 *
 * A project with `domains.yaml` is a mechanism wiki. Its ingest adds three
 * sections to the upstream prompts:
 * - the analysis addendum: pick a domain, find mechanisms, end with `## Decisions`;
 * - the chunk analysis addendum: the same, for a long source read in chunks;
 * - the generation addendum: the page rules that follow from those decisions.
 *
 * `ingest.ts` appends them to the upstream prompts and changes nothing else.
 * A project that is not a mechanism wiki gets none of them.
 */
import { parseFrontmatter } from "@/lib/frontmatter"
import type { OutputLanguage } from "@/lib/output-language-options"
import { headingFor, MECHANISM_SECTIONS } from "@/lib/wiki-config/section-headings"
import type { SectionHeading } from "@/lib/wiki-config/section-headings"
import { hasOwn } from "@/lib/wiki-config/yaml-util"
import { canWriteMechanismPages, extractLensFieldsText, lensForDomain } from "./context"
import type { MechanismContext } from "./context"
import { emptyDecisions } from "./types"
import type { AnalysisDecisions, MechanismDecision } from "./types"

/** What each mechanism section holds, in one line. Keys are the `MECHANISM_SECTIONS` keys. */
const SECTION_MEANINGS: Readonly<Record<string, string>> = {
  parts: "the components, and the role of each one",
  flows: "what moves between the parts, in order",
  constraints: "what limits the mechanism, and what it gives up",
  why: "the reason that the structure works",
  failure: "when the mechanism stops working",
  instances: "the pages that apply the mechanism, each with its domain and its local term",
}

/** The Known instances section. `section-headings.ts` always defines it. */
const INSTANCES_SECTION: SectionHeading = MECHANISM_SECTIONS.filter((section) => section.key === "instances")[0]

/** Add `section` to `prompt` after a blank line. An empty or missing section leaves the prompt as it is. */
export function appendPromptSection(prompt: string, section: string | undefined): string {
  return section ? `${prompt}\n\n${section}` : prompt
}

/**
 * The domain named by the `domain` field of the source's frontmatter, when
 * `domains.yaml` lists it. Null for a missing, unlisted, or non-text value. A
 * child of a listed domain is not listed, so it gives null too.
 */
export function domainHintFromSource(sourceContent: string, ctx: MechanismContext): string | null {
  const domain = parseFrontmatter(sourceContent).frontmatter?.domain
  if (typeof domain !== "string") return null
  const name = domain.trim()
  return hasOwn(ctx.domains.domains, name) ? name : null
}

// --- analysis ----------------------------------------------------------

export interface AnalysisAddendumOptions {
  /**
   * The addendum is for the chunk analysis of a long source. That prompt
   * asks for two sections only, so the decisions go inside the digest.
   */
  chunked?: boolean
}

/**
 * The section that the analysis prompt gets in a mechanism wiki. `hintDomain`
 * is a listed domain that the source names. With it, the section carries the
 * lens of that domain. Without it, the section carries the Fields of every lens.
 */
export function buildAnalysisAddendum(
  ctx: MechanismContext,
  hintDomain: string | null,
  options: AnalysisAddendumOptions = {},
): string {
  const chunked = options.chunked === true
  return [
    "## Mechanism Wiki: Domain and Mechanisms",
    "",
    chunked
      ? "This wiki sorts every source into a domain and finds the mechanisms that the source shows. Do this for the whole document, in addition to the chunk analysis."
      : "This wiki sorts every source into a domain and finds the mechanisms that the source shows. Do this in addition to the analysis above.",
    "",
    domainSection(ctx, hintDomain),
    "",
    mechanismSection(),
    "",
    lensSection(ctx, hintDomain),
    "",
    chunked ? chunkDecisionsSection() : decisionsSection(),
  ].join("\n")
}

function domainSection(ctx: MechanismContext, hintDomain: string | null): string {
  const entries = Object.entries(ctx.domains.domains)
  const lensIds = Object.keys(ctx.lenses).sort()
  return [
    "### Domain",
    "",
    "Choose exactly one domain for this source. Use a domain from the list below when one fits.",
    "Do not invent a synonym of a listed domain. If no listed domain fits, propose exactly one new domain.",
    ...(hintDomain === null ? [] : [`The source itself names the domain \`${hintDomain}\`. Use it unless the source clearly belongs elsewhere.`]),
    "",
    ...(entries.length === 0
      ? ["No domain is listed yet. Propose one."]
      : entries.map(([name, entry]) => `- ${name}: ${entry.description}`)),
    ...(lensIds.length === 0 ? [] : ["", `Lens ids for a new domain: ${lensIds.join(", ")}`]),
  ].join("\n")
}

function mechanismSection(): string {
  return [
    "### Mechanisms",
    "",
    "A mechanism is a structure that repeats across domains. A mechanism has no industry, vendor, or product detail. Describe it in domain-neutral words.",
    "Read the source for mechanisms with this skeleton. Every mechanism has these six sections:",
    "",
    ...MECHANISM_SECTIONS.map((section) => `- ${section.en}: ${SECTION_MEANINGS[section.key] ?? ""}`),
    "",
    "Search the wiki index for a page of the same mechanism before you call a mechanism new. Name only mechanisms that the source really shows.",
  ].join("\n")
}

/** The lens of the hint domain, or the Fields of every lens when there is no usable hint. */
function lensSection(ctx: MechanismContext, hintDomain: string | null): string {
  const hinted = hintDomain === null ? null : lensForDomain(ctx, hintDomain)
  if (hinted !== null && hinted.promptText !== "") {
    return [
      `### Lens for ${hintDomain} (\`${hinted.id}\`)`,
      "",
      "The lens says what each of the six sections means in this domain.",
      "",
      hinted.promptText,
    ].join("\n")
  }
  const blocks = Object.keys(ctx.lenses)
    .sort()
    .map((id) => ({ id, fields: extractLensFieldsText(ctx.lenses[id].text) }))
    .filter((lens) => lens.fields !== "")
    .map((lens) => `Lens \`${lens.id}\`:\n\n${lens.fields}`)
  if (blocks.length === 0) return ["### Lenses", "", "This wiki has no lens text."].join("\n")
  return [
    "### Lenses",
    "",
    "A lens says what each of the six sections means in the domains that use it. Read the source with the lens of the domain you choose.",
    "",
    blocks.join("\n\n"),
  ].join("\n")
}

/** The four line forms of the Decisions section, as fenced blocks. */
function decisionLineForms(): string[] {
  return [
    "```",
    "DOMAIN: <path>",
    "```",
    "or, when no listed domain fits:",
    "```",
    "NEW-DOMAIN: <path> | <lens> | <description>",
    "```",
    "then zero or more mechanism lines:",
    "```",
    "MECHANISM: existing:<slug> | <one-line>",
    "MECHANISM: new:<slug> | <one-line>",
    "```",
  ]
}

const DECISION_RULES = [
  "- Write exactly one `DOMAIN` line, or exactly one `NEW-DOMAIN` line when no listed domain fits. `<path>` is a domain path: lowercase words joined by `-`, with `/` between levels.",
  "- Write `MECHANISM: existing:<slug>` when the wiki index lists a page of that mechanism. Write `MECHANISM: new:<slug>` when it does not.",
  "- `<slug>` is the file name of the mechanism page without `.md`. It is kebab-case. A title in Chinese, Japanese, or Korean keeps its characters.",
  "- `<one-line>` is one sentence that says what the mechanism does, in domain-neutral words.",
  "- Write no `MECHANISM` line when the source shows no mechanism.",
]

function decisionsSection(): string {
  return [
    "### Decisions",
    "",
    "End your analysis with a section headed exactly `## Decisions`. Write nothing after it. It holds only these lines, one per line, without bullets:",
    "",
    ...decisionLineForms(),
    "",
    ...DECISION_RULES,
  ].join("\n")
}

function chunkDecisionsSection(): string {
  return [
    "### Decisions",
    "",
    "Output exactly the two sections already requested. Do not add a third section.",
    "Instead, make the `### Decisions` subsection the FIRST subsection of the Updated Global Digest: write it directly after the `## Updated Global Digest` heading, then the rest of the digest. Do not put it last, because the app cuts the end of a long digest and would lose the decisions.",
    "The subsection is headed exactly `### Decisions`. It holds only these lines, one per line, without bullets. The next digest heading ends it:",
    "",
    ...decisionLineForms(),
    "",
    "Keep one `DOMAIN` or `NEW-DOMAIN` line for the whole document. Change it only when this chunk shows that the document belongs elsewhere.",
    "Keep the `MECHANISM` lines of the Current Global Digest, and add a line for each mechanism that this chunk shows.",
    "",
    ...DECISION_RULES,
  ].join("\n")
}

// --- generation --------------------------------------------------------

/**
 * `headingFor` gives Chinese headings only for the two Chinese values. The
 * app passes any language name, so every other one becomes English here.
 */
function headingLanguage(language: string): OutputLanguage {
  return language === "Traditional Chinese" || language === "Chinese" ? language : "English"
}

/**
 * The section that the generation prompt gets in a mechanism wiki.
 * `outputLanguage` is the language name that the prompt's language rule uses;
 * it picks the headings of mechanism pages.
 */
export function buildGenerationAddendum(
  ctx: MechanismContext,
  decisions: AnalysisDecisions,
  outputLanguage: string = "English",
): string {
  const language = headingLanguage(outputLanguage)
  const canWrite = canWriteMechanismPages(ctx)
  const instancesHeading = headingFor(INSTANCES_SECTION, language)
  return [
    "## Mechanism Wiki Rules (these add to the rules above)",
    "",
    "`mechanism` and `hypothesis` are also known types in this wiki, in addition to the types listed above.",
    "Mechanism pages go in wiki/mechanisms/. Do not write wiki/hypotheses/ pages: fusion writes them, not ingest.",
    "",
    domainRules(decisions),
    "",
    canWrite ? writableMechanismRules(ctx, language) : reviewOnlyMechanismRules(ctx, language),
    "",
    decisionRules(decisions, canWrite, instancesHeading),
    "",
    "These rules add to the Output Format above. Your response still begins with `---FILE:` and holds only FILE blocks and REVIEW blocks. Write all prose in the mandatory output language above.",
  ].join("\n")
}

function domainRules(decisions: AnalysisDecisions): string {
  const chosen = decisions.domain ?? decisions.proposedDomain?.path ?? null
  const lines = [
    "### Domain",
    "",
    chosen === null
      ? "Every page except mechanism pages must have a `domain:` line in its frontmatter. Use the path of the DOMAIN line in the `## Decisions` section of the analysis."
      : `Every page except mechanism pages must have \`domain: ${chosen}\` in its frontmatter. That covers the source, entity, concept, comparison, and query pages that you write from this source.`,
    "Add `also: [<domain>, ...]` only for other domains from domains.yaml that the page relates to.",
    "A mechanism page has no `domain` field and no `also` field.",
  ]
  if (decisions.domain === null && decisions.proposedDomain !== null) {
    lines.push(
      `The analysis proposes the new domain \`${decisions.proposedDomain.path}\`. It is not in domains.yaml yet. Use it for \`domain:\` anyway. The app asks the user to approve it, so do not write a REVIEW block for it.`,
    )
  }
  return lines.join("\n")
}

function writableMechanismRules(ctx: MechanismContext, language: OutputLanguage): string {
  return [
    "### Mechanism pages",
    "",
    "This wiki is a reading wiki: write mechanism pages in wiki/mechanisms/.",
    headingList(language),
    mechanismRulesText(ctx),
  ].join("\n")
}

function reviewOnlyMechanismRules(ctx: MechanismContext, language: OutputLanguage): string {
  const reason = ctx.identity.role === "work"
    ? "This is a work wiki, so do not write wiki/mechanisms/ files. Mechanism pages live only in the reading wiki."
    : "The wiki.yaml of this wiki cannot be read, so do not write wiki/mechanisms/ files until it is fixed. Mechanism pages live only in a reading wiki."
  return [
    "### Mechanism pages",
    "",
    reason,
    "Write each new mechanism as a REVIEW block of type new-mechanism instead. Do not add an OPTIONS line to it: the app adds the options.",
    "The description of the block holds the mechanism, with one line that states it, then the six sections below. The PAGES line lists the instance pages that you write for this source.",
    "",
    "```",
    "---REVIEW: new-mechanism | <mechanism title>---",
    "<one line that states the mechanism>",
    "<the six sections>",
    "PAGES: wiki/<instance page>.md",
    "---END REVIEW---",
    "```",
    "",
    headingList(language),
    mechanismRulesText(ctx),
  ].join("\n")
}

function headingList(language: OutputLanguage): string {
  return [
    "Use exactly these six level-2 headings, in this order. Do not translate or rephrase them.",
    "",
    ...MECHANISM_SECTIONS.map((section) => `## ${headingFor(section, language)}`),
  ].join("\n")
}

function mechanismRulesText(ctx: MechanismContext): string {
  const rules = ctx.pageTypeRules.mechanism
  if (rules === undefined || rules.trim() === "") return ""
  return ["", "Rules for mechanism pages in this wiki (from schema/page-types/mechanism.md):", "", rules.trim()].join("\n")
}

function decisionRules(
  decisions: AnalysisDecisions,
  canWrite: boolean,
  instancesHeading: string,
): string {
  if (decisions.problems.length > 0) {
    // The mechanism lines cannot be trusted, so none is listed.
    return [
      "### Mechanisms for this source",
      "",
      "The analysis decisions had problems; do not write or update a mechanism page in this run.",
    ].join("\n")
  }
  if (decisions.mechanisms.length === 0) {
    return [
      "### Mechanisms for this source",
      "",
      "Write a mechanism page only for a MECHANISM line in the analysis decisions. This analysis has none, so do not write a mechanism page.",
    ].join("\n")
  }
  return [
    "### Mechanisms for this source",
    "",
    "The analysis decided these mechanisms. Handle each one as written:",
    "",
    ...decisions.mechanisms.map((mechanism) => mechanismInstruction(mechanism, canWrite, instancesHeading)),
  ].join("\n")
}

function mechanismInstruction(
  mechanism: MechanismDecision,
  canWrite: boolean,
  instancesHeading: string,
): string {
  const label = `MECHANISM ${mechanism.kind}:${mechanism.slug} (${mechanism.summary})`
  if (!canWrite) {
    return mechanism.kind === "new"
      ? `- ${label}: write it as a REVIEW block of type new-mechanism, as described above.`
      : `- ${label}: this mechanism is in the mechanism library, not in this wiki. Do not write or change any wiki/mechanisms/ file for it.`
  }
  if (mechanism.kind === "existing") {
    return `- ${label}: update wiki/mechanisms/${mechanism.slug}.md. Add one line under the \`## ${instancesHeading}\` heading, in the form \`- [[<instance-slug>]] (<domain>): <local term>\`. \`<instance-slug>\` is the page that you write for this source. Add that slug to \`instances\` and the lens of the domain to \`lenses\`. The app merges your FILE block into the page that exists, so do not write a second page for this mechanism.`
  }
  return `- ${label}: write wiki/mechanisms/${mechanism.slug}.md as a new mechanism page. The page that you write for this source is its first instance.`
}

// --- index -------------------------------------------------------------

/**
 * Index text for the analysis and generation prompts of a mechanism wiki.
 * Until the domain index lands, this is the full index. Task 7 replaces it
 * with `buildScopedIndexText`: the index of the hinted domain plus the
 * mechanism index.
 */
export function scopedIndexText(_ctx: MechanismContext, fullIndex: string, _domain: string | null): string {
  return fullIndex
}

// --- ingest hook -------------------------------------------------------

export interface MechanismIngestPrompts {
  /** The domain that the source names, when `domains.yaml` lists it. */
  hint: string | null
  /** Index text for the analysis and generation prompts. */
  index: string
  /** Appended to the analysis system prompt. */
  analysis: string
  /** Appended to the chunk analysis system prompt of a long source. */
  chunkAnalysis: string
  /** Appended to the generation system prompt. */
  generation: (decisions: AnalysisDecisions) => string
  /** Characters that the addenda add to a prompt. The source budget counts them as stable context. */
  reservedChars: number
}

/** Everything that `ingest.ts` needs from a mechanism wiki to build its prompts. */
export function prepareMechanismPrompts(
  ctx: MechanismContext,
  fullIndex: string,
  sourceContent: string,
  outputLanguage: string,
): MechanismIngestPrompts {
  const hint = domainHintFromSource(sourceContent, ctx)
  const analysis = buildAnalysisAddendum(ctx, hint)
  const chunkAnalysis = buildAnalysisAddendum(ctx, hint, { chunked: true })
  const generation = (decisions: AnalysisDecisions): string => buildGenerationAddendum(ctx, decisions, outputLanguage)
  return {
    hint,
    index: scopedIndexText(ctx, fullIndex, hint),
    analysis,
    chunkAnalysis,
    generation,
    reservedChars: Math.max(analysis.length, chunkAnalysis.length) + generation(emptyDecisions(hint)).length,
  }
}
