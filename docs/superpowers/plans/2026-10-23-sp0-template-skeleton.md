# Sub-project 0: Mechanism Wiki Template Skeleton — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the files and config formats that every later sub-project builds on: a Claude Code plugin skeleton, the mechanism-wiki template (rules, lenses, glossary), validated `domains.yaml` and `heptabase.yaml` formats, section-heading constants, a new "Mechanism Wiki" project template in the app, and a sample wiki.

**Architecture:** Template content lives as real files in `templates/mechanism-wiki/`. The app loads them with Vite raw imports and writes them into a new project. Config parsing and section headings live in `src/lib/wiki-config/` as pure functions. Contract tests read the template files from disk and enforce structure, so the rule files and the code cannot drift.

**Tech Stack:** TypeScript, Vite `import.meta.glob` raw imports, `js-yaml` (already a dependency), vitest (`npm run test:mocks`), Claude Code plugin manifests.

**Spec:** `docs/superpowers/specs/2026-10-23-mechanism-wiki-heptabase-design.md` (sections 2.5, 2.7, 3, 5, 10.1, 11.2, 12 row 0)

## Global Constraints

- AI-facing files (`CLAUDE.md`, `AGENTS.md`, `schema.md`, `schema/**`, `lenses/**`, `docs/glossary.md`, every `SKILL.md`) use STE-style English: active voice, one instruction per sentence, imperative for instructions, one meaning per term, no sentence longer than 25 words.
- Do not copy any text from ASD-STE100. Write our own summary only.
- No personal data anywhere: no real Heptabase IDs, whiteboard names, card titles, or emails. Example UUIDs use the form `00000000-0000-4000-8000-0000000000NN`.
- Skill names are English and match `^wiki(-[a-z]+)*$`.
- Domain names match `^[a-z0-9]+(?:-[a-z0-9]+)*(?:/[a-z0-9]+(?:-[a-z0-9]+)*)*$`.
- Lens ids are exactly `business`, `physics`, `hardware`, `ai`.
- Page types are exactly `source`, `entity`, `concept`, `comparison`, `query`, `mechanism`, `hypothesis`, with directories `wiki/sources/`, `wiki/entities/`, `wiki/concepts/`, `wiki/comparisons/`, `wiki/queries/`, `wiki/mechanisms/`, `wiki/hypotheses/`.
- New behavior goes in new files. Upstream files get the smallest possible edit (spec 2.6).
- Verification commands: `npm run test:mocks` and `npm run typecheck`. Both must pass before each commit.
- Every commit message ends with:
  ```
  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_013yG6txX1fFsHyk4VQiasu7
  ```
- Deferred from this sub-project: the wiki's `.claude/settings.json` permission allowlist moves to sub-project 6, because the exact MCP tool names are known only after sub-project 3.

## Review Focus

1. `domains.yaml` with `domains:` empty or `null` must parse to zero domains, not throw. (Task 2 test `treats null domains as empty`.)
2. Duplicate domain keys in YAML must produce an issue, not silently keep the last one. (Task 2 test `reports duplicate keys`.)
3. Template files under a `docs/` folder or named `AGENTS.md` are ignored by the upstream `.gitignore`, so they can vanish from commits. (Task 1 test `no template file is git-ignored`.)
4. A project path with a trailing slash or Windows backslashes must not produce `//` or mixed separators when the template is applied. (Task 6 test `normalizes project path separators`.)
5. A page written with Simplified Chinese headings, extra spaces, or a trailing colon must still be found by `findSection`. (Task 4 test `finds headings across language variants and spacing`.)

---

### Task 1: Plugin skeleton, `wiki` menu skill, and git-ignore exceptions

**Files:**
- Create: `.claude-plugin/marketplace.json`
- Create: `plugins/llm-wiki/.claude-plugin/plugin.json`
- Create: `plugins/llm-wiki/README.md`
- Create: `plugins/llm-wiki/skills/wiki/SKILL.md`
- Modify: `.gitignore` (append only)
- Test: `src/lib/__tests__/plugin-contract.test.ts`

**Interfaces:**
- Produces: plugin name `llm-wiki`; marketplace name `llm-wiki-mechanism`; skills folder `plugins/llm-wiki/skills/<skill-name>/SKILL.md`. Later sub-projects add skill folders here, and the contract test covers them automatically.

- [ ] **Step 1: Write the failing test** `src/lib/__tests__/plugin-contract.test.ts`

