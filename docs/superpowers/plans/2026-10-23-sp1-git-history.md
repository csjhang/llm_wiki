# Sub-project 1: Git History per Ingest — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Each successful ingest becomes one git commit in the wiki folder. A failed or cancelled ingest restores `wiki/` to the last commit. A `wiki-undo` skill reverts one action commit.

**Architecture:** Rust Tauri commands run the system `git` binary (`src-tauri/src/commands/git_history.rs`). A TypeScript module (`src/lib/git-history.ts`) owns the policy: the per-project mode (`ask`/`on`/`off`), commit messages, baseline commits, and restore. The ingest queue calls that module at three points: task start, task success, task failure. When history is on, the queue runs one ingest at a time, so each commit holds exactly one ingest. Undo is a Node script inside the `wiki-undo` skill, so Claude Code and the Skill panel (sub-project 6) share one implementation.

**Tech Stack:** Rust (std::process::Command), Tauri v2 commands, TypeScript, `@tauri-apps/plugin-dialog` (`ask`), vitest, Node ESM script (no dependencies).

**Spec:** `docs/superpowers/specs/2026-10-23-mechanism-wiki-heptabase-design.md` (sections 6.5, 9.2 undo row, 10.1 `wiki-undo`, 12 row 1)

## Global Constraints

- Commit subject prefixes are exactly `ingest:`, `fuse:`, `recut:`, `lint:`, `undo:`, and `chore:` (baseline and init commits only).
- Ingest commit subject: `ingest: <title> (<N> pages)`; body lists each written path on its own `- ` line.
- A failed or cancelled ingest restores only `wiki/`. Never touch `raw/`, never touch `.llm-wiki/`.
- The wiki repo `.gitignore` written by `git_init` contains exactly these lines: `.llm-wiki/`, `.obsidian/workspace*.json`, `agent-workspace/`. `.llm-wiki/` holds secrets and caches and must never be committed.
- Git failures never fail an ingest. Log a warning and continue.
- When git history is `on`, the effective ingest worker limit is 1.
- When the user has no git identity, commit with `-c user.name=LLM Wiki -c user.email=llm-wiki@localhost`. Never write to the user's git config.
- New behavior goes in new files; upstream files get the smallest edit.
- Verification: `npm run test:mocks`, `npm run typecheck`, and `cargo test --manifest-path src-tauri/Cargo.toml --lib git_history` all pass before each commit. (`mcp-server/dist` must exist for the Rust build; it is already built in this environment.)
- Commit trailer: your session's Co-Authored-By line plus `Claude-Session: https://claude.ai/code/session_013yG6txX1fFsHyk4VQiasu7`.

## Review Focus

1. The user has uncommitted manual edits in `wiki/` when an ingest starts. Expected: the edits are saved in a `chore:` baseline commit first, so a later restore cannot destroy them. (Task 2 test `baseline commits pre-existing changes`.)
2. A new source file lands in `raw/sources/` while an ingest fails. Expected: restore keeps the new raw file. (Task 1 test `restore_dir leaves other folders alone`.)
3. Undo of an older ingest when later ingests changed `wiki/index.md` and `wiki/log.md`. Expected: generated files keep the current version and the revert succeeds; a conflict in a content page aborts cleanly with no half-reverted tree. (Task 4 tests `resolves generated-file conflicts` and `aborts on content conflict`.)
4. The wiki folder is a subfolder of a larger git repo. Expected: commits include only files inside the wiki folder. (Task 1 test `commit_all stays inside a nested project folder`.)
5. `git` is not installed. Expected: mode resolves to `off` silently and ingest works as before. (Task 2 test `git unavailable resolves to off`.)

---

### Task 1: Rust git commands and TypeScript wrappers

**Files:**
- Create: `src-tauri/src/commands/git_history.rs`
- Modify: `src-tauri/src/commands/mod.rs` (add `pub mod git_history;`)
- Modify: `src-tauri/src/lib.rs` (register four commands next to the `file_history` commands)
- Create: `src/commands/git.ts`
- Test: unit tests inside `git_history.rs` (`#[cfg(test)] mod tests`)

