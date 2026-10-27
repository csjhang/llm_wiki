# SDD ledger — plan: docs/superpowers/plans/2026-10-23-sp6-skill-panel.md

Spec: docs/superpowers/specs/2026-10-23-mechanism-wiki-heptabase-design.md (reachable; sections 6.6, 10.1–10.3, 12 row 6). Branch: design/heptabase-wiki. Base: 65a331b (SP5 closed). Carried in: SP2 T16 (spec 6.6 "use an existing domain"), SP4 S17 (allowed API option actions), SP4 S20 (percent_decode), SP5 marker and ingest counting (`lint changed-domains`).

## Pre-flight scan
| Rows | Produces / consumes | Finding |
|---|---|---|
| T1 ↔ T3 | `PANEL_ENTRIES`, `commandFor` | consistent |
| T2 ↔ T3 | `open_claude_terminal(project_path, command)` | consistent |
| T3 ↔ wiki-sync skill | background `claude -p` for wiki-sync | the skill asks for a direction and a yes before writes; a background run cannot ask → Ruling W1 |
| T3 ↔ wiki-lint skill | background | wiki-lint asks nothing (its Rule 10) → consistent |
| T4 ↔ SP5 | ingest count since the marker | must match `lint changed-domains` `ingestsSince` → Ruling W3 |
| T5 self | allowlist names | checked against the Claude Code docs (permissions.md, mcp.md); the skills also save MCP results with Write and run `mkdir`/`cp` → Ruling W2 |
| T5 ↔ wiki skill | the menu skill lists every skill | SP5 added wiki-lint and wiki-recut → check the menu lists all six |
| T6 (new) | spec 6.6 options for new-domain and mirror-edited; S20 | SP2 T16 deferred here; plan amended with Task 6 → Rulings W4, W8 |
| T6 ↔ SP4 S17 | API-added option actions | `mech:discard-mirror-edit` must be allowed for the wiki-sync skill → part of W4 |

