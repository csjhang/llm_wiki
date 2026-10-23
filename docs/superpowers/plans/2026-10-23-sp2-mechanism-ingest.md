# Sub-project 2: Mechanism-Layer Ingest — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** In a mechanism wiki (a project that has `domains.yaml`), ingest picks a domain from the list, extracts cross-domain mechanisms, writes domain-tagged pages, keeps a domain-first index, skips duplicate sources, and sends new domains, new mechanisms, duplicates, and research results to the review queue.

**Architecture:** A new folder `src/lib/mechanism-wiki/` holds all new logic as small modules: context loading, prompt sections, analysis-decision parsing, generation enforcement, domain index, source fingerprints, and review actions. `ingest.ts` gets a few guarded calls (`if (mechanismCtx)`) at the points where it reads context, builds prompts, writes file blocks, and updates the index. Projects without `domains.yaml` behave exactly as before.

**Tech Stack:** TypeScript, vitest, `js-yaml`, existing app modules (`@/commands/fs`, `parseFileBlocks`, `parseFrontmatter`, `review-store`).

**Spec:** `docs/superpowers/specs/2026-10-23-mechanism-wiki-heptabase-design.md` (sections 5.3–5.9, 6.2–6.6, 8.3, 12 row 2)

## Global Constraints

- A project is a mechanism wiki if and only if `<project>/domains.yaml` exists. Every new code path is guarded by that check.
- New page types: `mechanism` in `wiki/mechanisms/`, `hypothesis` in `wiki/hypotheses/`.
- Index files: `wiki/index.md` (domain tree with page counts), `wiki/indexes/<domain with "/" replaced by "--">.md`, `wiki/indexes/_mechanisms.md`.
- Analysis output ends with a `## Decisions` section with these exact line forms: `DOMAIN: <path>`, or `NEW-DOMAIN: <path> | <lens> | <description>`; then zero or more `MECHANISM: existing:<slug> | <one-line>` or `MECHANISM: new:<slug> | <one-line>`.
- Review item types added: `new-domain`, `new-mechanism`, `duplicate-source`, `research-result`. (`mirror-edited` comes in sub-project 3, `fusion-candidate` in sub-project 4.)
- Review option actions use the prefix `mech:`; every handler lives in `src/lib/mechanism-wiki/review-actions.ts`.
- Source dedup: normalize URLs (lowercase host, drop `utm_*`, `fbclid`, `gclid`, fragment, trailing `/`); text similarity = Jaccard over 5-word shingles of normalized text; duplicate when ≥ 0.85. Fingerprints live in `.llm-wiki/source-fingerprints.json`.
- Deep research results in a mechanism wiki go to `.llm-wiki/research-staging/` and become a `research-result` review item; they reach `wiki/queries/` only on approval.
- Wiki identity lives in a new `wiki.yaml` (`version`, `id`, `role: reading | work`, `mechanism_library`). `heptabase.yaml` drops `wiki_id` and `mechanism_library` (see Ruling in Task 1).
- New behavior goes in new files; upstream files get the smallest guarded edit.
- Verification: `npm run test:mocks` and `npm run typecheck` pass before each commit.
- Commit trailer: your session's Co-Authored-By line plus `Claude-Session: https://claude.ai/code/session_013yG6txX1fFsHyk4VQiasu7`.

## Review Focus

1. A source whose analysis has no `## Decisions` section or a domain not in the list. Expected: ingest still writes pages; pages get the fallback domain (the source frontmatter `domain`, else none) and a `new-domain` or lint issue, never a crash. (Task 4 test `missing decisions falls back`.)
2. The generation omits `domain:` on a concept page or adds `domain:` to a mechanism page. Expected: enforcement fixes both before writing. (Task 5 tests.)
3. A work wiki whose generation contains a mechanism FILE block. Expected: no file under `wiki/mechanisms/`; one `new-mechanism` review item carries the content. (Task 5 test `work wiki converts mechanism pages to proposals`.)
4. The same article arrives twice, once as a web clip with tracking parameters and once as a Heptabase snapshot with different whitespace. Expected: the second is skipped as a duplicate. (Task 6 tests.)
5. A project without `domains.yaml`. Expected: byte-identical prompts and index behavior to upstream. (Task 3 test `upstream prompts unchanged` and Task 7 test `non-mechanism project keeps old index`.)

