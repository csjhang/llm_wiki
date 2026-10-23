# Sub-project 5: Domain Lint and Domain Recut — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Layer-1 structural lint runs in the app after every ingest. Layers 2 and 3 (domain semantics, mechanism layer) run as the `wiki-lint` skill, one domain at a time, and only for domains that changed. `wiki-recut` renames, splits, merges, and moves domains with one commit.

**Architecture:** Layer 1 is a pure checker (`src/lib/mechanism-wiki/lint-structure.ts`) fed by a scan, shown in the existing lint view, and reused by `wiki-tool lint structure`. Layers 2–3 run in Claude Code because they need careful reading: `wiki-tool lint changed-domains` picks the domains, the skill reads full pages and files findings as review items through `llm_wiki_add_review`, and `wiki-tool lint mark` records the commit where the semantic lint ran. `wiki-tool recut` applies a confirmed plan to `domains.yaml` and page frontmatter and rebuilds the domain index with the shared pure renderers.

**Tech Stack:** TypeScript, vitest, `js-yaml`, bundled `wiki-tool`.

**Spec:** `docs/superpowers/specs/2026-10-23-mechanism-wiki-heptabase-design.md` (sections 9.1, 9.2, 12 row 5)

## Global Constraints

- Thresholds live in `wiki.yaml` under `lint:` with defaults `draft_days: 30`, `max_domain_pages: 200`, `min_domain_pages: 3`, `semantic_reminder_ingests: 10`. (Ruling: the spec put thresholds in `schema.md`, but prose is not machine-readable; `wiki.yaml` is the wiki-level config file. Update spec section 9.1.)
- Layer-1 check ids: `domain-missing`, `domain-unknown`, `concept-cross-domain`, `mechanism-no-instance`, `mirror-retired`, `map-missing-page`, `hypothesis-stale-draft`, `domain-too-large`, `domain-too-small`.
- Semantic lint findings are review items (`contradiction`, `duplicate`, `suggestion`, or `confirm`), never automatic edits.
- Semantic lint marker: `.llm-wiki/semantic-lint.json` `{ "commit": "<sha>", "at": "<iso>" }`. "Changed domains" = domains of pages changed between that commit and `HEAD`, plus their `also` domains.
- Recut commit subject: `recut: <operation> <from> → <to> (<N> pages)`.
- Commit trailer: your session's Co-Authored-By line plus `Claude-Session: https://claude.ai/code/session_013yG6txX1fFsHyk4VQiasu7`.
- Verification: `npm run test:mocks`, `npm run typecheck`, `npm run build:wiki-tool`.

## Review Focus

1. A concept page whose two sources are in two domains. Expected: `concept-cross-domain` with both domains named. (Task 1 test.)
2. Splitting a domain where some pages fit neither new domain. Expected: `recut apply` refuses a plan that leaves pages unassigned; the skill asks the user about them. (Task 4 test `rejects unassigned pages`.)
3. A recut while the working tree has uncommitted changes. Expected: refused with a clear message. (Task 4 test `refuses a dirty tree`.)
4. No semantic-lint marker yet. Expected: `changed-domains` returns every domain once. (Task 3 test.)
5. A mirror card marked retired in the card map. Expected: `mirror-retired` lists its title so the user can delete it by hand. (Task 1 test.)

---

### Task 1: Layer-1 structural checker

**Files:**
- Create: `src/lib/mechanism-wiki/lint-structure.ts` (pure)
- Modify: `src/lib/wiki-config/wiki-identity.ts` (optional `lint` block with defaults) and its test
- Test: `src/lib/mechanism-wiki/lint-structure.test.ts`

**Interfaces:**
- Consumes: `IndexedPage` and `indexedPageFromMarkdown` (sub-project 2), `DomainsConfig`, `WikiIdentity`.
- Produces:
  ```ts
  export interface StructureInput { pages: (IndexedPage & { sources: string[]; also: string[]; status?: string; updated?: string; instances?: string[] })[]; domains: DomainsConfig; identity: WikiIdentity; cardMap: { pages: Record<string, { status: string; card_id: string }> } | null; today: string }
  export interface StructureFinding { check: string; page: string | null; message: string; domains?: string[] }
  export function checkStructure(input: StructureInput): StructureFinding[]
  ```
  `concept-cross-domain`: a concept or entity page whose `sources` resolve to source pages with two or more different `domain` values. `mechanism-no-instance`: reading wiki only. Messages are short English sentences.

- [ ] **Step 1: Failing tests** — one per check id, plus `work wiki skips mechanism-no-instance`, `custom thresholds from wiki.yaml apply`.
- [ ] **Step 2: Run** focused → FAIL
- [ ] **Step 3: Implement**
- [ ] **Step 4: Run** verification → PASS
- [ ] **Step 5: Commit** `feat(lint): add structural checks for mechanism wikis`

---

### Task 2: Run layer 1 in the app