**Interfaces:**
- Produces (Rust, all `#[tauri::command]`, sync functions are fine):
  ```rust
  #[derive(Serialize)] #[serde(rename_all = "camelCase")]
  pub struct GitInfo { pub available: bool, pub is_repo: bool }
  pub fn git_info(project_path: String) -> GitInfo
  pub fn git_init(project_path: String) -> Result<(), String>
  pub fn git_commit_all(project_path: String, message: String) -> Result<Option<String>, String> // full SHA, or None when nothing changed
  pub fn git_restore_dir(project_path: String, relative_dir: String) -> Result<(), String>
  ```
- Produces (TypeScript, `src/commands/git.ts`):
  ```ts
  export interface GitInfo { available: boolean; isRepo: boolean }
  export function gitInfo(projectPath: string): Promise<GitInfo>
  export function gitInit(projectPath: string): Promise<void>
  export function gitCommitAll(projectPath: string, message: string): Promise<string | null>
  export function gitRestoreDir(projectPath: string, relativeDir: string): Promise<void>
  ```

Behavior:
- Resolve the binary: `git` on `PATH`, then `/usr/bin/git`, `/opt/homebrew/bin/git`, `/usr/local/bin/git`. On Windows, hide the console window the same way `claude_cli.rs` does (`suppress_windows_console`).
- Run every command as `git -C <project_path> ...`.
- `git_info`: `available` = the binary runs `--version`; `is_repo` = `rev-parse --is-inside-work-tree` prints `true`.
- `git_init`: error if already a repo. Run `init`; write `.gitignore` with the three lines from Global Constraints unless the file exists; then `git_commit_all(project_path, "chore: start version history")`.
- `git_commit_all`: `add -A -- .` (the pathspec `.` is relative to `-C`, so a nested project stays inside its folder); if `diff --cached --quiet -- .` exits 0, return `None`; else `commit -m <message> -- .` and return `rev-parse HEAD`. Add the fallback identity flags when `config user.email` prints nothing.
- `git_restore_dir`: reject an absolute `relative_dir` or one with a `..` segment. Run `restore --source=HEAD --staged --worktree -- <dir>`, then `clean -fd -- <dir>`.
- Map non-zero exits to `Err` with git's stderr.

- [ ] **Step 1: Write the failing Rust tests** in `git_history.rs`

Each test makes a unique temp dir (`std::env::temp_dir().join(format!("llm-wiki-git-{}", Uuid::new_v4()))`, same pattern as `file_history.rs`) and sets a local identity only where the test needs it.
- `info_reports_non_repo`: fresh dir → `available: true, is_repo: false`.
- `init_writes_gitignore_and_first_commit`: after `git_init`, `.gitignore` has the three lines, `git log --oneline` has one commit with subject `chore: start version history`, and `.llm-wiki/secret` created before init is not tracked.
- `init_rejects_existing_repo`.
- `commit_all_returns_none_when_clean`.
- `commit_all_commits_changes`: write `wiki/a.md` → returns `Some(sha)` of 40 hex chars; `git show --stat` lists `wiki/a.md`.
- `commit_all_uses_fallback_identity`: run with `HOME` and `XDG_CONFIG_HOME` pointed at an empty temp dir and `GIT_CONFIG_NOSYSTEM=1` → commit succeeds with author `LLM Wiki <llm-wiki@localhost>`. Pass the env through a private helper `run_git_with_env` that the public functions call with no extra env.
- `commit_all_stays_inside_a_nested_project_folder`: repo root `R`, project `R/wiki-p`; change `R/other.txt` and `R/wiki-p/wiki/a.md` → commit contains only `wiki-p/wiki/a.md`.
- `restore_dir_reverts_modified_and_removes_new_files`: commit `wiki/a.md`; modify it and add `wiki/b.md` → after `git_restore_dir(p, "wiki")`, `a.md` has the committed text and `b.md` is gone.
- `restore_dir_leaves_other_folders_alone`: new untracked `raw/sources/new.md` survives `git_restore_dir(p, "wiki")`.
- `restore_dir_rejects_unsafe_paths`: `"../x"`, `"/abs"`, `"wiki/../.."` → `Err`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test --manifest-path src-tauri/Cargo.toml git_history`
Expected: FAIL to compile (functions missing).

- [ ] **Step 3: Implement `git_history.rs`, register the module and commands, add `src/commands/git.ts`**

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test --manifest-path src-tauri/Cargo.toml git_history && npm run typecheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/commands/git_history.rs src-tauri/src/commands/mod.rs src-tauri/src/lib.rs src/commands/git.ts
git commit -m "feat(git): add git history commands for wiki projects"
```

