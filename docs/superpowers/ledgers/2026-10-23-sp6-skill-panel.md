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