**Files:**
- Modify: `src/lib/lint.ts` (in a mechanism wiki, add `checkStructure` findings to the structural lint result as type `"structure"`; keep existing checks)
- Modify: `src/lib/ingest-queue.ts` (after a successful ingest in a mechanism wiki, run the structural lint quietly and store results the same way the lint view does)
- Modify: `src/components/lint/lint-view.tsx` only to show the new type with an icon
- Test: `src/lib/lint-structure-integration.test.ts`

**Interfaces:**
- Produces: `export async function runMechanismStructuralLint(projectPath: string): Promise<StructureFinding[]>` in `src/lib/mechanism-wiki/lint-run.ts` (scan + `checkStructure`).

- [ ] **Step 1: Failing tests** — `lint result includes structure findings in a mechanism wiki`; `non-mechanism project unchanged`; `runs after a successful ingest`; `lint failure never fails the ingest`.
- [ ] **Step 2–5:** run → FAIL; implement; run verification → PASS; commit `feat(lint): run structural lint after ingest`

---

### Task 3: `wiki-tool lint` commands

**Files:**
- Create: `tools/wiki-tool/src/lint/structure.ts`, `tools/wiki-tool/src/lint/changed-domains.ts`, `tools/wiki-tool/src/lint/mark.ts`
- Test: matching `*.test.ts` files

**Interfaces:**
- Produces:
  - `wiki-tool lint structure --project P` → `{ ok, findings }` (node fs scan + `checkStructure`).
  - `wiki-tool lint changed-domains --project P` → `{ ok, since: sha | null, domains: string[], mechanismsChanged: boolean, ingestsSince: number }`.
  - `wiki-tool lint mark --project P` → writes the marker with `HEAD`.
  - `wiki-tool lint batch --project P --domain D [--max-chars 60000]` → `{ ok, batches: string[][] }` page paths grouped by type so each batch's total file size stays under the limit.

- [ ] **Step 1: Failing tests** (temp git repos) — `no marker returns every domain`; `returns domains changed since the marker`; `includes also domains`; `counts ingest commits since the marker`; `batches stay under the size limit`; `mark writes HEAD`.
- [ ] **Step 2–5:** run → FAIL; implement, register, rebuild; verification → PASS; commit `feat(wiki-tool): add lint helper commands`

---

### Task 4: `wiki-tool recut`

**Files:**
- Create: `tools/wiki-tool/src/recut/plan.ts`, `tools/wiki-tool/src/recut/apply.ts`
- Test: matching `*.test.ts` files

**Interfaces:**
- Produces:
  ```ts
  export type RecutPlan =
    | { op: "rename" | "move"; from: string; to: string }
    | { op: "split"; from: string; into: { domain: string; lens: string; description: string }[]; assignments: Record<string, string> } // page path -> new domain
    | { op: "merge"; from: string[]; into: { domain: string; lens: string; description: string } }
  ```
  `wiki-tool recut pages --project P --domain D` → the pages in D with title and first 300 characters (input for the skill's assignment proposal).
  `wiki-tool recut apply --project P --plan <json>` → validates (target names match the domain pattern; split assigns every page of `from`; no target already exists except for merge; tree is clean), rewrites `domains.yaml` (child domains of a renamed or moved domain move too), rewrites `domain` and `also` in page frontmatter without touching other bytes, rebuilds the domain index with the pure renderers, and commits with the recut subject. Merge reports same-slug pairs across the merged domains as `mergeCandidates` in the output (the skill files them as `duplicate` reviews).

- [ ] **Step 1: Failing tests** — `rename moves child domains`; `split assigns pages`; `rejects unassigned pages`; `merge reports same-slug pairs`; `refuses a dirty tree`; `keeps other frontmatter bytes`; `commit subject format`.
- [ ] **Step 2–5:** run → FAIL; implement, register, rebuild; verification → PASS; commit `feat(wiki-tool): add domain recut`

---

### Task 5: `wiki-lint` and `wiki-recut` skills

**Files:**
- Create: `plugins/llm-wiki/skills/wiki-lint/SKILL.md`, `plugins/llm-wiki/skills/wiki-recut/SKILL.md`

`wiki-lint` (STE English): run `lint structure` and show it; run `lint changed-domains`; for each domain, run `lint batch` and read every page in full; find contradictions, superseded claims, and duplicate pages; then read every mechanism page in full with its instances' first sections and check: industry detail inside a mechanism, two mechanisms that are the same, an instance that does not fit, missing failure conditions; file each finding with `llm_wiki_add_review` (one item per finding, with `affectedPages`); never edit pages; at the end run `lint mark` and report counts.
`wiki-recut` (STE English): ask which operation; for split, read `recut pages` and propose an assignment with one reason per page; ask about pages that fit no target; show the full plan and wait for a yes; tell the user which select options to add in Heptabase before the next `wiki-sync`; run `recut apply`; file merge candidates as `duplicate` reviews; report.

- [ ] **Step 1: Write both skills**
- [ ] **Step 2: Run** `npm run test:mocks` and `findLongSentences` on both → PASS / `[]`
- [ ] **Step 3: Commit** `feat(skill): add wiki-lint and wiki-recut skills`
