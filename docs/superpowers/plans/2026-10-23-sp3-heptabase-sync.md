# Sub-project 3: Heptabase Interface (`wiki-tool hepta` + `wiki-sync`) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A deterministic local tool (`wiki-tool`, command group `hepta`) plans every Heptabase change, converts formats, and keeps the card map. A `wiki-sync` skill runs the plan through the Heptabase MCP tools, one recorded step at a time.

**Architecture:** Plan, execute, record. The tool never calls Heptabase; it reads and writes local files only. The skill (an AI agent in Claude Code) calls the Heptabase MCP tools, saves their raw text output to files under `.llm-wiki/hepta/`, and passes those files to the tool. The tool parses that text, so its parsers are tested against real output shapes. The tool source lives in `tools/wiki-tool/src/` (TypeScript, reuses `src/lib/wiki-config/`), and is bundled into one dependency-free file `plugins/llm-wiki/scripts/wiki-tool.mjs` that is committed.

**Tech Stack:** TypeScript, rolldown (bundle), Node 20+, vitest, `js-yaml`.

**Spec:** `docs/superpowers/specs/2026-10-23-mechanism-wiki-heptabase-design.md` (sections 7.1–7.7, 6.2, 12 row 3)

## Global Constraints

- The tool never makes network calls and never edits a file outside the given `--project` folder.
- Every command prints one JSON object to stdout. Exit 0 = ok, 2 = handled problem (JSON has `"ok": false` and `"problems"`), 1 = unexpected error.
- Map file: `<project>/heptabase-map.json`, shape from spec 7.6, written atomically (write temp file, then rename).
- MCP raw outputs saved by the skill go to `<project>/.llm-wiki/hepta/` (git-ignored with `.llm-wiki/`).
- Card link format: `[<title>](heptabase://card/<uuid>)`. Unsynced link: `<title>（僅在 wiki）`.
- Mirror footer, exactly two lines after a `---` line: `來源：<comma-separated card links, or "無">` and `由 wiki 產生，請勿直接編輯。`
- Retired card: title prefix `🗄 已停用｜`, body `請看 → <link to replacement>` (or `此頁已從 wiki 移除。`).
- Sync eligibility: `type` in `mechanism`, `hypothesis`, `comparison`, or `concept` with `sources` length ≥ 2.
- Property values: `page type` = page `type`; `wiki` = `wiki.yaml` `id`; `status` = `active` or `retired`; `domain` = page `domain` (mechanism pages: omit; hypothesis pages: `to_domain`, ruling R19); `wiki page` = project-relative path; `last synced` = `{ "start": "<YYYY-MM-DD>T00:00:00.000Z" }`; hypotheses add `hypothesis status` (= `status` field) and `strength`.
- Snapshot path: `raw/sources/heptabase/<card-id>.md`; frontmatter keys `title`, `heptabase_card_id`, `heptabase_whiteboards` (titles), `card_updated_at`, `url` (or omitted), `source_kind`, `domain` (only when a whiteboard hint maps to exactly one listed domain).
- Verification: `npm run test:mocks`, `npm run typecheck`, and `npm run build:wiki-tool` (the bundle test fails when the committed bundle is stale).
- Git coordination (sub-project 1 final review I7): `wiki-tool` owns one JS commit helper (`tools/wiki-tool/src/git.ts`) that applies the same rules as the app (fallback identity per missing field, `--no-verify`, `-c commit.gpgsign=false`, `.llm-wiki/` never committed, commit only listed paths) and takes `.llm-wiki/git.lock` (create-exclusive, holds pid and start time, stale after 10 minutes) around every git write. The app's `git-history.ts` and `undo.mjs` honor the same lock: wait up to 30 s, then report "another wiki tool is using git". Add this in Task 1 with tests.
- Commit trailer: your session's Co-Authored-By line plus `Claude-Session: https://claude.ai/code/session_013yG6txX1fFsHyk4VQiasu7`.

## Review Focus

1. A Heptabase card title with `"`, `|`, `]`, or a newline. Expected: parsers and converters keep the title intact and links stay valid. (Task 2 test `parses titles with quotes and brackets`, Task 3 test `escapes link titles`.)
2. The skill crashes halfway through a down-sync. Expected: rerunning `plan-down` does not plan a second `create` for a page already recorded. (Task 5 test `resumes after partial run`.)
3. A user edits a mirror card. Expected: `plan-down` plans `skip-edited`, not `update`. (Task 5 test `detects user edits`.)
4. A card on two whiteboards under two different roots. Expected: `plan-up` marks it `ask` instead of guessing. (Task 6 test `card under two roots needs a decision`.)
5. A long card whose `read_object` output came in several pages with line-number prefixes. Expected: the snapshot joins pages in order with no prefixes. (Task 6 test `joins paged read_object output`.)