Tests (read files from the repo root with `fs`):
- `marketplace lists the llm-wiki plugin`: `.claude-plugin/marketplace.json` has `name === "llm-wiki-mechanism"` and one plugin with `name === "llm-wiki"` and `source === "./plugins/llm-wiki"`; that folder exists.
- `plugin manifest matches marketplace`: `plugins/llm-wiki/.claude-plugin/plugin.json` has `name === "llm-wiki"`, `version` matching `/^\d+\.\d+\.\d+$/`, non-empty `description`, `license` equal to the SPDX id of the root `LICENSE`.
- `every skill has valid frontmatter`: for each `plugins/llm-wiki/skills/*/SKILL.md`, frontmatter `name` equals the folder name, matches `/^wiki(-[a-z]+)*$/`, and `description` is a non-empty string of at most 1024 characters.
- `skill list includes wiki`: the folder `plugins/llm-wiki/skills/wiki` exists.
- `no template file is git-ignored`: run `git check-ignore --no-index` (via `child_process.execFileSync`, `cwd` = repo root) on these paths and expect none ignored: `templates/mechanism-wiki/docs/glossary.md`, `templates/mechanism-wiki/AGENTS.md`. `git check-ignore` exits with code 1 when nothing is ignored; treat exit code 1 as pass.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/__tests__/plugin-contract.test.ts`
Expected: FAIL (files do not exist; ignore check reports the two paths as ignored).

- [ ] **Step 3: Create the manifests, README, skill, and git-ignore exceptions**

- `marketplace.json`: same shape as the Heptabase marketplace (`name`, `owner.name` = `csjhang`, `metadata.description`, `plugins[]` with `name`, `source`, `description`).
- `plugin.json`: `name`, `displayName` "LLM Wiki (Mechanism)", `version` `0.1.0`, `description`, `license` (read root `LICENSE`: use `GPL-3.0-only` unless it says "or any later version", then `GPL-3.0-or-later`), `repository` `https://github.com/csjhang/llm_wiki`, `keywords`.
- `README.md` (plain English): what the plugin is, install commands (`/plugin marketplace add csjhang/llm_wiki`, `/plugin install llm-wiki@llm-wiki-mechanism`), and a note that it also needs the Heptabase plugin for `wiki-sync` and `wiki-fuse`.
- `skills/wiki/SKILL.md`: frontmatter `name: wiki`, `description` in STE English that says: use this skill to see all LLM Wiki skills and to choose one. Body steps: find the `skills` folder that contains this skill; read the frontmatter of each `*/SKILL.md`; show a table with name and description; ask the user which skill to run; run the selected skill. Do not hard-code the skill list.
- `.gitignore`: append
  ```
  # Mechanism wiki template ships these files
  !/templates/mechanism-wiki/docs/
  !/templates/mechanism-wiki/AGENTS.md
  ```
  Create empty placeholder files `templates/mechanism-wiki/docs/glossary.md` and `templates/mechanism-wiki/AGENTS.md` so the ignore check has real paths. Task 3 fills them.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/lib/__tests__/plugin-contract.test.ts && npm run typecheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add .claude-plugin plugins .gitignore src/lib/__tests__/plugin-contract.test.ts templates/mechanism-wiki/docs/glossary.md templates/mechanism-wiki/AGENTS.md
