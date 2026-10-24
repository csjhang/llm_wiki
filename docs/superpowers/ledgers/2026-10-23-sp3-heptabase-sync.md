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
Task 1: dispatched (base 5429b7f, implementer sonnet)
Task 1: implementer DONE, commit 34cfa06 (vitest 2880 pass, bundle deterministic)
Ruling Q6: accept — resolveInProject checks path text only (a symlink inside the project that points outside is the user's own setup); version embedded at build time (bundle test forces a rebuild after a version bump); main.ts entry, .gitattributes LF for the bundle, optional `groups` param on runCli. — Why: brief-conformant or safer. — Cost if wrong: a symlinked folder lets the tool write outside the project.
Task 1: review dispatched (sonnet)
Task 1: review Approved (0 Critical, 0 Important)
Task 1: minor (deferred → Task 2 dispatch): literal U+FEFF in io.ts and cli.test.ts should be \uFEFF escapes; Windows region-comment separators unverified (CI does not run tests on Windows)
Task 1: complete (commits 5429b7f..34cfa06, review clean)
Task 2: dispatched (base 34cfa06, implementer sonnet; fixtures from fixtures-draft/, Q5)
Task 2: implementer agent acc532fd0b1c74c47
Task 2: implementer DONE, commit 3f75fb1 (vitest 2918 pass)
Ruling Q7: accept unescaping `\"` to `"` in titles (real quoting of `"` in titles was not observed; the controller's whiteboard fixture used backslash escapes, the card fixture did not; both now parse). Verify the real quoting in the live test. — Why: harmless both ways. — Cost if wrong: a title that really contains `\"` loses its backslash.
Carried to Task 7 (skill): check each MCP result's `status` before parsing (a failed call parses as empty); compare joined read_object lines with `totalLines` and re-read missing ranges; `(unsectioned)` structure lines are untested against real output.
Task 2: review dispatched (sonnet)
Task 2: review needs fixes (1 Important: `.`-based regexes drop lines with U+2028/U+2029/lone CR)
Ruling Q8: fixture titles and whiteboard names must be neutral placeholders (several were close paraphrases of the user's real titles); fix in Task 2 fix round 1 and use only `tools/wiki-tool/fixtures/` (not fixtures-draft/) for later tasks. Commit 3f75fb1 on the pushed branch keeps the paraphrases in history; tell the user so they can squash before any public merge. — Why: the template repo is public. — Cost if wrong: none.
Task 2: fix round 1 dispatched (resume implementer; fix base 3f75fb1)
Task 2: fix round 1/5 implementer DONE (commit 3f75fb1, vitest 2928); controller grep finds no old fixture names; scoped re-review dispatched (sonnet)
Task 2: fix round 1/5 (3 addressed, 0 open; commits 3f75fb1..3f75fb1)
Task 2: complete (commits 34cfa06..3f75fb1, review clean after 1 fix round). History note: the near-real fixture titles were removed from history (squash, see below).
Task 3: dispatched (base 3f75fb1, implementer sonnet; Q5 link forms)
Task 3: implementer DONE, commit 8aea880 (vitest 2967 pass; bundle unchanged — convert.ts not reachable from main.ts yet)
Ruling Q9: for the fix round — `[[slug#heading]]` resolves by the slug without the anchor; a resolved `[[slug|label]]` keeps the label as link text (`[label](heptabase://card/<id>)`). Accept: `![[file]]` becomes `file（僅在 wiki）`; `\` is escaped in link titles; only a leading H1 is replaced; indented code blocks are not code; local frontmatter strip. — Why: wiki authors pick labels on purpose; anchors are not slugs. — Cost if wrong: link text differs from the card title.
Task 3: review dispatched (sonnet)
Task 3: review Approved (0 Critical, 0 Important); controller fix round for Q9 + unclosed-fence footer + trimmed titles
Ruling Q10: the mirror footer joins source card links with ASCII `, `; any later footer parser uses the same separator. `|` in link titles is not escaped (Heptabase would show the backslash). — Why: one fixed format. — Cost if wrong: a wiki table cell holding a `|` title splits (rare).
Task 3: minor (deferred): replaceUnsupportedBlocks is quadratic for many unclosed opening tags (pathological input only); the `<hepta-table>` tag name is assumed
Task 3: fix round 1 dispatched (resume implementer; fix base 8aea880)
Task 3: fix round 1/5 implementer DONE (commit 9aa274e, vitest 2974); accepted same-page [[#heading]] → plain text; scoped re-review dispatched (haiku, small diff)
Task 3: fix round 1/5 (4 addressed, 0 open; commits 8aea880..9aa274e)
Task 3: minor (deferred): `[[# ^block]]` keeps the caret (strip happens before trim)
Task 3: complete (commits 3f75fb1..9aa274e, review clean after 1 fix round)
Task 4: dispatched (base 9aa274e, implementer sonnet)
Task 4: implementer DONE, commit 15a4a88 (vitest 3022 pass, bundle rebuilt)
Ruling Q11: keep `parentId` in the whiteboards_cache items (plan interface wins over spec 7.6's `parent`); SP6's whiteboard picker reads `parentId`. Paged list_whiteboards output: `init` (and Task 6 plan-up) accept the `--whiteboards` option more than once and join the pages (fix round). Accept args.ts, cmd-hepta.ts, the partial-list and tag-mismatch warnings, case-insensitive property names, map-before-yaml write order, keeping pages/sources on --force. — Why: one interface; pages must join. — Cost if wrong: one field name in SP6.
Task 4: review dispatched (sonnet)
Task 4: review Approved (0 Critical, 0 Important); controller fix round for Q11 paged lists + BOM escape + crash-window test + map repair hint
Task 4: minor (deferred): select/text/date type names come from fixtures only (confirm in the live test); a hard kill mid-write can leave a *.tmp file
Task 4: fix round 1 dispatched (resume implementer; fix base 15a4a88)
Task 4: fix round 1/5 implementer DONE (commit 6b2a28c, vitest 3033); joinListWhiteboards exported from parse-mcp.ts; scoped re-review dispatched (haiku)
Task 4: fix round 1/5 (4 addressed, 0 open; commits 15a4a88..6b2a28c)
Task 4: complete (commits 9aa274e..6b2a28c, review clean after 1 fix round)
Ruling Q12 (Task 5 resolutions): contentHash is taken over the generated card body (so title, link, and footer changes count); source cards for the footer come from page `sources` matched by file name to `map.sources[*].raw_path` basenames, titled by the snapshot's frontmatter `title`; `retire` uses the body `此頁已從 wiki 移除。` (no replacement is known yet; SP5 recut can add one); plan-down takes an optional `--database <read_database json>` and turns a select value that is not an existing option into a problem for that page (spec 7.4 step 8: stop that card, tell the user which option to add); a `--now <iso>` option fixes the clock for tests. — Why: the brief leaves these open. — Cost if wrong: an update planned for a cosmetic change.
Task 5: dispatched (base 6b2a28c, implementer sonnet)
Task 5: implementer agent a27f42d5187920a95
Task 5: implementer DONE_WITH_CONCERNS, commit 2ac0f77 (vitest 3108 pass)
Ruling Q13: (fix round) the content hash covers the card body AND the planned property values (so a hypothesis status/strength/domain change plans an update); a `feedback` event stores the card's `updatedAt` it captured (new optional PageEntry field `feedback_card_updated_at`), and plan-down treats an edit at or before that time as handled — no repeated skip-edited, and the next content change plans a normal update. Accept: contentHash carried on actions/events (the skill copies it), skip-edited also guards relink/retire, repeatable --mirror-cards, small helpers. — Why: hypothesis status must reach Heptabase; one edit must yield one feedback note. — Cost if wrong: a handled edit is overwritten by the next wiki update (the feedback note keeps it).
Task 5: review dispatched (sonnet)
Task 5: review needs fixes (2 Important: swallowed read errors can mass-retire cards; skip-edited only surfaces when a wiki change was due)
Ruling Q14: skip-edited is emitted for every unhandled user edit (brief's timestamp rule) — Q13's feedback marker makes this safe; plus a mass-retire safety rail (refuse when > half of ≥ 5 active cards would retire). Accept Minor 5 (relinks may be planned while a create is blocked by a missing option; benign). — Why: user edits are the feedback loop; a read error must never rewrite cards. — Cost if wrong: one extra problem line in a real mass deletion; the user re-runs after confirming.
Task 5: fix round 1 dispatched (resume implementer; fix base 2ac0f77)
Task 5: fix round 1/5 implementer DONE_WITH_CONCERNS (commit e9866fe, vitest 3122 + 1 skipped as root; the chmod case was checked by hand as user nobody)
Ruling Q15: no override flag for the mass-retire rail yet; the wiki-sync skill reports the problem to the user, and SP5 (recut can legitimately retire many cards) adds `--allow-mass-retire` with a confirmation step. Maps written by the first Task 5 commit plan one extra update per page (none exist outside tests). — Why: keep this round small. — Cost if wrong: a deliberate mass deletion needs SP5 or a hand edit of the map.
Task 5: scoped re-review dispatched (sonnet)
Task 5: fix round 1/5 (7 addressed, 0 open; commits 2ac0f77..e9866fe)
Task 5: minor (deferred): two links to the same real folder inside wiki/ skip the second alias (contrived); a repeated `created` drops feedback_card_updated_at (harmless)
Carried to Task 7: the skill passes `cardUpdatedAt` from the skip-edited ACTION (the plan-time updatedAt), never a fresh list_cards value; it copies `contentHash` from each action into its event.
Task 5: complete (commits 6b2a28c..e9866fe, review clean after 1 fix round)
Task 6: dispatched (base e9866fe, implementer sonnet)
Task 6: implementer STOPPED at the user's request before it wrote anything (tree clean at e9866fe). On resume: re-dispatch Task 6 fresh with the same prompt (base e9866fe).
PAUSED 2026-10-24 at the user's request (the user will say when to resume).
History rewrite (user request 2026-10-24): squashed the Task 2 commit and its fixture fix into 3f75fb1 so no near-real titles remain in history; replayed the later commits unchanged (tree identical); all SHAs in this ledger after 34cfa06 were remapped. Branch force-pushed with lease.
RESUMED 2026-10-24 at the user's request.
