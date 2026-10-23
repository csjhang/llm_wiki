# Sub-project 6: Skill Panel, Settings, and Permissions — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One place in the app to see and run every wiki skill, a toggle to turn version history on later, a reminder for semantic lint, a read-only page editor in mechanism wikis, and a permission allowlist so background skills run without prompts.

**Architecture:** `plugins/llm-wiki/panel.yaml` describes the buttons. The app reads it through a small loader and renders a "Skills" panel in the sidebar. Background buttons run `claude -p` through the existing `claude_cli` spawn; conversation buttons open a terminal window running interactive Claude Code with the command prefilled, through a new Rust command. Settings and the lint reminder reuse existing stores.

**Tech Stack:** React, TypeScript, Tauri v2, Rust, vitest, cargo test.

**Spec:** `docs/superpowers/specs/2026-10-23-mechanism-wiki-heptabase-design.md` (sections 10.1–10.3, 12 row 6)

## Global Constraints

- Panel buttons, in order: `wiki-sync` (background), `wiki-fuse` (conversation, input: whiteboard), `wiki-lint` (background), `wiki-recut` (conversation), `wiki-undo` (conversation). Labels in Traditional Chinese: 同步 Heptabase, 融合, 健檢, 切分領域, 退回.
- `panel.yaml` holds only label, skill name, mode, and inputs. Descriptions come from each `SKILL.md` frontmatter.
- The whiteboard picker reads `heptabase-map.json` `whiteboards_cache`; when absent, the button says "先執行一次同步 Heptabase".
- The panel appears only in a mechanism wiki (`domains.yaml` exists).
- The wiki template ships `.claude/settings.json` that allows only: the Heptabase plugin MCP tools, the llm_wiki MCP tools, and `Bash(node */scripts/wiki-tool.mjs:*)`, `Bash(node */skills/wiki-undo/scripts/undo.mjs:*)`, `Bash(git:*)`. Add a `.gitignore` exception for `templates/mechanism-wiki/.claude/`.
- Commit trailer: your session's Co-Authored-By line plus `Claude-Session: https://claude.ai/code/session_013yG6txX1fFsHyk4VQiasu7`.
- Verification: `npm run test:mocks`, `npm run typecheck`, `cargo test --manifest-path src-tauri/Cargo.toml --lib terminal_launch`.

## Review Focus

1. Claude Code is not installed. Expected: background buttons show the "copy command" fallback, not an error stack. (Task 3 test.)
2. A background run fails mid-way. Expected: the activity panel shows the failure text from Claude Code. (Task 3 test.)
3. The user turns version history on after answering "No" before. Expected: the next ingest commits. (Task 4 test.)
4. Exact MCP tool names for the Heptabase plugin differ from the guess. Expected: Task 5 checks the names against a real Claude Code plugin install before writing the allowlist, and the contract test pins them.
5. A terminal app is missing on Linux. Expected: try `x-terminal-emulator`, `gnome-terminal`, `konsole`, `xterm` in order; if none exists, fall back to "copy command". (Task 2 test.)

---

### Task 1: `panel.yaml` and its loader

**Files:**
- Create: `plugins/llm-wiki/panel.yaml`
- Create: `src/lib/skill-panel/panel-config.ts`
- Test: `src/lib/skill-panel/panel-config.test.ts`
- Modify: `src/lib/__tests__/plugin-contract.test.ts` (every panel entry names an existing skill folder)

**Interfaces:**
- Produces:
  ```ts
  export interface PanelEntry { skill: string; label: string; mode: "background" | "conversation"; inputs: ("whiteboard" | "hypothesis")[]; description: string }
  export function parsePanelYaml(text: string, skillDescriptions: Record<string, string>): ParseResult<PanelEntry[]>
  export const PANEL_ENTRIES: PanelEntry[] // loaded at build time with ?raw imports of panel.yaml and the SKILL.md files
  export function commandFor(entry: PanelEntry, inputs: Record<string, string>): string // "/wiki-fuse <whiteboard id>"
  ```
- [ ] Steps: failing tests (`parses entries in order`, `rejects an unknown skill`, `fills descriptions from SKILL.md`, `commandFor adds inputs`) → FAIL → implement → `npm run test:mocks && npm run typecheck` → commit `feat(panel): add skill panel config`

### Task 2: Terminal launch command

**Files:**
- Create: `src-tauri/src/commands/terminal_launch.rs`; register in `mod.rs` and `lib.rs`
- Create: `src/commands/terminal.ts`