git commit -m "feat(plugin): add llm-wiki plugin skeleton and wiki menu skill"
```

---

### Task 2: `domains.yaml` and `heptabase.yaml` parsers

**Files:**
- Create: `src/lib/wiki-config/types.ts`
- Create: `src/lib/wiki-config/domains.ts`
- Create: `src/lib/wiki-config/heptabase-config.ts`
- Test: `src/lib/wiki-config/domains.test.ts`
- Test: `src/lib/wiki-config/heptabase-config.test.ts`

**Interfaces:**
- Produces (`types.ts`):
  ```ts
  export interface ConfigIssue { path: string; message: string }
  export type ParseResult<T> =
    | { ok: true; value: T; issues: [] }
    | { ok: false; issues: ConfigIssue[] }
  export const UUID_PATTERN: RegExp // /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
  ```
- Produces (`domains.ts`):
  ```ts
  export const DOMAIN_NAME_PATTERN: RegExp
  export const KNOWN_LENSES: readonly ["business", "physics", "hardware", "ai"]
  export interface DomainEntry { lens: string; description: string; whiteboards: string[] }
  export interface DomainsConfig { version: 1; domains: Record<string, DomainEntry> }
  export function parseDomainsYaml(text: string, knownLenses?: readonly string[]): ParseResult<DomainsConfig>
  export function domainParent(name: string): string | null   // "a/b/c" -> "a/b"; "a" -> null
  ```
- Produces (`heptabase-config.ts`):
  ```ts
  export type WhiteboardKind = "topic" | "source" | "project" | "archive"
  export interface WhiteboardSetting { kind: WhiteboardKind; auto_ingest: boolean }
  export const REQUIRED_PROPERTY_KEYS: readonly ["domain", "page_type", "wiki", "status"]
  export const OPTIONAL_PROPERTY_KEYS: readonly ["wiki_page", "last_synced", "hypothesis_status", "strength"]
  export type PropertyKey = (typeof REQUIRED_PROPERTY_KEYS)[number] | (typeof OPTIONAL_PROPERTY_KEYS)[number]
  export interface HeptabaseConfig {
    version: 1
    wiki_id: string
    mechanism_library: string | null
    roots: string[]
    whiteboards: Record<string, WhiteboardSetting>
    tags: { ingest: string; mirror: string }
    properties: Partial<Record<PropertyKey, string>>
  }
  export function parseHeptabaseYaml(text: string): ParseResult<HeptabaseConfig>
  ```

- [ ] **Step 1: Write the failing tests**

`domains.test.ts`:
- `parses a valid file`: two domains (`hardware/async-circuits` lens `hardware`, `ai/architecture` lens `ai`), `whiteboards` omitted → `ok: true`, `whiteboards` defaults to `[]`.
- `treats null domains as empty`: `"version: 1\ndomains:\n"` → `ok: true`, `domains` is `{}`.
- `rejects bad domain names`: keys `Hardware/X`, `hardware//x`, `hardware/`, `硬體` → each gives an issue with `path` `domains.<key>`.
- `rejects unknown lens`: lens `music` with default lenses → issue at `domains.<key>.lens`.
- `accepts custom lens list`: lens `music` with `knownLenses = [...KNOWN_LENSES, "music"]` → ok.
- `requires description`: empty description → issue at `domains.<key>.description`.
- `requires whiteboard ids to be UUIDs`: `whiteboards: [abc]` → issue.
- `rejects unknown keys`: entry key `color` → issue.
- `rejects wrong version`: `version: 2` → issue at `version`.
- `reports duplicate keys`: the same domain key twice → `ok: false` with one issue whose message names the duplicate.
- `reports YAML syntax errors`: malformed YAML → `ok: false`, issue `path` `""`.
- `domainParent`: `"a/b/c"` → `"a/b"`, `"a"` → `null`.

`heptabase-config.test.ts`:
- `parses the template example`: read `templates/mechanism-wiki/heptabase.example.yaml` from disk (created in Task 3; until then write the same content inline in the test, then switch to the file in Task 3) → ok.
- `requires required properties`: missing `status` → issue at `properties.status`.
- `rejects unknown property keys`: `properties.color` → issue.
- `rejects auto_ingest on non-source whiteboards`: `kind: topic, auto_ingest: true` → issue.
- `defaults auto_ingest to false`.
- `rejects bad wiki_id`: `Reading Wiki` → issue.
- `requires at least one root`: `roots: []` → issue.
- `requires UUIDs`: a non-UUID tag id, root id, whiteboard key, and property id → four issues.
- `accepts null mechanism_library and a string path`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/lib/wiki-config`
Expected: FAIL (modules do not exist).

- [ ] **Step 3: Implement the three modules**

Use `js-yaml` `load` with default options (it throws on duplicate keys; turn that error into one `ConfigIssue`). Collect all issues before returning; return `ok: false` when any issue exists. Do no file I/O in these modules.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/lib/wiki-config && npm run typecheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/wiki-config
git commit -m "feat(config): add domains.yaml and heptabase.yaml parsers"
```

---

### Task 3: Template entry files, glossary, writing rules, and config examples

**Files:**
- Create: `templates/mechanism-wiki/CLAUDE.md`
- Modify: `templates/mechanism-wiki/AGENTS.md` (placeholder from Task 1)
- Create: `templates/mechanism-wiki/schema.md`
- Create: `templates/mechanism-wiki/purpose.md`
- Create: `templates/mechanism-wiki/domains.yaml`
- Create: `templates/mechanism-wiki/heptabase.example.yaml`
- Modify: `templates/mechanism-wiki/docs/glossary.md` (placeholder from Task 1)
- Create: `templates/mechanism-wiki/schema/writing-rules.md`
- Create: `src/test-helpers/ste-check.ts`
- Test: `src/lib/__tests__/mechanism-template-contract.test.ts`
- Modify: `src/lib/wiki-config/heptabase-config.test.ts` (read the example file)