---

### Task 1: Page types, `wiki.yaml`, and config cleanup

**Files:**
- Modify: `src/lib/wiki-page-types.ts` (add `mechanism`, `hypothesis` to `GENERATION_WIKI_TYPES` and `WIKI_TYPE_DIRS`)
- Create: `src/lib/wiki-config/wiki-identity.ts` + `src/lib/wiki-config/wiki-identity.test.ts`
- Modify: `src/lib/wiki-config/heptabase-config.ts` and its test (remove `wiki_id`, `mechanism_library`; unknown-key rule now rejects them)
- Create: `templates/mechanism-wiki/wiki.yaml`
- Modify: `templates/mechanism-wiki/heptabase.example.yaml`, `templates/mechanism-wiki/CLAUDE.md` (read order adds `wiki.yaml` after `purpose.md`)
- Modify: `templates/mechanism-wiki/schema.md`, `templates/mechanism-wiki/docs/glossary.md` (Reading wiki and Work wiki entries), `templates/mechanism-wiki/schema/page-types/mechanism.md` (Location), `templates/mechanism-wiki/schema/page-types/hypothesis.md` (`mechanism` field): each names the `role` field of `wiki.yaml` as the test for a reading wiki or a work wiki (final review of sub-project 0, Important 4)
- Modify: `src/lib/__tests__/mechanism-template-contract.test.ts` (`wiki.yaml is valid`)
- Modify: `docs/superpowers/specs/2026-10-23-mechanism-wiki-heptabase-design.md` sections 5.1 and 7.3 (record the move; force-add, `docs/` is git-ignored)
- Test: `src/lib/wiki-page-types.test.ts` (extend if present, else create)

**Interfaces:**
- Produces:
  ```ts
  // wiki-identity.ts
  export type WikiRole = "reading" | "work"
  export interface WikiIdentity { version: 1; id: string; role: WikiRole; mechanism_library: string | null }
  export function parseWikiYaml(text: string): ParseResult<WikiIdentity>
  ```
  Rules: `id` slug `^[a-z0-9]+(?:-[a-z0-9]+)*$`; `role` required; `mechanism_library` must be `null` when `role: reading` and a non-empty string when `role: work`; unknown keys rejected. Template `wiki.yaml`: `version: 1`, `id: reading`, `role: reading`, `mechanism_library: null`, with comments.
- Ruling carried by this task: wiki identity is wiki-level config, not Heptabase config; keeping it in `heptabase.yaml` would make a wiki without Heptabase unable to say it is a work wiki, and would duplicate the id. `heptabase.yaml` now holds Heptabase settings only. The Heptabase `wiki` property value comes from `wiki.yaml` `id`.

- [ ] **Step 1: Write the failing tests** — `inferWikiTypeFromPath("wiki/mechanisms/x.md") === "mechanism"`, `("wiki/hypotheses/x.md") === "hypothesis"`; `GENERATION_WIKI_TYPES` includes both; `parseWikiYaml` valid reading, valid work, work without library → issue, reading with library → issue, bad id, unknown key; heptabase tests: `wiki_id` now an unknown-key issue; template contract `wiki.yaml is valid`.
- [ ] **Step 2: Run** `npx vitest run src/lib/wiki-page-types src/lib/wiki-config src/lib/__tests__/mechanism-template-contract.test.ts` → FAIL
- [ ] **Step 3: Implement and update the template, CLAUDE.md, and spec**
- [ ] **Step 4: Run** `npm run test:mocks && npm run typecheck` → PASS
- [ ] **Step 5: Commit** `feat(mechanism): add mechanism and hypothesis page types and wiki.yaml`

---

### Task 2: Mechanism wiki context loader

**Files:**
- Create: `src/lib/mechanism-wiki/context.ts`
- Test: `src/lib/mechanism-wiki/context.test.ts`

