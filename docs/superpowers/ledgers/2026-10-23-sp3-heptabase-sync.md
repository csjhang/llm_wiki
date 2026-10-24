# SDD ledger — plan: docs/superpowers/plans/2026-10-23-sp3-heptabase-sync.md

Spec: docs/superpowers/specs/2026-10-23-mechanism-wiki-heptabase-design.md (reachable; sections 7.1–7.7, 6.2, 12 row 3). Branch: design/heptabase-wiki. Depends on SP0 (wiki-config parsers), SP1 (git history), SP2 (wiki.yaml, page types, domain index).

## Pre-flight scan

| Pair / task | Produces vs consumes | Finding |
|---|---|---|
| T1 self vs Global Constraints | the git helper + `.llm-wiki/git.lock` constraint said "Add this in Task 1", but T1's file list has no git files, and the lock touches Rust and undo.mjs | CONFLICT -> Ruling Q1 |
| T1 -> T2..T6 | cli dispatcher, io helpers | consistent |
| T2 self | fixtures must be "anonymized real outputs"; implementers cannot safely call the user's Heptabase | gap -> Ruling Q2 |
| T2 -> T4/T5/T6 | parseListWhiteboards → map cache (T4), parseListCards → plan-down (T5) and plan-up (T6) | consistent |
| T3 -> T5 | wikiPageToCard, cardLink | consistent |
| T4 self | init reads `read_database` JSON; shape not given | gap -> Ruling Q2 (capture real shape) |
| T4 -> T5/T6 | CardMap, loadCardMap/saveCardMap | consistent |
| T5 self vs spec 7.4.4.2 | spec sends a `mirror-edited` review item; no MCP tool can add a review until SP4 Task 3 | gap -> Ruling Q3 |
| T6 self | domain hint from `domains.yaml` `whiteboards` — DomainEntry.whiteboards exists (SP0) | consistent |
| T2/T3 vs verification | only T4–T6 list `build:wiki-tool`, but the bundle test fails whenever tool source changes | CONFLICT -> Ruling Q4 |
| T7 self | consumes every command and MCP tool names; llm_wiki_status exists | consistent |
| T8 (new) | git helper used by SP4 fuse commit and SP5 recut commit; no SP3 command commits | consistent |
| Rubric conflicts | none | none |

Ruling Q1: the git helper and shared lock move to a new Task 8 (plan amended): JS `withGitLock` + `commitPaths` in wiki-tool, the same lock in Rust git_history.rs write commands and in undo.mjs; the JS helper refuses during merge/rebase/cherry-pick/revert, never commits `.llm-wiki/`, keeps `.gitignore` out unless listed; the Rust untracking commit also refuses during a merge and names its temp index after a project-path hash (SP1 N3/N5). — Why: no SP3 hepta command commits; SP4/SP5 need it; keeping Task 1 small. — Cost if wrong: none (order only).
Ruling Q2: the controller captures real Heptabase MCP outputs (list_cards for #wiki-test and #ingest-test, read_whiteboard / read_object for the test whiteboard and its mind map, read_database for the #wiki-test tag; list_whiteboards) — read-only — and writes ANONYMIZED fixtures (UUIDs → 00000000-0000-4000-8000-0000000000NN, titles → generic text, no personal content) to this workspace for the Task 2/4 implementers; only anonymized fixtures enter the repo. — Why: parsers must match real output; the template repo is public. — Cost if wrong: a parser misses a rare shape; the live test catches it.
Ruling Q3: until SP4 adds `llm_wiki_add_review`, a `skip-edited` card is handled by `record` feedback (note snapshot → ingested as user feedback) plus a line in the skill report; SP4 Task 3 adds the `mirror-edited` type and updates the wiki-sync skill (both plans amended). — Why: no MCP tool can add a review item yet. — Cost if wrong: edited-card feedback shows in the report, not the review queue, until SP4.
Ruling Q4: every task that changes `tools/wiki-tool/src/` rebuilds and commits the bundle in the same commit (plan Global Constraints amended). — Why: the bundle test fails on a stale bundle. — Cost if wrong: none.

## Tasks
Q2 done: anonymized fixture drafts + NOTES.md in fixtures-draft/ (read-only MCP calls on #wiki-test, #ingest-test, the test whiteboard, its mind map, one test card, the root whiteboard list).
Ruling Q5: card links are WRITTEN as `[t](heptabase://card/<id>)` (Hepta Markdown manual) but READ back also as `[t](https://app.heptabase.com/<space>/card/<id>)`; Task 3 `cardToSnapshotBody` strips both forms, and Task 2 parsers accept both. read_object page 1 has a `--- Databases ---` block that joinReadObjectPages must drop. — Why: observed in real output. — Cost if wrong: none.
Observation for the live test: the test #wiki-test tag already holds 3 user cards (not mirrors); plan-down must never touch cards absent from the map. The mind-map cards sit on two whiteboards under two different root whiteboards — a natural `ask` (two-roots) case.