**Interfaces:**
- Consumes: `parseDomainsYaml`, `parseHeptabaseYaml` (Task 2).
- Produces:
  ```ts
  // src/test-helpers/ste-check.ts
  export interface SteViolation { file: string; line: number; words: number; sentence: string }
  export function findLongSentences(file: string, markdown: string, maxWords?: number): SteViolation[] // default 25
  ```
  `findLongSentences` skips YAML frontmatter, fenced code blocks, table rows (lines starting with `|`), headings, and any line that contains CJK characters. It splits prose on `.`, `!`, `?`, or `;` followed by whitespace or line end, and counts whitespace-separated words.
- Produces: `GLOSSARY_TERMS` list (inside the contract test) — the exact `##` headings `docs/glossary.md` must contain:
  `Wiki`, `Reading wiki`, `Work wiki`, `Source`, `Article`, `Note`, `Domain`, `Lens`, `Mechanism`, `Instance`, `Fusion`, `Hypothesis page`, `Relation`, `Analogy`, `Stack`, `Analogy strength`, `Mirror card`, `Card map`, `Review queue`.

- [ ] **Step 1: Write the failing contract test** `mechanism-template-contract.test.ts` (this file grows in Tasks 4 and 5)

- `glossary defines every term`: each `GLOSSARY_TERMS` entry appears as a `## <term>` heading in `docs/glossary.md`, and each heading has at least one non-empty paragraph.
- `CLAUDE.md read order points to real files`: parse the numbered list under `## Read order`; every backticked path that has no `<` and is not marked `(optional)` exists in `templates/mechanism-wiki/`; every path with `<...>` names a folder that exists.
- `AGENTS.md points to CLAUDE.md`: file is at most 5 lines and contains `CLAUDE.md`.
- `schema.md lists the seven page types`: the table under `## Page types` has exactly the seven types and directories from Global Constraints.
- `domains.yaml is valid`: `parseDomainsYaml(file).ok === true`.
- `heptabase example is valid`: `parseHeptabaseYaml(file).ok === true`.
- `AI-facing files keep sentences short`: `findLongSentences` returns `[]` for `CLAUDE.md`, `AGENTS.md`, `schema.md`, `docs/glossary.md`, `schema/writing-rules.md`.
- `ste-check unit`: a 26-word sentence is reported; the same sentence inside a code fence, a table row, or a CJK line is not.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/__tests__/mechanism-template-contract.test.ts`
Expected: FAIL

- [ ] **Step 3: Write `src/test-helpers/ste-check.ts`**

- [ ] **Step 4: Write the template files**

Content requirements (STE English unless noted):
- `CLAUDE.md`: one-sentence purpose, then `## Read order` as a numbered list: `docs/glossary.md`, `purpose.md`, `schema.md`, `domains.yaml`, `schema/writing-rules.md`, `schema/page-types/<type>.md` ("read the file for each page type you write"), `lenses/<lens>.md` ("read the lens of the page domain"), `heptabase.yaml` (optional). Then `## Rules` with at most five lines: do not edit `raw/`; do not invent domains; write wiki pages in the output language; follow the page-type file; ask the user when a rule does not cover a case.
- `AGENTS.md`: at most 5 lines; tells Codex to read `CLAUDE.md`.
- `schema.md`: the app passes this file to every ingest prompt as the authoritative routing rule. Sections: `## Page types` (table: Type | Directory | Purpose, the seven rows), `## File names` (kebab-case; keep CJK titles as CJK; domain suffix `--<last-domain-segment>` when two domains share a name), `## Frontmatter` (common fields from the app plus `domain`, `also`, and per-type fields from spec 5.4; state that each page-type file holds the full field list), `## Domains` (choose only from `domains.yaml`; propose a new domain as a review item; one page has one `domain`; only mechanism pages cross domains), `## Mechanisms` (summary of spec 5.6; full rules in `schema/page-types/mechanism.md`; work wikis do not write mechanism pages), `## Index and log` (index is generated by the app; log entry prefix `## [YYYY-MM-DD] <action> | <title>`), `## Cross-references` (`[[slug]]` in body only; bare slugs in `related:`), `## Contradictions` (record in the page; open a query page; link both sources).
- `purpose.md`: headings `# Purpose`, `## Goal`, `## Key questions`, `## Out of scope`, each with one HTML comment that tells the user what to write. The user may write the body in any language.
- `domains.yaml`: `version: 1` and `domains: {}`, with YAML comments that show one commented-out example entry.
- `heptabase.example.yaml`: every field from spec 7.3 with example UUIDs `00000000-0000-4000-8000-0000000000NN`; one whiteboard of each kind; comments that say `wiki-hepta init` creates the real `heptabase.yaml`.
- `docs/glossary.md`: one `##` heading per `GLOSSARY_TERMS` entry, in that order. Use the definitions in spec section 3. Each definition is two to four short sentences. Add a sentence that names the file where the term is used most.
- `schema/writing-rules.md`: rules for wiki page text in any output language, written in STE English, with one short Traditional Chinese example per rule (CJK lines are exempt from the length check). Rules: one term has one meaning (use the glossary term); one idea per sentence; active voice; put the conclusion first; short sentences; write a user note as the user's view, not as a fact; cite a source for every claim. End with a section `## Source of these rules` that says the rules are our summary, inspired by the ASD-STE100 principles, and that the standard itself is not included because ASD owns its copyright.

