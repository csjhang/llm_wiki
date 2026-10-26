# SDD ledger — plan: docs/superpowers/plans/2026-10-23-sp5-lint-recut.md

Spec: docs/superpowers/specs/2026-10-23-mechanism-wiki-heptabase-design.md (reachable; sections 9.1, 9.2, 12 row 5). Branch: design/heptabase-wiki. Base: 3f7929d (SP4 closed). Depends on SP2 (domain index renderers, IndexedPage), SP3 (card map, commitPathsLocked, plan-down mass-retire rail), SP4 (review MCP tools, S17 allowed actions).
Rulings carried in: SP2 T18 (dedup FIELDS_TO_UNION), SP3 Q15 (`--allow-mass-retire` goes to SP5), R18, R19.

## Pre-flight scan
| Rows | Produces / consumes | Finding |
|---|---|---|
| T1 self | StructureInput.cardMap `{ pages: { status, card_id } }`; `mirror-retired` "lists its title" | the card map stores no title; a retired page is usually gone → Ruling U1 |
| T1 ↔ T3 | `checkStructure` (app, pure) reused by `wiki-tool lint structure` | the tool may import only pure modules; `domain-index-render.ts` (IndexedPage, indexedPageFromMarkdown) is pure, `domain-index.ts` is not → import the pure file only; add lint-structure.ts and its pure deps to the tool tsconfig include |
| T1 ↔ wiki-identity | `lint:` thresholds in wiki.yaml | the tool already includes `src/lib/wiki-config` → one parser, consistent |
| T1 self | T18 dedup change rides in Task 1 | consistent (plan global constraint) |
| T1 ↔ T2 | `runMechanismStructuralLint` = scan + checkStructure | consistent |
| T2 self | runs after a successful ingest, never fails it | same shape as SP4 S14 (do not hold the ingest) → Ruling U8 |
| T3 self | `ingestsSince` counts ingest commits | subject prefix `ingest:` from commit-message.ts → consistent |
| T4 self | "tree is clean" | an uncommitted `heptabase-map.json` is normal after wiki-sync → Ruling U2 |
| T4 self | "rewrites `domain` and `also`" | a hypothesis page has `from_domain`/`to_domain` (R19); mechanism Known instances lines carry `(<domain>)`; `.llm-wiki/fusion-dismissed.json` has `targetDomain` → Rulings U3, U4, U5 |
| T4 ↔ commit-message | subject `recut: <op> <from> → <to> (<N> pages)` | `buildActionCommitMessage("recut", …)` counts its list → Ruling U7 |
| T4 ↔ SP3 Q15 | `--allow-mass-retire` | not in the plan text → Ruling U6 |
| T5 ↔ T3/T4 | CLI names | consistent |
| T5 ↔ SP4 S17 | `llm_wiki_add_review` options | lint/recut items use no options or dismissal words only → consistent |
| T4 ↔ Heptabase | new domain select options | T5 tells the user which options to add → consistent |