Ruling W1: the panel's wiki-sync button runs `claude -p "/wiki-sync --yes"`. The wiki-sync skill gets one section "Run without questions": with `--yes`, the button press is the yes for the plan; run Up, then Down; never ask; leave out every step that needs a choice and list it in the report (plan-up `ask` items, missing select options, a mass-retire refusal — never pass `--allow-mass-retire` without a person, a missing `heptabase.yaml` → stop and say to run `/wiki-sync` in a conversation once). — Why: spec 10.2 says a background run cannot stop to ask. — Cost if wrong: a background sync does less than an interactive one.
Ruling W2: the template `.claude/settings.json` allows: `mcp__plugin_heptabase_heptabase__*` (plugin install) and `mcp__Heptabase` (claude.ai connector name seen in this environment), `mcp__llm-wiki`, `Bash(node */scripts/wiki-tool.mjs *)`, `Bash(node */skills/wiki-undo/scripts/undo.mjs *)`, `Bash(git *)`, `Bash(mkdir -p */.llm-wiki/hepta*)`, `Bash(cp * */.llm-wiki/hepta/*)`, `Edit(/.llm-wiki/**)`. — Why: docs say `/` anchors at the project, Edit covers Write, a middle `*` is valid; the skills save MCP results under `.llm-wiki/hepta/`. The plugin name of the user's Heptabase install is not checkable here; the README says how to check it. — Cost if wrong: one prompt per call in a background run (it fails instead of asking).
Ruling W3: the lint reminder counts like `lint changed-domains` `ingestsSince`: commits that touch the project folder, subject starts with `ingest:`, after the marker commit; no marker, a bad marker, or a marker that is not an ancestor of HEAD → count all. Reuse a Rust git helper; a parity test with the CLI. — Why: one definition. — Cost if wrong: an early or late reminder.
Ruling W4: Task 6 adds the spec 6.6 options: new-domain "Use an existing domain" (`mech:use-existing-domain` with a picker; rewrites the ingest's pages and commits) and mirror-edited "Keep as feedback" (dismissal) / "Discard the edit" (`mech:discard-mirror-edit` → `.llm-wiki/hepta/discard-edits.json` → next plan-down updates; `record updated` clears it). S17's allowed list gains `mech:discard-mirror-edit`. — Why: spec 6.6 is binding; T16 was deferred here. — Cost if wrong: two actions.
Ruling W8: Task 6 also fixes `percent_decode` (S20). — Why: it is reachable through the review filters. — Cost if wrong: none.
Task 1: dispatched (sonnet); base after the plan-amend commit
Task 1: DONE f49a2bd (mocks 4417); key `buttons`; blank input left out; whitespace in an input value throws; review dispatched (haiku)
Task 1: review Needs fixes (1 Important: commandFor refuses whitespace only; `;`/quotes/`$(` pass); fix round 1 dispatched (resume implementer; fix base f49a2bd)
Task 1: fix round 1 done 22529cf (mocks 4447); controller scoped re-review of the 2-file diff: items 1-5 addressed (UUID allowlist for whiteboard, safe-word path rule, args words, duplicate skill refused, trimmed label)
Task 1: complete (303211e..22529cf)
Task 2: dispatched (sonnet); base 22529cf
Task 2: DONE_WITH_CONCERNS 40a6a35 (cargo terminal_launch 34, mocks 4449); not run on macOS/Windows (builders unit-tested on Linux)
Ruling W9: on Windows the `wt` launcher runs `cmd /k claude <command>` inside the tab (an npm install gives `claude.cmd`, which a no-shell start does not find). Accept: the path must be absolute and the command must start with `/`; success means the launcher started. — Why: the npm install is the common case. — Cost if wrong: one extra cmd layer in the tab.
Task 2: review dispatched (sonnet), with W9 as a known fix
Task 2: review Approved (0 Critical, 0 Important); fix round 1 for W9 + UNC paths + test gaps; deferred: is_absolute_like per host, tcsh `!`, repeated map; manual checks needed on Windows (wt quoting, %VAR% in -d), macOS, Debian x-terminal-emulator
Task 2: fix round 1 dispatched (resume implementer; fix base 40a6a35)
Task 2: fix round 1 done e5bc9e2 (cargo terminal_launch 35); controller scoped re-review: W9 (wt runs cmd /k claude), one shared Windows refused set, UNC refused, tests added
Task 2: complete (22529cf..e5bc9e2)
Task 3: dispatched (sonnet); base e5bc9e2; carries W1
Task 3: DONE_WITH_CONCERNS e4f197a (mocks 4525, cargo claude_cli 10, terminal_launch 35); new Rust `claude_cli_run_skill` (`claude -p --output-format stream-json --verbose "<command>"`, no isolation, no permission flag); W1 section added to wiki-sync
Ruling W10: a background run needs the folder's trust prompt accepted once; Task 5 adds the README step and a panel hint. — Why: Claude Code ignores the project allow list in -p runs until the folder is trusted. — Cost if wrong: one hint line.
Task 3: review dispatched (sonnet)
Task 3: review Needs fixes (1 Important: a running write-capable run can be started again → duplicate cards risk); fix round 1 dispatched (resume implementer; fix base e4f197a)
Task 3: fix round 1 done 20a4368 (mocks 4542); controller scoped re-review: the run guard is in the disabled state and in the press handler (ref); denied tools → warning status; last run tied to the project; whiteboard list reloads after a sync; Rules line amended. Deferred: no DOM test for the press handler (no jsdom); progress grows; mechanism check only on project change
Task 3: complete (e5bc9e2..20a4368)
Task 4: dispatched (sonnet); base 20a4368; carries W3
Task 4: DONE_WITH_CONCERNS 82aa05f (mocks 4579, cargo git_history 100 incl. 2 parity tests with the bundle)
Ruling W11: the `zh` locale is Simplified Chinese, so `skillPanel.lintReminder` in zh.json is written in Simplified Chinese like its neighbours; the panel.yaml button labels stay Traditional (the plan fixes them). Accept: the toggle sits in Settings > Maintenance and applies at once; parity tests skip when node is missing; the reminder reloads on panel open and after a wiki-lint run. — Why: one script per locale file. — Cost if wrong: one string.
Task 4: review dispatched (haiku), with W11 as a known fix
Task 4: review Approved with conditions (W11 zh; M1 nested-repo hint; M2 parity tests assert without node); fix round 1 dispatched (resume implementer; fix base 82aa05f)
SP6 Task 4 fix round INTERRUPTED by the usage limit (resets 22:00 UTC 2026-10-26). Uncommitted files at the stop: 0 (committed as a WIP commit if any). Resume: SendMessage to agent a25d20009247ff307 ("continue the fix round; your files are committed in the WIP commit if one exists"), then the scoped re-review, then Task 5 (notes ready), Task 6 (notes ready), SP6 final review.
RESUMED by the 6-hour check (23:02 UTC): Task 4 fix round agent a25d20009247ff307 resumed
Task 4: fix round 1 done 1f755f4 (mocks 4584, cargo git_history 100 with both parity tests run); controller scoped re-review: W11 zh Simplified with the Traditional button word quoted; nested-repo hint; parity tests assert fixed counts
Task 4: complete (20a4368..1f755f4)
Task 5: dispatched (sonnet); base 1f755f4; carries W2, W10
Task 5: DONE_WITH_CONCERNS 2368b06 (mocks 4624); accept: the read-only notice is the fixed Traditional text of the brief; a new template README holds the W2/W10 setup steps; the Heptabase plugin prefix is unconfirmed (README says how to check with /mcp); review dispatched (haiku)
Task 5: review Needs fixes (0 Critical, 2 Important: page-links Create/Draft write wiki/ pages on a read-only page; the allow list lets background runs push/reset and use every Heptabase tool)
Ruling W12: the template allow list names each Heptabase tool the skills use (both prefixes), keeps `mcp__llm-wiki` server-wide, and adds deny rules for destructive git commands and `rm`. — Why: a background run must not be able to push, reset, or remove whiteboard objects. — Cost if wrong: a skill that later needs a new Heptabase tool gets one prompt until the list is updated.
Task 5: fix round 1 dispatched (resume implementer; fix base 2368b06)
Task 5: fix round 1 done f1549d0 (mocks 4635); controller scoped re-review: 26 per-tool Heptabase rules (13 tools x 2 prefixes, read_system_manual_page accepted), mcp__llm-wiki, 9 deny rules, PageLinksPanel readOnly prop; README notes deny rules match the usual form only
Task 5: complete (1f755f4..f1549d0)
Task 6: dispatched (sonnet); base f1549d0; carries W4, W8, S17
Task 6: DONE_WITH_CONCERNS 6ef1272 af44043 (mocks 4697, mcp 56, cargo api_server 73); moved frontmatter-edit + instance-line editor to src/lib (one copy); discard cleared on updated/retired/forgotten; review dispatched (sonnet)
Task 6: review Needs fixes (0 Critical, 2 Important: "Discard the edit" bypassed editedCard, so later edits and API-planted discards overwrite user edits without consent; "Use an existing domain" used its own lock, not the ingest's)
Ruling W13: a discard covers only the edit the user saw: plan-down updates a listed page only when the card time is not later than `feedback_card_updated_at`; no recorded feedback → `skip-edited`; `record feedback`/`created` clear the entry. — Why: SP3 Q3, a user edit is never overwritten without consent. — Cost if wrong: one more click after a new edit.
Task 6: fix round 1 dispatched (resume implementer; fix base af44043)
Task 6: fix round 1 done a8813d3 (mocks 4710, mcp 56); accept: a card with no time in the mirror list is never forced; commit and resolve run outside the lock; scoped re-review dispatched (haiku)
Task 6: re-review clean (5 addressed); minor (deferred): the lock tests prove the wait by a 50 ms sleep; a page whose write throws mid-way is neither restored nor named (pre-existing in writeDomainChange)
Task 6: complete (f1549d0..a8813d3)
SP6 final review dispatched (opus), range 65a331b..a8813d3
Container restart lost the first SP6 final review; re-dispatched (opus) at HEAD a8813d3 (+ ledger commit e9fdd75), writing final-review.md as it goes
SP6 final review (retry) INTERRUPTED by the usage limit (resets 04:00 UTC 2026-10-27); its last step was the template settings/README/gitignore part. Resume: SendMessage to agent aae3299fd3ea4d959 "continue the review from where you stopped; write final-review.md" (a fresh opus reviewer only if it cannot be resumed). Then: ONE fix wave, re-review, close SP6, final report (rulings collected in the scratchpad rulings.json; regenerate from docs/superpowers/ledgers if lost), finishing-a-development-branch, delete trigger trig_01LewgriCRGgzHKudjEAnE56.
RESUMED by the 6-hour check (05:02 UTC 2026-10-27): SP6 final review agent aae3299fd3ea4d959 resumed
SP6 final review (opus): with fixes — 0 Critical, 1 Important (I1: allow-list `*` patterns let an unattended run execute any code; deny list is no boundary; README overstates), 5 minor
Ruling W14: narrow the allow list where cheap and certain (exact read-only git commands of background skills, Edit only under .llm-wiki/hepta), add deny rules for node eval and git -c forms, and make the README honest (convenience list, not a sandbox; trust the sources; Claude Code sandbox is the stronger guard). A PreToolUse hook or sandbox mode is a human decision. — Why: Bash patterns match text; a full boundary needs a hook or the sandbox. — Cost if wrong: a skill command that the narrowed list misses prompts (or fails in a background run).
Ruling W15: two Down runs at once get a panel hint and a skill rule, not a tool lock, in this wave. — Why: a lock across many record calls needs its own design. — Cost if wrong: a rare duplicate card when the user ignores the hint.
SP6 final fix wave dispatched (sonnet), base e9fdd75
SP6 final fix wave done 2a8eb61 5b1bab6 b84e338 c9e6f5f (mocks 4771, cargo terminal_launch 40, claude_cli 10)
Ruling W16: accept the fix wave's extra rules — quoted-path allow rules for wiki-tool.mjs and undo.mjs (Claude Code matches raw text, and the skills quote the path; the old rule would have denied every background call), deny `Bash(git * --exec-path*)` and `Bash(node *.llm-wiki/*.mjs*)`, and only `git -C "<project>" rev-parse HEAD` allowed for git. Side effect: a card title with " -e " is denied in a snapshot command (README says so). — Why: the contract test showed the earlier list did not match the skills' own command lines. — Cost if wrong: one prompt or one denied call in a rare title case.
SP6 final fix wave: scoped re-review dispatched (haiku)
SP6 final fix wave: re-review clean (I1, M1-M5 addressed; spot-checked command lines match allow rules and no deny rule)
Residual (accepted): `Bash(git -C * rev-parse HEAD)` is wider than the quoted form, but a `-c` alias form is still caught by the `git * -c *` deny rule; README names card titles only for the " -e " side effect (whiteboard titles and paths too); Cancel kills only the claude child, so a running wiki-tool child or MCP server may finish its last write after "Cancelled" (process-group kill is a follow-up).
SP6 complete (65a331b..c9e6f5f). No live test in SP6 (needs the desktop app and a real Claude Code install; listed as manual checks).