**Interfaces:**
- Produces: `#[tauri::command] pub fn open_claude_terminal(project_path: String, command: String) -> Result<String, String>` returns the launcher used. macOS: `osascript` to open Terminal with `cd <path> && claude "<command>"`. Windows: `wt` then `cmd /c start`. Linux: the candidates from Review Focus 5. Quote arguments safely; reject a command with a newline.
- [ ] Steps: Rust unit tests for the command-line builders per OS (pure functions `build_macos_script`, `build_windows_args`, `linux_candidates`), `rejects newlines`, `quotes paths with spaces` → FAIL → implement → `cargo test ... terminal_launch` → commit `feat(panel): open Claude Code in a terminal`

### Task 3: Skills panel UI and runners

**Files:**
- Create: `src/components/skills/skills-view.tsx`, `src/lib/skill-panel/run-skill.ts`
- Modify: `src/components/layout/icon-sidebar.tsx` (one entry, only in a mechanism wiki), the view switch that renders sidebar views
- Test: `src/lib/skill-panel/run-skill.test.ts`

**Interfaces:**
- Produces: `export async function runSkill(entry: PanelEntry, inputs: Record<string, string>, deps: { projectPath: string; spawnClaude(...): Promise<...>; openTerminal(...): Promise<string>; copy(text: string): Promise<void>; activity: ActivityApi }): Promise<"started" | "copied">`. Background → `claude_cli_spawn` with `-p` and the command, progress into the activity store, final output or error text shown. Conversation → `open_claude_terminal`; on error → copy the command and say so. Claude Code missing (`claude_cli_detect` fails) → copy fallback.
- [ ] Steps: failing tests for each branch → FAIL → implement → verification → commit `feat(panel): add skills panel`

### Task 4: Settings toggle and lint reminder

**Files:**
- Modify: the project settings section (find the per-project settings component) to add "Version history (git)" on/off, calling `saveMode` and `resetGitHistoryCache`
- Create: `src/lib/skill-panel/lint-reminder.ts` (`ingestsSinceSemanticLint(projectPath): Promise<number>` via a Rust-free approach: count `ingest:` subjects since the marker sha using the existing git commands, adding a `git_log_subjects` command to `git_history.rs` if needed)
- Modify: `skills-view.tsx` to show "已累積 N 次收錄，建議執行健檢" when N ≥ `wiki.yaml` `lint.semantic_reminder_ingests`
- Test: `src/lib/skill-panel/lint-reminder.test.ts`, settings toggle test
- [ ] Steps: failing tests (`toggle on resets cache and next ingest commits`, `reminder appears at threshold`, `no marker counts all ingests`) → FAIL → implement → verification → commit `feat(panel): add version history toggle and lint reminder`

### Task 5: Read-only editor and permission allowlist

**Files:**
- Modify: the wiki page editor component: in a mechanism wiki, open pages under `wiki/` read-only with a one-line notice "此頁由 AI 維護。要修改，請在 Heptabase 寫一張想法卡片。"
- Create: `templates/mechanism-wiki/.claude/settings.json`; modify `.gitignore` (exception); modify `src/lib/mechanism-template.ts` glob to include the dot folder
- Modify: `plugins/llm-wiki/skills/wiki/SKILL.md` (list itself last; invoke the chosen skill with the Skill tool) — fixes deferred minor from sub-project 0
- Modify: `src/i18n/*.json` (add `templates.mechanism.name` and `templates.mechanism.description`, so the template picker shows Chinese in the Chinese UI)
- Modify: `src/lib/__tests__/plugin-contract.test.ts` (`no template file is git-ignored` checks every file under `templates/`, `examples/`, and `plugins/`)
- Test: editor read-only test; template contract test for `settings.json` contents; `no template file is git-ignored` extended to `.claude/settings.json`
- Plugin MCP tools in Claude Code are named `mcp__plugin_<plugin>_<server>__<tool>` (observed in this environment for other plugins). So the Heptabase tools are `mcp__plugin_heptabase_heptabase__*`. The llm_wiki MCP server is configured by the user, so its prefix depends on the server name they choose; the template allows `mcp__llm-wiki__*` and the README tells the user to name the server `llm-wiki`. Still confirm the Heptabase prefix in a real install when one is available, and record the result in the commit message.
- [ ] Steps: failing tests → FAIL → implement → verification → commit `feat(panel): read-only pages and permission allowlist`