Ruling U1: `mirror-retired` names the page path and the card id (and the page title when the page file still exists); the message says to find the card in the mirror tag by id or by the "🗄 已停用" title prefix and delete it by hand. — Why: the card map has no title. — Cost if wrong: a longer message.
Ruling U2: the recut clean-tree check ignores `heptabase-map.json` and everything under `.llm-wiki/` (same rule as undo.mjs `isDirty`, SP3 D1). — Why: the map is often uncommitted after wiki-sync. — Cost if wrong: a recut over an uncommitted map edit.
Ruling U3: recut rewrites `from_domain` and `to_domain` of hypothesis pages as well as `domain` and `also`. `recut pages --domain D` lists hypothesis pages whose `from_domain` or `to_domain` is D; a split assignment for such a page applies to whichever of the two equals D. — Why: R19 counts a hypothesis under `to_domain`; leaving `from_domain` on a removed domain breaks `fuse check`. — Cost if wrong: two more keys.
Ruling U4: recut rewrites the `(<domain>)` of Known instances lines (`- [[<slug>]] (<domain>): <term>`) in mechanism pages: rename/move/merge map directly; split uses the instance page's assignment. — Why: fusion candidates (SP4 S9) read instance domains from these lines. — Cost if wrong: a stale domain in a line of text.
Ruling U5: recut rename/move/merge also rewrites `targetDomain` in `.llm-wiki/fusion-dismissed.json` (not committed); split leaves it (the user re-decides). — Why: a dismissed pair must stay dismissed after a rename. — Cost if wrong: a skipped candidate comes back once.
Ruling U6: Task 4 adds `--allow-mass-retire` to `hepta plan-down` (skips the mass-retire refusal, still lists the count as a note), and the wiki-sync skill gets one step: when the plan refuses to retire many cards, show the count and the reason, ask the user, and only on a yes plan again with the flag. — Why: SP3 Q15 moved it here. — Cost if wrong: one flag.
Ruling U7: the recut subject counts changed wiki pages only (not `domains.yaml`, not index files): build it with `buildActionCommitMessage("recut", "<op> <from> → <to>", <changed page paths>)`, and commit all changed files with `commitPathsLocked`. — Why: the plan says "(<N> pages)". — Cost if wrong: a different number.
Ruling U8: the after-ingest structural lint runs after the ingest commit, does not hold or fail the ingest, and stops when the project changes (same pattern as SP4 S14 / the fusion step). — Why: SP4 found that awaited follow-up work rolled back a finished ingest on cancel. — Cost if wrong: lint results may lag one ingest.
Ruling U9: `StructureInput` gains optional `libraryDomains: DomainsConfig | null`; in a work wiki, a domain listed there is known (plan: "check both before reporting domain-unknown"). — Why: the plan's input type has one `domains` only. — Cost if wrong: one field.
Task 1: dispatched (sonnet); base 3f7929d; carries U1, U9, T18
Task 1: DONE_WITH_CONCERNS 3ae2a14 3fe5ae5 (mocks 3783); concerns: lint thresholds required on WikiIdentity (DEFAULT_LINT_THRESHOLDS); raw-name match is exact (no base-name fallback); a hypothesis with no to_domain gets no finding; template wiki.yaml example + spec 9.1 not updated (outside file list)
Task 1: review dispatched (sonnet)
Task 1: review Needs fixes (0 Critical, 1 Important: a hypothesis with no to_domain is invisible to every check)
Ruling U10: a hypothesis page without `to_domain` or `from_domain` gets `domain-missing` naming the key. — Why: R19's exemption assumes the page has `to_domain`; without it the page is counted nowhere and never named. — Cost if wrong: one more finding on a broken page.
Ruling U9 (refined): `libraryDomains` makes only hypothesis `from_domain`/`to_domain` known; a plain page's `domain`/`also` must be in this wiki's domains. — Why: the plan's global constraint names only the hypothesis fields. — Cost if wrong: a work page on a library domain is flagged.
Task 1: minor (deferred): domain size counts every page type; regex purity test; nits
Task 1: fix round 1 dispatched (resume implementer; fix base 3fe5ae5)
Task 1: fix round 1 done db8ccba (mocks 3814); scoped re-review dispatched (haiku)
Task 1: re-review clean (8 addressed); minor (deferred): header doc says "changes nothing" but checkStructure now throws on a bad today; base-name fallback can attach a foreign domain when the bare name is another raw file
Task 1: complete (3f7929d..db8ccba)
Task 2: dispatched (sonnet); base db8ccba; carries U8
Ruling U11: `wiki-lint` runs `lint mark` only when every finding was filed as a review item (or when there was none); when the app is not running or a call fails, it prints the findings, does not mark, and tells the user to run it again with the app open. — Why: a marker after unfiled findings would hide those domains from the next run. — Cost if wrong: a domain is linted twice.
Ruling U12: lint and recut review titles carry the domain and the pages so their ids differ (`Lint (<domain>): <short finding>`; `Recut merge (<domain>): <slug>`). — Why: SP4 S16 — the id comes from the title, so two findings with one title would merge. — Cost if wrong: longer titles.
Task 2: DONE_WITH_CONCERNS 29b86da (mocks 3866); runs once per drained queue (onQueueDrained, detached, before the review sweep); accept: three small lint-view fixes for page "" and wiki/ paths; review: Fix button sends a structure item to Review as confirm; a broken library domains.yaml reads as empty
Task 2: review dispatched (sonnet)
Task 2: review Needs fixes (0 Critical, 2 Important: Fix on a structure item drops findings through review-id collisions; a broken domains.yaml floods domain-unknown)
Ruling U13: structure lint items have no Fix and are left out of batch send/fix. — Why: layer 1 is read-only; the Fix path made colliding review titles and dropped findings. — Cost if wrong: the user opens the page by hand.
Ruling U14: a tenth check id `config-invalid` (one finding per config problem); a broken own domains.yaml skips domain-unknown and size checks; a broken library file skips only the library part. Updates the plan's check-id list. — Why: one clear finding beats a flood that blames the pages. — Cost if wrong: one more id.
Task 2: minor (deferred): crashed layer 1 shows "All clear"; the local-date test cannot tell local from UTC on a UTC runner; loadLibraryDomains loads the whole library context
Task 2: fix round 1 dispatched (resume implementer; fix base 29b86da)
Task 2: fix round 1 done ba3bcaf (mocks 3901); accept: every configIssues entry is one config-invalid finding (a missing wiki.yaml gives one warning; a missing library domains.yaml gives one and skips the library part); scoped re-review dispatched (haiku)
Task 2: re-review clean (5 addressed); minor (deferred to final wave): lint-run loadLibrary catch returns no problem (an unexpected throw would bring back the flood); the ignore-pages list does not apply to structure findings
Task 2: complete (db8ccba..ba3bcaf)
Task 3: dispatched (sonnet); base ba3bcaf; carries U14
Task 3: DONE_WITH_CONCERNS 2ac5d34 (mocks 3999)
Ruling U15: accept the CLI choices — configProblems from wiki.yaml + own domains.yaml + library domains.yaml only (lens/page-type issues need a non-pure reader); a project without domains.yaml exits 2; changed-domains and batch exit 2 when the domain list is unreliable; a page that changed domain marks both; with no marker `mechanismsChanged` is true when any mechanism page exists. — Why: each is the safer reading; parity on lens issues would need moving lens code to a pure module. — Cost if wrong: small CLI/app differences in config findings.
Task 3: review dispatched (sonnet)
Task 3: review Approved with fixes (0 Critical, 2 Important: lint mark writes a marker in a non-mechanism folder; card-map reader and localDate copied from the app); controller fix round items 1-6
Task 3: minor (deferred): one git process per changed page (speed)
Task 3: fix round 1 dispatched (resume implementer; fix base 2ac5d34)
Task 3: fix round 1 done 87735f4 (mocks 4061); scoped re-review dispatched (haiku)
Task 3: re-review clean (6 addressed); minor (deferred): read-content.ts holds a literal U+FEFF in a regex
Task 3: complete (ba3bcaf..87735f4)
Task 4: dispatched (sonnet); base 87735f4; carries U2-U7
User asked (2026-10-26): balance is low; if the usage limit stops the work, retry every 2 hours and re-check progress and plan. Scheduled task trig_01LewgriCRGgzHKudjEAnE56 (every 2 h at :39) fires into this session; delete it after the final report.
User changed the check-in (2026-10-26): every 6 hours at 07:00/13:00/19:00/01:00 Taipei (same trigger trig_01LewgriCRGgzHKudjEAnE56); delete it after the final report.
Task 4: DONE_WITH_CONCERNS a86c1d5 b2f3d26 (mocks 4202)
Ruling U16: accept — `recut pages` lists `also`-only pages (`key: "also"`) and a split needs their assignment; merge into an existing domain takes lens/description from the plan; split drops the split domain's whiteboard hints (noted), merge unions them; child domains of a split/merged domain stay (noted); `--plan` takes a file path or inline JSON starting with `{`. — Why: each keeps every page pointing at a live domain, and the plan is the user's confirmed choice. — Cost if wrong: one more assignment per also-page.
Task 4: review dispatched (sonnet)
Task 4: review Needs fixes (0 Critical, 3 Important: write outside the project through a symlinked folder; a page the line editor cannot read is skipped while apply reports success; a failed commit leaves the recut staged)
Ruling U17: accept the U2 deviation (a staged card map, changes outside the project folder, and tracked .llm-wiki changes do not make the tree dirty) because the commit is path-limited. — Why: safe; a wider rule would block normal use after wiki-sync. — Cost if wrong: none found.
Task 4: minor (deferred): index fidelity vs the app scanner (dot names, BOM); plan.ts size and the cmd-snapshot import
Task 4: fix round 1 dispatched (resume implementer; fix base b2f3d26)
Task 4: fix round 1 done 4c3622e (mocks 4224); accept: an unassigned split instance line stays with a note; indented/flow frontmatter stops the recut naming the page; scoped re-review dispatched (sonnet)
Task 4: re-review r1: items 1-6 addressed (verified on the bundle); NEW Important (predates the fix): a folder link inside the project makes the commit miss the real file; fix round 2 dispatched (resume implementer; fix base 4c3622e)
Task 4: fix round 2 done 3df0f02 (mocks 4227); scoped re-review dispatched (haiku)
Task 4: re-review r2 clean (2 addressed); parked for the SP5 final fix wave: index/domains.yaml targets behind an in-project folder link (same class as the page fix, unverified); a removed index file behind a link loop is skipped silently; test name "and says so" asserts only exit 0
Task 4: complete (87735f4..3df0f02)
Task 5: dispatched (sonnet); base 3df0f02; carries U11, U12, U16
Task 5: DONE_WITH_CONCERNS 1df151b (mocks 4290; one flaky timeout in lint-structure-integration "when the lint never ends" under load, passed on rerun → watch)
Ruling U18: spec 9.2 "a page that mixes two new domains is rewritten as two pages" is not automated; `wiki-recut` treats such a page as "fits no target" and asks the user (the skill never edits pages). Human decision for the final report. — Why: splitting a page is page writing, which belongs to ingest, and recut must stay one reversible commit. — Cost if wrong: the user splits such pages by hand.
Accept Task 5 additions: title_prefix lookup before filing (no double filing after a U11 rerun); no mark when HEAD moved; one duplicate item per slug; ask about the app before a merge; offer renaming the Heptabase option on rename/move.
Task 5: review dispatched (sonnet)
Task 5: review Approved (0 Critical, 0 Important, 13 minor). Parked for the SP5 final fix wave (fix there): wiki-lint 1 (Failure conditions section named), 2 (no-mark rule once, with the zero-findings + app-down case and "skipped because an item exists counts as filed"), 3 (stop mid-run prints the unfiled findings; exit 2 has other causes), 4 (output-language fallback without a question), 5 (LLM_WIKI_API_TOKEN in Requirements; show the failed call text), 6 ("at most" and tie the default to DEFAULT_MAX_CHARS); wiki-recut 7 (write the plan file before Apply), 8 (rules stated once), 9 (an "anything else" row; no "should"); tests 10-12 (shared jsonBlocks; exported message strings; layer-3 checks tied to mechanism.md); 13 (description says "lint").
Task 5: complete (3df0f02..1df151b)
SP5 final review dispatched (opus), range 3f7929d..1df151b
SP5 final review (opus): with fixes — 0 Critical, 4 Important (I1 merge candidates miss <slug>--<domain> pages; I2 mirror-retired wrong advice / never clears; I3 reading-wiki recut breaks work-wiki hypotheses silently; I4 flaky turn-count waits), 8 minor
Ruling U19: mirror-retired is silent when the page exists and is mirrored (the next sync revives the card); plan-down plans `forget` for a retired entry whose card is not in the full mirror list, and `record forgotten` removes the entry. — Why: deleting a card the sync revives blocks the page for good; a finding the user cannot clear trains them to ignore lint. — Cost if wrong: one plan op and one record event.
Ruling U20: merge candidates pair base names (slug without the `--<domain>` suffix of spec 5.5) plus exact slugs. — Why: the app never writes two same-slug pages in one folder, so exact-slug pairing is always empty. — Cost if wrong: extra duplicate reviews.
Ruling U21: a reading-wiki recut notes that work wikis keep the old names in hypothesis keys (cheap fix); the better fix (a work-wiki recut that rewrites only hypothesis keys for a library-only domain) is a human decision. — Why: keep this wave small; the warning prevents silent breakage. — Cost if wrong: the user edits those hypothesis pages by hand.
SP5 final fix wave dispatched (sonnet), base 1df151b
SP5 final fix wave INTERRUPTED by the usage limit (resets 16:00 UTC 2026-10-26); its work so far is on disk (commits above 1df151b plus uncommitted files). Resume: SendMessage to agent aaa4ee24843668361 "continue the fix wave from where you stopped" (do not start a new agent unless it cannot be resumed; then a fresh sonnet agent reads final-fix-findings.md and the git log/diff to continue).
WIP commit of the interrupted fix wave pushed (see git log "wip: SP5 final fix wave"); tell the resumed agent its files are committed and to continue on top.
RESUMED by the 6-hour check (17:02 UTC): fix wave agent aaa4ee24843668361 resumed on top of 802a729
SP5 final fix wave done 802a729 (wip) 4523667 055250f bb82877 88d7e10 8182534 07122e7 (mocks 4403 x3 green, mcp 56); accept: app down + no finding → no mark; a card taken out of the tag is forgotten too; re-filed findings carry the noted commit suffix so they do not merge into an app-closed item; scoped re-review dispatched (sonnet)
SP5 final fix wave: re-review clean (I1-I4, M1-M8, P1-P6 addressed; bundle byte-identical to a rebuild at 07122e7)
Residual (parked): `forget` trusts the mirror list the skill passes; a skipped middle page file could drop a retired entry (worst case: a second card later; the skill says save every page). A test still reads mcp-server source text for one message. wiki-lint Step 5 item 4 "if a commit came in" has no way to know now (nit).
No live test for SP5: the plan has none (lint and recut do not call Heptabase; the wiki-sync changes are `forget` and `--allow-mass-retire`, both covered by tool tests).
SP5 complete (3f7929d..07122e7).