---

### Task 2: Git history policy module

**Files:**
- Create: `src/lib/commit-message.ts` (pure, no imports from `@/commands` or Tauri, so the bundled `wiki-tool` can reuse it)
- Create: `src/lib/git-history.ts`
- Test: `src/lib/commit-message.test.ts`, `src/lib/git-history.test.ts`

**Interfaces:**
- Consumes: `src/commands/git.ts` (Task 1).
- Produces:
  ```ts
  export type GitHistoryMode = "ask" | "on" | "off"
  export interface GitHistoryDeps {
    loadMode(projectId: string): Promise<GitHistoryMode>      // default "ask"
    saveMode(projectId: string, mode: GitHistoryMode): Promise<void>
    askUser(message: string): Promise<boolean>
  }
  export const defaultGitHistoryDeps: GitHistoryDeps          // store-backed load/save, plugin-dialog `ask`
  // commit-message.ts (re-exported by git-history.ts):
  export function buildActionCommitMessage(prefix: "ingest" | "fuse" | "recut" | "lint", title: string, files: readonly string[]): string
  export function titleFromSourcePath(sourcePath: string): string
  export async function resolveGitHistory(projectId: string, projectPath: string, deps?: GitHistoryDeps): Promise<boolean> // true = on
  export async function prepareIngestBaseline(projectPath: string): Promise<void>
  export async function commitIngest(projectPath: string, title: string, files: readonly string[]): Promise<string | null>
  export async function restoreFailedIngest(projectPath: string): Promise<void>
  ```

Behavior:
- `buildActionCommitMessage`: subject `<prefix>: <title> (<N> pages)` where N = `files.length`; collapse whitespace in `title`; when the subject would pass 72 characters, cut the title and end it with `…`; body is a blank line then one `- <path>` line per file, paths with `/` separators.
- `titleFromSourcePath`: file name without extension; `raw/sources/heptabase/<id>.md` keeps the id.
- `resolveGitHistory`:
  - `gitInfo.available === false` → return `false` without saving anything.
  - mode `on`: return `isRepo`; if the folder is not a repo any more, call `gitInit` first and return `true`.
  - mode `off` → `false`.
  - mode `ask`: if already a repo, save `on`, return `true`. Else call `askUser` with exactly: `Turn on version history for this wiki? Each ingest becomes one git commit that you can undo.` Yes → `gitInit`, save `on`, `true`. No → save `off`, `false`.
  - Cache the result per project id in memory for the session; export `resetGitHistoryCache()` for tests.
- `prepareIngestBaseline`: `gitCommitAll(projectPath, "chore: save changes before ingest")`.
- `commitIngest`: `gitCommitAll(projectPath, buildActionCommitMessage("ingest", title, files))`.
- `restoreFailedIngest`: `gitRestoreDir(projectPath, "wiki")`.
- The three git actions catch every error, `console.warn` with the prefix `[git-history]`, and resolve (`null` for `commitIngest`).
- `defaultGitHistoryDeps.loadMode/saveMode` persist under the key `gitHistoryMode:<projectId>` using the same store the app uses in `src/lib/project-store.ts` (follow `saveProjectLlmOverride`).

- [ ] **Step 1: Write the failing tests** (mock `@/commands/git`; pass fake deps)