- [ ] **Step 5: Switch `heptabase-config.test.ts` to read the example file**

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx vitest run src/lib/__tests__/mechanism-template-contract.test.ts src/lib/wiki-config && npm run typecheck`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add templates/mechanism-wiki src/test-helpers/ste-check.ts src/lib/__tests__/mechanism-template-contract.test.ts src/lib/wiki-config/heptabase-config.test.ts
git commit -m "feat(template): add mechanism wiki entry files, glossary, and writing rules"
```

---

### Task 4: Section headings and page-type rule files

**Files:**
- Create: `src/lib/wiki-config/section-headings.ts`
- Test: `src/lib/wiki-config/section-headings.test.ts`
- Create: `templates/mechanism-wiki/schema/page-types/{source,entity,concept,comparison,query,mechanism,hypothesis}.md`
- Modify: `src/lib/__tests__/mechanism-template-contract.test.ts`

**Interfaces:**
- Consumes: `OutputLanguage` from `src/lib/output-language-options.ts`.
- Produces:
  ```ts
  export interface SectionHeading { key: string; en: string; zhHant: string; zhHans: string }
  export const MECHANISM_SECTIONS: readonly SectionHeading[]
  export const HYPOTHESIS_SECTIONS: readonly SectionHeading[]
  export function headingFor(section: SectionHeading, language: OutputLanguage): string
  export function findSection(markdown: string, section: SectionHeading): string | null
  ```
  Exact values (key / en / zhHant / zhHans):
  - Mechanism: `parts` / Parts / 組成 / 组成; `flows` / Flows / 流動 / 流动; `constraints` / Constraints and trade-offs / 約束與取捨 / 约束与取舍; `why` / Why it works / 為什麼有效 / 为什么有效; `failure` / Failure conditions / 失效條件 / 失效条件; `instances` / Known instances / 已知實例 / 已知实例.
  - Hypothesis: `claim` / One-line hypothesis / 一句話假說 / 一句话假说; `mapping` / Role mapping / 角色對照表 / 角色对照表; `gaps` / Gaps and impact / 套不上的部分與影響 / 套不上的部分与影响; `verify` / What to verify / 要驗證的事 / 要验证的事; `search` / Search keywords / 建議搜尋關鍵字 / 建议搜索关键词; `related` / Related pages / 相關頁面 / 相关页面.
  - `headingFor`: `"Traditional Chinese"` → `zhHant`; `"Chinese"` → `zhHans`; every other value, including `"auto"`, → `en`.
  - `findSection`: matches a level-2 heading equal to any of the three variants after trimming spaces and a trailing `:` or `：`; returns the text up to the next level-2 heading or end of file, trimmed; returns `null` when absent.

- [ ] **Step 1: Write the failing tests**

`section-headings.test.ts`:
- `has the exact mechanism keys in order`: keys equal `["parts","flows","constraints","why","failure","instances"]`.
- `has the exact hypothesis keys in order`: keys equal `["claim","mapping","gaps","verify","search","related"]`.
- `headingFor maps languages`: Traditional Chinese → 組成; Chinese → 组成; English → Parts; auto → Parts; Japanese → Parts.
- `finds headings across language variants and spacing`: `## 组成 ：` body found for `parts`; `##   Parts` found; `### 組成` (level 3) not found; body stops at the next `## `.
- `returns null for a missing section`.