---

### Task 1: Tool scaffold, bundle, and contract test

**Files:**
- Create: `tools/wiki-tool/src/cli.ts`, `tools/wiki-tool/src/io.ts`
- Create: `tools/wiki-tool/tsconfig.json` (extends the app config, `include: ["src", "../../src/lib/wiki-config"]`, `types: ["node"]`)
- Modify: `package.json` (devDependency `rolldown` pinned to the installed version; scripts `build:wiki-tool`; add `tools/wiki-tool` to `typecheck`)
- Create: `plugins/llm-wiki/scripts/wiki-tool.mjs` (bundle output, committed)
- Test: `tools/wiki-tool/src/cli.test.ts`, `src/lib/__tests__/wiki-tool-bundle.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // io.ts
  export interface CommandResult { ok: boolean; [key: string]: unknown }
  export function readJsonFile<T>(path: string): T
  export function writeFileAtomic(path: string, content: string): void
  export function resolveInProject(projectPath: string, relative: string): string // throws when the result leaves projectPath
  // cli.ts
  export async function runCli(argv: string[]): Promise<{ exitCode: 0 | 1 | 2; output: CommandResult }>
  ```
  Command groups: `hepta` (this sub-project: `init`, `plan-down`, `plan-up`, `snapshot`, `record`), `recut` and `lint` (sub-project 5), `fuse` (sub-project 4). Each group registers its commands in its own file. This task adds `version` (prints `{ ok: true, version }` from the plugin manifest version) and the two-level dispatcher (`wiki-tool <group> <command>`; unknown group or command → exit 2, `problems: ["unknown command: x"]`).

- [ ] **Step 1: Failing tests** — `version prints plugin version`; `unknown command exits 2`; `resolveInProject rejects ../`; `writeFileAtomic leaves no temp file`; bundle test: run `npm run build:wiki-tool` into a temp dir and compare bytes with the committed bundle; run `node <bundle> version` and parse JSON.
- [ ] **Step 2: Run** `npx vitest run tools/wiki-tool src/lib/__tests__/wiki-tool-bundle.test.ts` → FAIL (make sure vitest picks up `tools/`; add it to the test include if the config limits roots)
- [ ] **Step 3: Implement, bundle with rolldown (`--platform node --format esm`, all dependencies inlined)**
- [ ] **Step 4: Run** `npm run test:mocks && npm run typecheck` → PASS
- [ ] **Step 5: Commit** `feat(wiki-tool): add tool scaffold and bundled CLI`

---

### Task 2: Parsers for Heptabase MCP text output

**Files:**
- Create: `tools/wiki-tool/src/parse-mcp.ts`
- Create: `tools/wiki-tool/fixtures/*.txt` (anonymized real outputs: every UUID replaced with `00000000-0000-4000-8000-0000000000NN`, every title replaced with generic text)
- Test: `tools/wiki-tool/src/parse-mcp.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface CardRef { id: string; title: string; type: string; whiteboards: { id: string; title: string }[]; tags: string[]; createdAt?: string; updatedAt?: string }
  export interface WhiteboardNode { id: string; title: string; parentId: string | null }
  export interface WhiteboardStructure { id: string; title: string; sections: { id: string; title: string; cards: { id: string; title: string; type: string }[] }[]; unsectioned: { id: string; title: string; type: string }[]; mindMapIds: string[] }
  export function parseListCards(text: string): CardRef[]
  export function parseListWhiteboards(text: string): WhiteboardNode[]          // indentation gives the parent
  export function parseWhiteboardStructure(text: string): WhiteboardStructure
  export function parseMindMap(text: string): { id: string; title: string }[]   // card nodes in order
  export function joinReadObjectPages(pages: string[]): string                  // strips "<n>\t" prefixes, joins in line order
  ```
  Input is either the raw MCP text or the JSON envelope `{"content": "...", "status": "succeeded"}`; accept both. The line shapes to support (from real output on 2026-10-23):
  - list_cards: `card "<title>" [<uuid>] whiteboards: <t1> [<id1>], <t2> [<id2>], tags: <none|...>, created: <iso>; updated: <iso>`
  - list_whiteboards: `whiteboard "<title>" [<uuid>] <counts>` with two-space indentation per level
  - read_whiteboard structure: header `whiteboard "<title>" [<uuid>] Parent: ...`, `section "<title>" [<uuid>]` lines, indented `card "<title>" [<uuid>]` lines, `(unsectioned)`, `mindMap "<title>" [<uuid>] N nodes`
  - mindMap object: `<n>\t  card "<title>" cardId: [<uuid>], nodeId: [<uuid>]`
  Titles may contain `"`; the title is the text between the first `"` after the keyword and the last `" [` before the id.