**Interfaces:**
- Consumes: `parseDomainsYaml`, `parseWikiYaml`, `KNOWN_LENSES`, `readFile`/`listDirectory` from `@/commands/fs`.
- Produces:
  ```ts
  export interface LensDoc { id: string; text: string; promptText: string } // promptText = the Fields, Evidence standard, and Strength rules sections only; extracted fence-aware (the Example fence contains `## ` lines, and its frontmatter and links look like real pages)
  export interface MechanismContext {
    projectPath: string
    identity: WikiIdentity
    domains: DomainsConfig
    lenses: Record<string, LensDoc>            // every lenses/*.md file, id = file stem
    pageTypeRules: Record<string, string>      // schema/page-types/<type>.md text
    mechanismLibraryPath: string | null        // own path for reading wikis; resolved library path for work wikis
    configIssues: ConfigIssue[]                // parse problems; non-fatal
  }
  export async function loadMechanismContext(projectPath: string): Promise<MechanismContext | null> // null when domains.yaml is absent
  export function lensForDomain(ctx: MechanismContext, domain: string): LensDoc | null
  ```
  `loadMechanismContext` never throws for a present-but-invalid file: it records issues and uses empty defaults. Missing `wiki.yaml` → identity `{ id: "reading", role: "reading", mechanism_library: null }` plus one issue. A relative `mechanism_library` resolves against `projectPath`. Known lenses for `parseDomainsYaml` = `KNOWN_LENSES` plus every `lenses/*.md` stem.

- [ ] **Step 1: Failing tests** (mock `@/commands/fs` with an in-memory tree built from `materializeSampleWiki` output read into a map): `returns null without domains.yaml`; `loads sample wiki`; `custom lens file becomes a known lens`; `invalid domains.yaml records issues`; `missing wiki.yaml defaults to reading`; `work wiki resolves relative library path`; `lensForDomain` returns the hardware lens for `hardware/async-circuits`.
- [ ] **Step 2: Run** focused → FAIL
- [ ] **Step 3: Implement**
- [ ] **Step 4: Run** `npm run test:mocks && npm run typecheck` → PASS
- [ ] **Step 5: Commit** `feat(mechanism): load mechanism wiki context`

---

### Task 3: Prompt sections and the analysis/generation hooks

**Files:**
- Create: `src/lib/mechanism-wiki/prompts.ts`
- Modify: `src/lib/ingest.ts` (`autoIngestImpl` around line 779 context read, line 1081 analysis call, line 1136 generation call; `buildChunkAnalysisSystemPrompt` caller around line 3262)
- Test: `src/lib/mechanism-wiki/prompts.test.ts`, `src/lib/ingest-mechanism-prompts.test.ts`

**Interfaces:**
- Consumes: `MechanismContext`, `lensForDomain` (Task 2); `buildScopedIndexText` (Task 7 — until Task 7 lands, Task 3 uses a local stub that returns the full index; Task 7 replaces the stub).
- Produces:
  ```ts
  export function buildAnalysisAddendum(ctx: MechanismContext, hintDomain: string | null): string
  export function buildGenerationAddendum(ctx: MechanismContext, decisions: AnalysisDecisions): string
  export function domainHintFromSource(sourceContent: string): string | null // frontmatter `domain`, if it is in the list
  ```
  `buildAnalysisAddendum` contains: the domain list (name + description), an instruction to choose exactly one domain or propose one, the `## Decisions` line forms from Global Constraints, the mechanism skeleton (the six `MECHANISM_SECTIONS` en names with one-line meanings), the lens `promptText` for `hintDomain` (or the `## Fields` sections of all lenses, extracted fence-aware, when `hintDomain` is null), and the rule "a mechanism has no industry, vendor, or product detail".
  `buildGenerationAddendum` contains: `domain: <chosen>` must appear on every non-mechanism page; mechanism page rules from `ctx.pageTypeRules.mechanism`; section headings via `headingFor(..., outputLanguage)`; for `role: work`, "do not write wiki/mechanisms/ files; write the mechanism as a REVIEW block of type new-mechanism"; for each `MECHANISM: existing:<slug>`, "update wiki/mechanisms/<slug>.md: add one line under the known-instances heading".
- `ingest.ts` hook: load `mechanismCtx = await loadMechanismContext(pp)` next to the schema read. When non-null, append `buildAnalysisAddendum` to the analysis system prompt and `buildGenerationAddendum` to the generation system prompt, and pass the scoped index text instead of the full index. Keep the call order and arguments unchanged when null.

- [ ] **Step 1: Failing tests** — `analysis addendum lists domains and decision lines`; `uses one lens when a hint exists`; `uses all lens field sections without a hint`; `generation addendum for work wiki forbids mechanism files`; `generation addendum lists existing mechanisms to update`; `domainHintFromSource ignores unknown domains`; `upstream prompts unchanged`: for a non-mechanism project, the system prompts passed to `streamChat` equal the prompts from `buildAnalysisPrompt`/`buildGenerationPrompt` exactly (mock `streamChat` and capture messages).
- [ ] **Step 2: Run** focused → FAIL
- [ ] **Step 3: Implement**
- [ ] **Step 4: Run** `npm run test:mocks && npm run typecheck` → PASS
- [ ] **Step 5: Commit** `feat(mechanism): add domain and mechanism prompt sections to ingest`

---

### Task 4: Analysis decision parser

**Files:**
- Create: `src/lib/mechanism-wiki/decisions.ts`
- Test: `src/lib/mechanism-wiki/decisions.test.ts`
- Modify: `src/lib/ingest.ts` (parse decisions after the analysis call; pass them to `buildGenerationAddendum`)

**Interfaces:**
- Produces:
  ```ts
  export interface MechanismDecision { kind: "existing" | "new"; slug: string; summary: string }
  export interface AnalysisDecisions {
    domain: string | null                                   // a domain from the list
    proposedDomain: { path: string; lens: string; description: string } | null
    mechanisms: MechanismDecision[]
    problems: string[]                                      // human-readable parse problems
  }
  export function parseAnalysisDecisions(analysis: string, ctx: MechanismContext, fallbackDomain: string | null): AnalysisDecisions
  ```
  Rules: read only the last `## Decisions` section; accept `DOMAIN:` only when the path is in `ctx.domains`; a `DOMAIN:` path not in the list becomes `proposedDomain` with the lens of its nearest listed ancestor (else `problems`); `NEW-DOMAIN:` must match `DOMAIN_NAME_PATTERN` and a known lens; slugs must be kebab-case or CJK; `existing:` slugs must exist in the mechanism index (pass the set via `ctx`-derived helper from Task 7, stubbed here as all files under `wiki/mechanisms/` in the library); unknown `existing:` becomes `new:`. With no section, `domain = fallbackDomain` and `problems` names the gap.

- [ ] **Step 1: Failing tests** — `parses domain and mechanisms`; `uses the last Decisions section`; `unknown DOMAIN becomes a proposal`; `NEW-DOMAIN with bad name is a problem`; `existing slug not found becomes new`; `missing decisions falls back`; `ignores lines outside the section`.
- [ ] **Step 2: Run** focused → FAIL
- [ ] **Step 3: Implement and hook**
- [ ] **Step 4: Run** `npm run test:mocks && npm run typecheck` → PASS
- [ ] **Step 5: Commit** `feat(mechanism): parse domain and mechanism decisions from analysis`

---

### Task 5: Generation enforcement

**Files:**
- Create: `src/lib/mechanism-wiki/enforce.ts`
- Test: `src/lib/mechanism-wiki/enforce.test.ts`
- Modify: `src/lib/ingest.ts` (transform the generation text right before the first `writeFileBlocks(` call around line 1262; add returned review items to the ones collected around line 1533)

**Interfaces:**
- Consumes: `parseFileBlocks` (ingest.ts), `parseFrontmatter`, `AnalysisDecisions`.
- Produces:
  ```ts
  export interface EnforceResult { text: string; reviews: Omit<ReviewItem, "id" | "resolved" | "createdAt">[]; notes: string[] }
  export function enforceMechanismRules(generation: string, ctx: MechanismContext, decisions: AnalysisDecisions, sourcePath: string): EnforceResult
  ```
  Rules, applied per FILE block, then re-serialized in the same `---FILE: path---` / `---END FILE---` format and order:
  1. Pages under `wiki/mechanisms/`: remove `domain` and `also`; ensure `lenses` (default: lens of `decisions.domain`) and `instances` (default `[]`) exist.
  2. Every other page under `wiki/` except `index.md`, `log.md`, `overview.md`: set `domain` to `decisions.domain ?? decisions.proposedDomain?.path` when missing; keep an existing listed domain.
  3. Work wiki (`ctx.identity.role === "work"`): drop every `wiki/mechanisms/` block and add one `new-mechanism` review per dropped block with the block content in `description`, `affectedPages: [path]`, options `[{label:"Write to reading wiki", action:"mech:propose-mechanism"}, {label:"Skip", action:"Skip"}]`.
  4. `decisions.proposedDomain` → one `new-domain` review with options `[{label:"Approve", action:"mech:approve-domain"}, {label:"Skip", action:"Skip"}]` and the proposal encoded in `description` as a line `PROPOSAL: <path> | <lens> | <description>`.
  Non-FILE text (REVIEW blocks) passes through unchanged.

- [ ] **Step 1: Failing tests** — `adds missing domain to concept pages`; `keeps an existing listed domain`; `strips domain from mechanism pages and adds lenses`; `work wiki converts mechanism pages to proposals`; `proposed domain creates a new-domain review`; `leaves index, log, overview untouched`; `round-trips blocks it does not change byte-for-byte`.
- [ ] **Step 2: Run** focused → FAIL
- [ ] **Step 3: Implement and hook** (also extend `ReviewItem["type"]` in `src/stores/review-store.ts` with the four new types and add icons for them in `typeConfig` of `src/components/review/review-view.tsx`)
- [ ] **Step 4: Run** `npm run test:mocks && npm run typecheck` → PASS
- [ ] **Step 5: Commit** `feat(mechanism): enforce domain and mechanism rules on generated pages`

---

### Task 6: Source fingerprints and duplicate skipping

**Files:**
- Create: `src/lib/mechanism-wiki/source-fingerprint.ts`
- Test: `src/lib/mechanism-wiki/source-fingerprint.test.ts`
- Modify: `src/lib/ingest.ts` (in `autoIngestImpl`, after the source text is read and before analysis: in a mechanism wiki, check for a duplicate; on a hit, record it, add a `duplicate-source` review when the new text is ≥ 20% longer, and return early with no written files)

**Interfaces:**
- Produces:
  ```ts
  export function normalizeUrl(url: string): string
  export function shingleSimilarity(a: string, b: string): number         // 0..1
  export interface Fingerprint { sourcePath: string; url: string | null; textSample: string; length: number }
  export interface DuplicateHit { existing: Fingerprint; reason: "url" | "text"; score: number }
  export async function findDuplicateSource(projectPath: string, sourcePath: string, sourceContent: string): Promise<DuplicateHit | null>
  export async function recordFingerprint(projectPath: string, sourcePath: string, sourceContent: string): Promise<void>
  ```
  URL comes from frontmatter `url` or `source`, else the first `http(s)` URL in the first 20 lines. `textSample` = the first 4,000 normalized characters (normalize: lowercase, strip markdown punctuation, collapse whitespace). A hit on the same `sourcePath` is not a duplicate (re-ingest of an edited file). `recordFingerprint` runs after a successful ingest. The early return must not count as a failure: the ingest queue treats "no output files" as an error, so return the existing source summary path in the written list.

- [ ] **Step 1: Failing tests** — `normalizeUrl` strips tracking params and fragments and lowercases the host but keeps path case; `similar texts score ≥ 0.85` (same article, different whitespace and markdown); `different texts score < 0.3`; `url hit`; `text hit`; `same path is not a duplicate`; `ingest skips duplicate and returns existing summary` (ingest.ts mocked LLM: `streamChat` never called).
- [ ] **Step 2: Run** focused → FAIL
- [ ] **Step 3: Implement and hook**
- [ ] **Step 4: Run** `npm run test:mocks && npm run typecheck` → PASS
- [ ] **Step 5: Commit** `feat(mechanism): skip duplicate sources across entry points`

---

### Task 7: Domain-first index

**Files:**
- Create: `src/lib/mechanism-wiki/domain-index-render.ts` (pure: `IndexedPage`, `renderRootIndex`, `renderDomainIndex`, `renderMechanismIndex`, `domainIndexPath`, `indexedPageFromMarkdown(path, markdown)`; no `@/commands` imports, so `wiki-tool` can reuse it)
- Create: `src/lib/mechanism-wiki/domain-index.ts` (I/O: `scanWikiPages`, `rebuildDomainIndex`, `buildScopedIndexText`, `listMechanismSlugs`)
- Test: `src/lib/mechanism-wiki/domain-index-render.test.ts`, `src/lib/mechanism-wiki/domain-index.test.ts`
- Modify: `src/lib/ingest.ts` (where `updateWikiIndexDeterministically` is called around line 1388: in a mechanism wiki, call `rebuildDomainIndex` instead; replace the Task 3 stub with `buildScopedIndexText`)

**Interfaces:**
- Produces:
  ```ts
  export interface IndexedPage { path: string; slug: string; type: string; title: string; domain: string | null }
  export async function scanWikiPages(projectPath: string): Promise<IndexedPage[]>
  export function renderRootIndex(pages: IndexedPage[], domains: DomainsConfig): string
  export function renderDomainIndex(domain: string, pages: IndexedPage[]): string
  export function renderMechanismIndex(pages: IndexedPage[]): string
  export function domainIndexPath(domain: string): string              // "wiki/indexes/hardware--async-circuits.md"
  export async function rebuildDomainIndex(projectPath: string, ctx: MechanismContext): Promise<string[]> // written paths
  export async function buildScopedIndexText(projectPath: string, ctx: MechanismContext, domain: string | null): Promise<string>
  export async function listMechanismSlugs(libraryPath: string): Promise<Set<string>>
  ```
  Root index: `# Wiki Index`, then one line per domain in `domains.yaml` order sorted by path: `- [<domain>](indexes/<file>.md) — <N> pages`, then `- [Mechanisms](indexes/_mechanisms.md) — <N> pages`, then `- Unassigned — <N> pages` listing pages with no or unknown domain as `[[slug]]` lines. Domain index: `# <domain>` then `## <Type>` groups (fixed order: source, entity, concept, comparison, query, hypothesis) with `- [[slug]] — <title>` lines sorted by title. A hypothesis page has no `domain`; index it under its `to_domain` (ruling R19). A page whose `type` is not one of the seven types goes to the Unassigned list with its type in parentheses, so nothing is hidden. Mechanism index: one line per mechanism page. Output is deterministic (same input, same bytes). `rebuildDomainIndex` writes only files whose content changed. `buildScopedIndexText` = root index + mechanism index of `ctx.mechanismLibraryPath` + the domain index for `domain` when given.

- [ ] **Step 1: Failing tests** — `renders root index with counts`; `groups domain index by type in fixed order`; `unassigned pages are listed`; `index path replaces slashes`; `deterministic output`; `writes only changed files`; `scoped text includes the library mechanisms for a work wiki`; `non-mechanism project keeps old index` (ingest.ts hook still calls `updateWikiIndexDeterministically` when the context is null).
- [ ] **Step 2: Run** focused → FAIL
- [ ] **Step 3: Implement and hook**
- [ ] **Step 4: Run** `npm run test:mocks && npm run typecheck` → PASS
- [ ] **Step 5: Commit** `feat(mechanism): build a domain-first index`

---

### Task 8: Review actions and research staging

**Files:**
- Create: `src/lib/mechanism-wiki/review-actions.ts`
- Test: `src/lib/mechanism-wiki/review-actions.test.ts`
- Modify: `src/components/review/review-view.tsx` (`handleResolve`: one early call `if (await handleMechanismReviewAction(item, action, ctx)) return`)
- Modify: `src/lib/deep-research.ts` (at the point it writes the query page, around line 660–680: in a mechanism wiki, write to staging and add a `research-result` review instead)
- Test: `src/lib/deep-research-staging.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface ReviewActionContext { projectPath: string; resolveItem(id: string, label: string): void; refresh(): Promise<void> }
  export async function handleMechanismReviewAction(item: ReviewItem | undefined, action: string, ctx: ReviewActionContext): Promise<boolean> // true = handled
  export async function stageResearchResult(projectPath: string, fileName: string, content: string): Promise<Omit<ReviewItem, "id" | "resolved" | "createdAt">>
  ```
  Actions:
  - `mech:approve-domain`: parse the `PROPOSAL:` line; append the new entry as text to `domains.yaml` (do not re-dump the file: `dump` deletes the template's and the user's comments; when the file has `domains: {}`, replace that one line with `domains:` first), re-validate the result with `parseDomainsYaml` using the lens file names in `lenses/` as known lenses, write, resolve as `Approved`. Invalid result → do not write; throw an error the view shows.
  - `mech:propose-mechanism`: write the proposal to `<mechanism_library>/raw/sources/proposals/<slug>.md` with frontmatter `source_kind: note`, `title`, `proposed_from: <wiki id>`; never include the original source path. Resolve as `Sent to reading wiki`. The reading wiki ingests it when that project is active.
  - `mech:replace-source`: overwrite the older raw source with the newer text, then resolve; the file watcher re-ingests it.
  - `mech:accept-research`: move `.llm-wiki/research-staging/<file>` to `wiki/queries/<file>`, resolve as `Saved`.
  - Any other action → return `false` (upstream handling continues).

- [ ] **Step 1: Failing tests** — one per action (mock `@/commands/fs`); `approve-domain rejects an invalid proposal`; `propose-mechanism writes only to the library path`; `unknown action is not handled`; `deep research stages in a mechanism wiki and writes directly otherwise`.
- [ ] **Step 2: Run** focused → FAIL
- [ ] **Step 3: Implement and hook**
- [ ] **Step 4: Run** `npm run test:mocks && npm run typecheck` → PASS
- [ ] **Step 5: Commit** `feat(mechanism): add review actions and stage deep research results`

---

### Task 9: Fix the chat ingest schema path and an end-to-end test

**Files:**
- Modify: `src/lib/ingest.ts` around line 3663 (`startIngest`): read `${pp}/schema.md` and `${pp}/purpose.md`, falling back to `${pp}/wiki/schema.md` and `${pp}/wiki/purpose.md`
- Test: `src/lib/ingest-start-schema-path.test.ts`
- Test: `src/lib/__tests__/mechanism-ingest.e2e.test.ts`

**Interfaces:**
- Consumes: everything above; `materializeSampleWiki` (sub-project 0).

- [ ] **Step 1: Failing tests**
  - `startIngest reads root schema and purpose`, `falls back to wiki/ copies`.
  - E2E (in-memory fs mock over a materialized sample wiki; `streamChat` mocked with canned analysis and generation text): ingest `async-handshake-circuits.md` then `spiking-neural-networks.md`. Expect: `wiki/mechanisms/event-driven-computation.md` exists with both instance slugs; both source pages have their own `domain`; `wiki/index.md` lists `hardware/async-circuits` and `ai/architecture` with counts; `wiki/indexes/_mechanisms.md` lists the mechanism; re-ingesting a whitespace-changed copy of the first source under a new file name is skipped as a duplicate.
- [ ] **Step 2: Run** focused → FAIL
- [ ] **Step 3: Implement the path fix; fix any integration gaps the E2E finds**
- [ ] **Step 4: Run** `npm run test:mocks && npm run typecheck` → PASS
- [ ] **Step 5: Commit** `fix(ingest): read root schema in chat ingest; add mechanism ingest e2e test`