Add to `mechanism-template-contract.test.ts`:
- `every page type has a rule file`: the seven files exist.
- `rule files have the required sections`: each has `## Purpose`, `## Location`, `## Frontmatter`, `## Rules`, `## Example`, `## Checklist`, in that order.
- `mechanism and hypothesis sections match the code`: the table under `## Sections` in `mechanism.md` and `hypothesis.md` has columns `Key | English | Traditional Chinese | Simplified Chinese`, and its rows equal `MECHANISM_SECTIONS` / `HYPOTHESIS_SECTIONS` exactly.
- `examples use the defined headings`: the `## Example` block of `mechanism.md` contains every `zhHant` heading of `MECHANISM_SECTIONS` as `## <heading>`; the same for `hypothesis.md`.
- Extend `AI-facing files keep sentences short` to all seven rule files.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/lib/wiki-config/section-headings.test.ts src/lib/__tests__/mechanism-template-contract.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement `section-headings.ts`**

- [ ] **Step 4: Write the seven rule files**

Each file: `# Page type: <type>`, then the six sections. `## Frontmatter` is a table `Field | Required | Rule` that lists the app's common fields plus the spec 5.4 fields for this type. `## Rules` uses "Do" and "Do not" lists. `## Example` is one complete page in Traditional Chinese inside a fenced block (generic content, for example event-driven computation). `## Checklist` is a list of yes/no checks.
Type-specific content:
- `source.md`: `source_kind` (`article` or `note`); a note is the user's view; one summary page per source; never edit `raw/`.
- `entity.md` and `concept.md`: exactly one `domain`; split same-name pages across domains with the `--<segment>` suffix; keep claims on the subject they describe.
- `comparison.md`: compares named pages; each row cites a source.
- `query.md`: an open question; links to the sources and concepts it uses; deep research results are saved here only after user approval.
- `mechanism.md`: no `domain` field; `lenses` and `instances` required; add `## Sections` table; text has no industry or vendor detail; each known instance is one link plus the name it has in its domain; failure conditions are required; only the reading wiki writes mechanism pages.
- `hypothesis.md`: fields from spec 5.8; add `## Sections` table; every claim cites a wiki page; a claim without a page goes under "What to verify"; each verification row has "how to refute"; strength follows the target lens.

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run src/lib/wiki-config src/lib/__tests__/mechanism-template-contract.test.ts && npm run typecheck`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/lib/wiki-config/section-headings.ts src/lib/wiki-config/section-headings.test.ts templates/mechanism-wiki/schema/page-types src/lib/__tests__/mechanism-template-contract.test.ts
git commit -m "feat(template): add page-type rule files and section heading constants"
```

---

### Task 5: Lens files

**Files:**
- Create: `templates/mechanism-wiki/lenses/{business,physics,hardware,ai}.md`
- Modify: `src/lib/__tests__/mechanism-template-contract.test.ts`

**Interfaces:**
- Consumes: `KNOWN_LENSES` (Task 2), `MECHANISM_SECTIONS` (Task 4).
- Produces: lens files at `lenses/<lens-id>.md`. Sub-project 2 loads `lenses/<lens>.md` into ingest prompts by the domain's `lens` value.

- [ ] **Step 1: Add failing contract tests**