- `builds an ingest message`: `("ingest", "Async circuits", ["wiki/sources/a.md", "wiki/concepts/b.md"])` → `"ingest: Async circuits (2 pages)\n\n- wiki/sources/a.md\n- wiki/concepts/b.md"`.
- `truncates long titles`: subject length is 72 and ends with `…` before ` (N pages)`.
- `normalizes backslashes in paths`.
- `titleFromSourcePath`: `raw/sources/franchise-licensing.md` → `franchise-licensing`.
- `git unavailable resolves to off`: `available: false` → `false`; `saveMode` and `askUser` not called.
- `ask mode in an existing repo saves on`.
- `ask mode yes initializes`: `askUser` gets the exact message; `gitInit` called; `saveMode(id, "on")`.
- `ask mode no saves off`: `gitInit` not called.
- `on mode re-initializes a missing repo`.
- `caches per project`: second call does not call `gitInfo` again.
- `baseline commits pre-existing changes`: `gitCommitAll` called with `"chore: save changes before ingest"`.
- `commitIngest swallows errors`: `gitCommitAll` rejects → resolves `null`, `console.warn` called once.
- `restoreFailedIngest restores wiki only`: `gitRestoreDir(path, "wiki")`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/lib/commit-message.test.ts src/lib/git-history.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement `src/lib/git-history.ts`**

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/lib/git-history.test.ts && npm run typecheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/commit-message.ts src/lib/commit-message.test.ts src/lib/git-history.ts src/lib/git-history.test.ts
git commit -m "feat(git): add git history policy for ingest"
```

---

### Task 3: Hook git history into the ingest queue

**Files:**
- Modify: `src/lib/ingest-queue.ts` (`runTask` and the worker-limit check in `processNext`)
- Test: `src/lib/ingest-queue.test.ts` (new `describe("git history")` block)

**Interfaces:**
- Consumes: `resolveGitHistory`, `prepareIngestBaseline`, `commitIngest`, `restoreFailedIngest`, `titleFromSourcePath` (Task 2).
- Produces: no new exports.

Behavior:
- In `runTask`, before `autoIngest`: `const historyOn = await resolveGitHistory(projectId, projectPath)`; if on, `await prepareIngestBaseline(projectPath)`.
- On success (after the `writtenFiles.length === 0` check and before the task leaves the queue): if on, `await commitIngest(projectPath, titleFromSourcePath(task.sourcePath), writtenFiles)`.
- On cancel (both cancel branches) and on failure (every `catch` branch that sets `pending` or `failed`, including usage-limit pause): if on, `await restoreFailedIngest(projectPath)`.
- In `processNext`, use `effectiveWorkerLimit(projectId)`: `1` when the cached history decision for `projectId` is on, else `workerLimit`. Read the cache through a new export `isGitHistoryOnCached(projectId): boolean` in `git-history.ts` (add it there in this task, with one unit test in `git-history.test.ts`).
- Keep every existing behavior when history is off.

- [ ] **Step 1: Write the failing tests** (mock `@/lib/git-history` with `vi.fn()`s, following the existing `vi.mock` style in this file)

- `commits after a successful ingest`: history on → `commitIngest` called once with `(projectPath, "<file-stem>", writtenFiles)`; `prepareIngestBaseline` called before `autoIngest`.
- `restores after a failed ingest`: `autoIngest` rejects → `restoreFailedIngest` called; `commitIngest` not called.
- `restores after cancel`.
- `does nothing when history is off`: none of the three are called.
- `runs one task at a time when history is on`: worker limit 3, three tasks enqueued, `autoIngest` never has two calls in flight.
- `isGitHistoryOnCached reflects the last resolve` (in `git-history.test.ts`).

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/lib/ingest-queue.test.ts src/lib/git-history.test.ts`
Expected: FAIL (new tests only)

- [ ] **Step 3: Implement the hooks**

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run test:mocks && npm run typecheck`
Expected: PASS, including all pre-existing ingest-queue tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/ingest-queue.ts src/lib/ingest-queue.test.ts src/lib/git-history.ts src/lib/git-history.test.ts
git commit -m "feat(ingest): commit each ingest and restore wiki on failure"
```

---

### Task 4: `wiki-undo` skill and undo script

**Files:**
- Create: `plugins/llm-wiki/skills/wiki-undo/SKILL.md`
- Create: `plugins/llm-wiki/skills/wiki-undo/scripts/undo.mjs`
- Test: `src/lib/__tests__/wiki-undo.test.ts`