- [ ] **Step 1: Failing tests** — one per parser on fixtures; `parses titles with quotes and brackets`; `accepts JSON envelope`; `list_whiteboards builds parents from indentation`; `structure includes mind map ids`; `joins paged read_object output` (pages 1–40, 41–80 with prefixes) and `keeps tab characters inside content after the prefix`.
- [ ] **Step 2: Run** focused → FAIL
- [ ] **Step 3: Implement**
- [ ] **Step 4: Run** `npm run test:mocks && npm run typecheck` → PASS
- [ ] **Step 5: Commit** `feat(wiki-tool): parse Heptabase MCP text output`

---

### Task 3: Markdown ↔ Hepta Markdown converters

**Files:**
- Create: `tools/wiki-tool/src/convert.ts`
- Test: `tools/wiki-tool/src/convert.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface LinkTarget { cardId: string; title: string }
  export function wikiPageToCard(markdown: string, opts: { title: string; resolveLink(slug: string): LinkTarget | null; titleForSlug(slug: string): string; sourceCards: LinkTarget[] }): string
  export function cardToSnapshotBody(heptaMarkdown: string): string
  export function cardLink(target: LinkTarget): string
  ```
  `wikiPageToCard`: drop YAML frontmatter; first line becomes `# <title>` (replace an existing H1, never duplicate it); `[[slug]]` and `[[slug|label]]` become `cardLink` when resolvable, else `<label or title>（僅在 wiki）`; append the footer from Global Constraints. Escape `[`, `]` in link titles with `\`.
  `cardToSnapshotBody`: `<hepta-mention ...>Title</hepta-mention>` → `Title`; `[t](heptabase://card/<id>)` → `t`; `<hepta-color ...>x</hepta-color>` → `x`; keep `<hepta-placeholder .../>` and complex tables as an HTML comment `<!-- heptabase: unsupported block -->`.

- [ ] **Step 1: Failing tests** — `replaces frontmatter with H1 title`; `does not duplicate an existing H1`; `resolves wikilinks to card links`; `marks unsynced links`; `uses wikilink label`; `escapes link titles`; `adds footer with source cards`; `footer says 無 without source cards`; `snapshot strips mentions, colors, and card links`; `snapshot marks unsupported blocks`.
- [ ] **Step 2: Run** focused → FAIL
- [ ] **Step 3: Implement**
- [ ] **Step 4: Run** `npm run test:mocks && npm run typecheck` → PASS
- [ ] **Step 5: Commit** `feat(wiki-tool): convert between wiki markdown and Hepta Markdown`

---

### Task 4: Card map and `init`

**Files:**
- Create: `tools/wiki-tool/src/card-map.ts`, `tools/wiki-tool/src/cmd-init.ts`
- Test: `tools/wiki-tool/src/card-map.test.ts`, `tools/wiki-tool/src/cmd-init.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface PageEntry { card_id: string; content_hash: string; last_synced_at: string; card_updated_at: string; placements: string[]; status: "active" | "retired" }
  export interface SourceEntry { raw_path: string; card_updated_at: string; ingest_commit: string | null }
  export interface CardMap { version: 1; pages: Record<string, PageEntry>; sources: Record<string, SourceEntry>; whiteboards_cache: { updated_at: string; items: WhiteboardNode[] } }
  export function loadCardMap(projectPath: string): CardMap                  // empty map when absent
  export function saveCardMap(projectPath: string, map: CardMap): void        // atomic
  export function contentHash(text: string): string                           // sha256 hex
  ```
  `wiki-tool hepta init --project P --database <read_database json file> --whiteboards <list_whiteboards txt> --ingest-tag <uuid> --mirror-tag <uuid> --root <uuid> [--root <uuid>...] [--source-board <uuid>...] [--archive-board <uuid>...]`: map property names `domain`, `page type`, `wiki`, `status`, `wiki page`, `last synced`, `hypothesis status`, `strength` to ids from the database JSON; write `heptabase.yaml`; validate it with `parseHeptabaseYaml`; refuse to overwrite an existing file unless `--force`; store the parsed whiteboard tree in the map cache. Missing required property → exit 2 naming it.

- [ ] **Step 1: Failing tests** — map round-trip; atomic save; `contentHash` stable; init writes a valid file from fixtures; init reports a missing `status` property; init refuses overwrite.
- [ ] **Step 2: Run** focused → FAIL
- [ ] **Step 3: Implement**
- [ ] **Step 4: Run** `npm run test:mocks && npm run typecheck && npm run build:wiki-tool` → PASS
- [ ] **Step 5: Commit** `feat(wiki-tool): add card map and init command`

---

### Task 5: `plan-down` and `record`

**Files:**
- Create: `tools/wiki-tool/src/cmd-plan-down.ts`, `tools/wiki-tool/src/cmd-record.ts`
- Test: `tools/wiki-tool/src/cmd-plan-down.test.ts`, `tools/wiki-tool/src/cmd-record.test.ts`

**Interfaces:**
- Consumes: converters (Task 3), card map (Task 4), `parseWikiYaml`, `parseHeptabaseYaml`, `parseListCards` (for current `updatedAt` of mirror cards).
- Produces:
  ```ts
  export type DownAction =
    | { op: "create"; page: string; title: string; body: string; properties: PropertyEdit[] }
    | { op: "update"; page: string; cardId: string; title: string; body: string; properties: PropertyEdit[] }
    | { op: "relink"; page: string; cardId: string; body: string }
    | { op: "retire"; page: string; cardId: string; title: string; body: string; properties: PropertyEdit[] }
    | { op: "skip-edited"; page: string; cardId: string; cardUpdatedAt: string }
    | { op: "place"; page: string; cardId: string; whiteboardId: string }
  export interface PropertyEdit { propertyId: string; type: "select" | "text" | "date"; value: unknown }
  ```
  `wiki-tool hepta plan-down --project P [--mirror-cards <list_cards txt of the mirror tag>]` → `{ ok, actions: DownAction[], pass: 1 | 2 }`. Pass 1 plans `create` (with unresolved links marked), `update`, `retire`, and `skip-edited`; when pass 1 is fully recorded and some created pages link to each other, pass 2 plans `relink`. An `update` is planned only when `contentHash` changed. A `place` is planned for a hypothesis page whose frontmatter `heptabase_whiteboard` is not yet in the entry's `placements` (after its card exists). `skip-edited` when the card's current `updatedAt` is later than `last_synced_at` by more than 60 seconds.
  `wiki-tool hepta record --project P --event <json>` events: `{"type":"created","page","cardId","cardUpdatedAt"}`, `{"type":"updated","page","cardUpdatedAt"}`, `{"type":"placed","page","whiteboardId"}`, `{"type":"retired","page"}`, `{"type":"feedback","page","cardId","content"}` (writes `raw/sources/heptabase/feedback-<cardId>-<yyyymmddhhmm>.md` with `source_kind: note`). Each event updates the map and saves it immediately.

- [ ] **Step 1: Failing tests** — `plans create for an eligible new page`; `skips ineligible pages` (concept with one source); `plans update only when content changed`; `detects user edits`; `plans retire when a mapped page is deleted`; `omits domain for mechanism pages`; `adds hypothesis properties`; `plans relink in pass 2`; `plans place for a hypothesis once`; `resumes after partial run` (record one `created`, re-plan → that page is not planned as `create`); record writes each event type; feedback writes a note snapshot.
- [ ] **Step 2: Run** focused → FAIL
- [ ] **Step 3: Implement**
- [ ] **Step 4: Run** `npm run test:mocks && npm run typecheck && npm run build:wiki-tool` → PASS
- [ ] **Step 5: Commit** `feat(wiki-tool): plan wiki-to-Heptabase changes and record results`

---

### Task 6: `plan-up` and `snapshot`

**Files:**
- Create: `tools/wiki-tool/src/cmd-plan-up.ts`, `tools/wiki-tool/src/cmd-snapshot.ts`
- Test: `tools/wiki-tool/src/cmd-plan-up.test.ts`, `tools/wiki-tool/src/cmd-snapshot.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type UpAction =
    | { op: "snapshot"; cardId: string; title: string; cardType: string; whiteboards: { id: string; title: string }[] }
    | { op: "ask"; cardId: string; title: string; reason: "two-roots" | "no-root" }
    | { op: "download-pdf"; cardId: string; title: string }
  ```
  `wiki-tool hepta plan-up --project P --cards <list_cards txt> [--cards <txt>...] [--whiteboards <list_whiteboards txt>]` → `{ ok, actions }`. A card is planned when it is not in `sources` or its `updatedAt` is newer than the recorded `card_updated_at`. Root membership walks the whiteboard tree from the map cache (refreshed when `--whiteboards` is given). Cards on an `archive` board are skipped. Cards whose mirror entry exists in `pages` are never snapshotted (they are AI output).
  `wiki-tool hepta snapshot --project P --card-id ID --title T --card-type TYPE --whiteboards <json> --content <file with joined read_object text> [--url U] [--updated-at ISO]` writes the snapshot file with the frontmatter from Global Constraints and records the source entry. `source_kind`: `article` for `webCard`/`pdfCard` or a `source` board; else `note`. `domain`: from `domains.yaml` `whiteboards` hints when exactly one domain matches.

- [ ] **Step 1: Failing tests** — `plans new cards`; `skips unchanged cards`; `replans updated cards`; `card under two roots needs a decision`; `card under no root needs a decision`; `skips archive boards`; `never snapshots mirror cards`; `plans pdf download`; snapshot writes frontmatter and body; `marks web cards as article`; `adds domain from a unique whiteboard hint`; `omits domain when hints are ambiguous`.
- [ ] **Step 2: Run** focused → FAIL
- [ ] **Step 3: Implement**
- [ ] **Step 4: Run** `npm run test:mocks && npm run typecheck && npm run build:wiki-tool` → PASS
- [ ] **Step 5: Commit** `feat(wiki-tool): plan Heptabase-to-wiki snapshots`

---

### Task 7: `wiki-sync` skill

**Files:**
- Create: `plugins/llm-wiki/skills/wiki-sync/SKILL.md`
- Create: `plugins/llm-wiki/skills/wiki-sync/reference/mcp-steps.md` (one section per MCP call: tool name, exact arguments, where to save output)
- Modify: `src/lib/__tests__/plugin-contract.test.ts` (each `scripts/*.mjs` that a SKILL.md names must exist)

**Interfaces:**
- Consumes: every tool command above; Heptabase MCP tools `list_tags`, `read_database`, `list_whiteboards`, `list_cards`, `read_object`, `read_whiteboard`, `create_object`, `edit_object_content`, `update_database_card_membership`, `edit_card_properties`, `get_file_download_url`; llm_wiki MCP `llm_wiki_status`.

SKILL.md (STE English) sections: Purpose; Before you start (check `heptabase.yaml`; if absent run the init flow; check the app with `llm_wiki_status` and say that ingest waits for the app); Up (Heptabase → wiki) steps; Down (wiki → Heptabase) steps; Rules (record after every MCP call that changed Heptabase; never edit a card that is not in the map; on `clientTaskFailed` retry once with `runOn: {type: "server"}`; on a missing select option stop that card and tell the user which option to add; ask the user about every `ask` action); Report (counts per action, plus problems). Every command line uses `node "<plugin dir>/scripts/wiki-tool.mjs" hepta ...`.

- [ ] **Step 1: Failing test** — contract test for referenced scripts.
- [ ] **Step 2: Run** focused → FAIL
- [ ] **Step 3: Write the skill and reference**
- [ ] **Step 4: Run** `npm run test:mocks && npm run typecheck` → PASS; check `findLongSentences` on both files returns `[]`.
- [ ] **Step 5: Commit** `feat(skill): add wiki-sync skill`

---

## Live test protocol (run by the controller after Task 7, with the user's test setup)

Use only the test tag `#wiki-test` (mirror), `#ingest-test` (ingest), and the test whiteboard the user named. Steps: init against the test tags; add two or three chosen test-whiteboard cards to `#ingest-test`; run up-sync into a scratch wiki outside the repo; ingest with a mocked or real LLM as available; run down-sync; check the cards in `#wiki-test`; record every created card id so the user can delete them afterwards.