- `every known lens has a file`: one file per `KNOWN_LENSES` entry, and no extra files.
- `lens files have the required structure`: `# Lens: <id>`, `## Purpose`, `## Fields` with level-3 headings equal to the `en` values of `MECHANISM_SECTIONS` except `instances` (Parts, Flows, Constraints and trade-offs, Why it works, Failure conditions), `## Evidence standard` with an ordered list of at least three items, `## Strength rules` with one line each for `surface`, `structural`, `mathematical`, and `## Example`.
- Extend `AI-facing files keep sentences short` to the four lens files.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/__tests__/mechanism-template-contract.test.ts`
Expected: FAIL

- [ ] **Step 3: Write the four lens files**

Each `### <field>` has two lines: "Write:" and "Do not write:". Domain meanings (spec 5.7):
- business: parts = roles; flows = value and money; constraints = cost structure; why = moat; evidence = audited financials > disclosed operating data > interviews > press claims.
- physics: parts = degrees of freedom and fields; flows = energy and interactions; constraints = conservation laws and the scale where an approximation holds; why = symmetry or a stable solution; evidence = reproduced experiment > single experiment > simulation > theory claim.
- hardware: parts = components, cells, interconnects; flows = signals, data, clock, power; constraints = area, power, latency trade-offs, process, yield; why = an optimum under physical limits; evidence = measured silicon data > simulation > paper claims.
- ai: parts = layers, modules, state; flows = information, gradients, tokens; constraints = compute, memory, data; why = inductive bias; evidence = reproduced benchmark with ablation > single benchmark > paper claims.
`## Strength rules`: `mathematical` needs the same equations or the same trade-off curve; `structural` needs a one-to-one match of parts and flows; otherwise `surface`. Each lens adds one domain-specific sentence to these rules. `## Example` shows one short mechanism field set for a generic example in that domain.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/lib/__tests__/mechanism-template-contract.test.ts && npm run typecheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add templates/mechanism-wiki/lenses src/lib/__tests__/mechanism-template-contract.test.ts
git commit -m "feat(template): add business, physics, hardware, and ai lenses"
```

---

### Task 6: "Mechanism Wiki" project template in the app

**Files:**
- Modify: `src/lib/templates.ts` (add optional `files` to `WikiTemplate`; register the new template)
- Create: `src/lib/mechanism-template.ts`
- Create: `src/lib/apply-template.ts`
- Modify: `src/components/project/create-project-dialog.tsx:118-123` (call `applyTemplate`)
- Test: `src/lib/mechanism-template.test.ts`
- Test: `src/lib/apply-template.test.ts`

**Interfaces:**
- Consumes: template files from Tasks 3–5.
- Produces:
  ```ts
  // templates.ts
  export interface WikiTemplate { /* existing fields */ files?: Record<string, string> }
  // mechanism-template.ts
  export const MECHANISM_TEMPLATE_FILES: Readonly<Record<string, string>> // key: path relative to templates/mechanism-wiki/, "/" separators
  export const mechanismTemplate: WikiTemplate // id "mechanism"
  // apply-template.ts
  export interface TemplateFs {
    writeFile(path: string, content: string): Promise<void>
    createDirectory(path: string): Promise<void>
  }
  export async function applyTemplate(projectPath: string, template: WikiTemplate, fs: TemplateFs): Promise<void>
  ```
  `mechanismTemplate`: `name` "Mechanism Wiki", `icon` "🧩", `description` "Cross-domain mechanisms, fusion hypotheses, and Heptabase sync", `schema` = `MECHANISM_TEMPLATE_FILES["schema.md"]`, `purpose` = `MECHANISM_TEMPLATE_FILES["purpose.md"]`, `files` = every other entry, `extraDirs` = `["wiki/mechanisms", "wiki/hypotheses", "wiki/indexes", "raw/sources/heptabase"]`.
  `applyTemplate`: normalize `projectPath` (backslashes to `/`, strip trailing `/`); write `schema.md` and `purpose.md`; create each `extraDirs` entry; for each `files` entry create its parent folders once (deduplicated, parents before children), then write the file.

- [ ] **Step 1: Write the failing tests**

`mechanism-template.test.ts`:
- `loads all template files`: keys include `CLAUDE.md`, `AGENTS.md`, `schema.md`, `purpose.md`, `domains.yaml`, `heptabase.example.yaml`, `docs/glossary.md`, `schema/writing-rules.md`, `schema/page-types/mechanism.md`, `lenses/hardware.md`; no key starts with `/` or contains `\`.
- `file content matches disk`: `MECHANISM_TEMPLATE_FILES["docs/glossary.md"]` equals the file read with `fs`.
- `template is registered`: `getTemplate("mechanism").id === "mechanism"` and it appears in `templates`.
- `schema and purpose are not duplicated in files`: `files` has no `schema.md` or `purpose.md` key.

`apply-template.test.ts` (fake `TemplateFs` that records calls in order):
- `writes schema, purpose, dirs, and files`: for a template with `files: {"lenses/ai.md": "x", "docs/glossary.md": "y"}` the calls include `writeFile("/p/schema.md", ...)`, `createDirectory("/p/lenses")`, `writeFile("/p/lenses/ai.md", "x")`.
- `creates parent folders before files and only once`: nested `schema/page-types/a.md` and `schema/page-types/b.md` → `createDirectory("/p/schema")` and `createDirectory("/p/schema/page-types")` each called once, before the writes.
- `normalizes project path separators`: `projectPath` `C:\\w\\p\\` → every path starts with `C:/w/p/` and none contains `//`.
- `works for templates without files`: the existing `general` template → only schema, purpose, and its extraDirs.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/lib/mechanism-template.test.ts src/lib/apply-template.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement**