**Interfaces:**
- Produces (`undo.mjs`, ESM, Node 20+, no dependencies; the CLI runs only when the file is the entry point):
  ```js
  export const ACTION_PREFIXES = ["ingest:", "fuse:", "recut:", "lint:", "undo:"]
  export const GENERATED_PATHS = ["wiki/index.md", "wiki/log.md", "wiki/overview.md"] // plus anything under wiki/indexes/
  export function listActions(projectPath, limit = 20) // -> [{ sha, subject, date }] newest first, only ACTION_PREFIXES subjects
  export function revertAction(projectPath, sha, today) // -> { ok: true, sha } | { ok: false, reason: "conflict", files: string[] } | { ok: false, reason: "not-action" | "dirty" }
  ```
  CLI: `node undo.mjs list [--limit N] [--project PATH]` and `node undo.mjs revert <sha> [--project PATH]`. Print JSON to stdout. Exit 0 on `ok`, 2 on a handled failure, 1 on an unexpected error. `--project` defaults to the current directory.

Behavior of `revertAction`:
1. Refuse when the commit subject has no action prefix (`not-action`) or the work tree has changes (`dirty`).
2. `git revert --no-commit <sha>`.
3. For each conflicted path: if it is in `GENERATED_PATHS` or under `wiki/indexes/`, take the current version (`git checkout --ours -- <path>`, then `git add <path>`).
4. If any other path is still conflicted: `git revert --abort` and return `conflict` with those paths.
5. Append to `wiki/log.md`: `## [<today>] undo | <original subject>`; `git add wiki/log.md`.
6. Commit with subject `undo: <original subject>` and body `Reverts <sha>.` Use the same fallback identity rule as Task 1.

`SKILL.md` (STE English): frontmatter `name: wiki-undo` and a description that says it reverts one ingest, fusion, recut, or lint commit. Steps: run `list`; show the actions as a numbered table; ask which one to undo; confirm with the user; run `revert`; on `conflict`, show the files and say that a later action changed the same pages, and suggest undoing the later action first; on success, tell the user the app updates its search index on the next ingest. Use paths relative to this skill's base directory.

- [ ] **Step 1: Write the failing tests** (create real temp git repos with `child_process.execFileSync("git", ...)`, local identity set in each repo)

- `lists only action commits newest first`: commits `chore: x`, `ingest: a (1 pages)`, `fuse: b (1 pages)` → list has `fuse`, then `ingest`.
- `respects the limit`.
- `reverts a simple ingest`: ingest commit adds `wiki/concepts/a.md` → after revert the file is gone, HEAD subject is `undo: ingest: a (1 pages)`, and `wiki/log.md` ends with the undo line.
- `resolves generated-file conflicts`: ingest A and later ingest B both edit `wiki/index.md` and `wiki/log.md` at the same lines → reverting A succeeds; A's content page is gone; `wiki/index.md` equals B's version.
- `aborts on content conflict`: A creates `wiki/concepts/x.md`, B edits the same lines → reverting A returns `conflict` with `["wiki/concepts/x.md"]`; afterwards `git status --porcelain` is empty and HEAD is B.
- `refuses a non-action commit` and `refuses a dirty tree`.
- `cli prints json`: `node undo.mjs list --project <repo>` exits 0 and prints a JSON array.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/lib/__tests__/wiki-undo.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement `undo.mjs` and write `SKILL.md`**

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run test:mocks && npm run typecheck`
Expected: PASS, including `plugin-contract.test.ts` (it now also checks `wiki-undo`'s frontmatter).

- [ ] **Step 5: Commit**

```bash
git add plugins/llm-wiki/skills/wiki-undo src/lib/__tests__/wiki-undo.test.ts
git commit -m "feat(skill): add wiki-undo skill to revert one action commit"
```

---

## Notes for later sub-projects

- Users who answered "No" to the version-history question have no way to turn it on yet. Sub-project 6 adds a "Version history" toggle in Settings that calls `saveMode` and `resetGitHistoryCache`.
- After an undo, `wiki/index.md` may still list pages the revert removed, because generated files keep the current version. Sub-project 2's domain index rebuild runs on every ingest and removes stale lines.
- `fuse:`, `recut:`, and `lint:` commits reuse `buildActionCommitMessage` (app side) or the same subject format (skill side).