`mechanism-template.ts` uses `import.meta.glob("/templates/mechanism-wiki/**/*", { query: "?raw", import: "default", eager: true })` and strips the `/templates/mechanism-wiki/` prefix. Use `import type { WikiTemplate }` to avoid a runtime import cycle with `templates.ts`. In `create-project-dialog.tsx`, replace the three template lines with `await applyTemplate(pp, template, { writeFile, createDirectory })` and keep the rest unchanged.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run test:mocks && npm run typecheck`
Expected: PASS. Then run `npx vite build` and expect success (the glob must resolve in a production build).

- [ ] **Step 5: Commit**

```bash
git add src/lib/templates.ts src/lib/mechanism-template.ts src/lib/apply-template.ts src/components/project/create-project-dialog.tsx src/lib/mechanism-template.test.ts src/lib/apply-template.test.ts
git commit -m "feat(app): add Mechanism Wiki project template"
```

---

### Task 7: Sample wiki overlay

**Files:**
- Create: `examples/sample-wiki/README.md`
- Create: `examples/sample-wiki/purpose.md`
- Create: `examples/sample-wiki/domains.yaml`
- Create: `examples/sample-wiki/raw/sources/async-handshake-circuits.md`
- Create: `examples/sample-wiki/raw/sources/spiking-neural-networks.md`
- Create: `examples/sample-wiki/raw/sources/franchise-licensing.md`
- Create: `src/test-helpers/sample-wiki.ts`
- Test: `src/lib/__tests__/sample-wiki.test.ts`

**Interfaces:**
- Consumes: `MECHANISM_TEMPLATE_FILES` (Task 6), `parseDomainsYaml` (Task 2).
- Produces:
  ```ts
  // src/test-helpers/sample-wiki.ts
  export async function materializeSampleWiki(targetDir: string): Promise<void>
  ```
  It copies the template files, then copies `examples/sample-wiki/` on top (overlay files win), then creates the folders the app's `create_project` creates: `raw/sources`, `raw/assets`, `wiki/entities`, `wiki/concepts`, `wiki/sources`, `wiki/queries`, `wiki/comparisons`, `wiki/synthesis`, plus the template `extraDirs`. Sub-projects 1–5 use this helper for fixtures.

- [ ] **Step 1: Write the failing test** `sample-wiki.test.ts`

- `sample domains are valid`: `parseDomainsYaml` on `examples/sample-wiki/domains.yaml` → ok, with exactly `hardware/async-circuits` (hardware), `ai/architecture` (ai), `business/franchising` (business).
- `every sample source names a known domain`: each source file has frontmatter `domain` that exists in the sample `domains.yaml`.
- `two domains share a mechanism candidate`: the async-circuits and spiking sources both contain the phrase `event-driven`.
- `materializes a complete wiki`: after `materializeSampleWiki(tmp)`, `CLAUDE.md`, `lenses/hardware.md`, `raw/sources/franchise-licensing.md`, and `wiki/mechanisms/` exist, and `purpose.md` equals the overlay version.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/__tests__/sample-wiki.test.ts`
Expected: FAIL

- [ ] **Step 3: Write the overlay and helper**

Write the three sources yourself in plain English, 250–450 words each, with frontmatter `title`, `domain`, `source_kind: article`. Use only general, well-known facts; cite no copyrighted text. Content: (1) asynchronous circuits use request/acknowledge handshakes, have no global clock, spend energy only on transitions, and are hard to verify for timing; (2) spiking neural networks fire spikes past a threshold, compute only on events, have sparse activity, and are hard to train because spikes are not differentiable; (3) franchise licensing: the brand owner licenses the brand and operating system, the franchisee owns the assets, fees flow to the owner, the moat is brand plus standards plus network, and it fails when brand quality slips. `README.md` says what the sample is for and that it is an overlay on `templates/mechanism-wiki/`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run test:mocks && npm run typecheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add examples/sample-wiki src/test-helpers/sample-wiki.ts src/lib/__tests__/sample-wiki.test.ts
git commit -m "feat(example): add sample wiki overlay with two domains sharing a mechanism"
```

---

## Notes for later sub-projects

- `ingest.ts` line ~3663 (`startIngest` chat flow) reads `${pp}/wiki/schema.md` and `${pp}/wiki/purpose.md`, but projects store both files at the root. This looks like an upstream bug. Sub-project 2 fixes it (read the root files, fall back to `wiki/`).
- The app's ingest prompt passes only `schema.md`. Sub-project 2 must also pass `schema/page-types/<type>.md` and `lenses/<lens>.md` where the spec needs them.
