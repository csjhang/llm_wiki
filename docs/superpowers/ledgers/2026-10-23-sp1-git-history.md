# SDD ledger — plan: docs/superpowers/plans/2026-10-23-sp1-git-history.md

Spec: docs/superpowers/specs/2026-10-23-mechanism-wiki-heptabase-design.md (reachable). Branch: design/heptabase-wiki. Rust builds and tests run in this environment (mcp-server/dist built).

## Pre-flight scan

| Pair / task | Produces vs consumes | Finding |
|---|---|---|
| T1 -> T2 | T2 consumes gitInfo/gitInit/gitCommitAll/gitRestoreDir from src/commands/git.ts | consistent |
| T2 -> T3 | T3 consumes resolveGitHistory, prepareIngestBaseline, commitIngest, restoreFailedIngest, titleFromSourcePath; T3 adds isGitHistoryOnCached to git-history.ts | consistent (T3 edits a T2 file; allowed by plan) |
| T2 -> T4 | undo.mjs uses its own subject parsing; formats `<prefix>: ...` match buildActionCommitMessage | consistent |
| T1 self | restore uses `git restore -- wiki`; fails with "pathspec did not match" if wiki/ has no tracked file | gap -> Ruling S1 |
| T1 self | git_init writes .gitignore only when absent; an existing .gitignore without `.llm-wiki/` would let secrets be committed | gap -> Ruling S2 |
| T1 self | sync #[tauri::command] functions block the main thread while git runs | gap -> Ruling S3 |
| T2/T3 | baseline commit `add -A -- .` commits raw/ (sources, PDFs) | design -> Ruling S4 |
| T3 self | tests match behavior list | consistent |
| T4 self | consistent | consistent |
| Rubric conflicts | none | none |

Ruling S1: git_restore_dir treats "pathspec did not match" from `git restore` as success, then still runs `git clean -fd -- <dir>`. — Why: a wiki/ with only new files has nothing to restore. — Cost if wrong: one error branch.
Ruling S2: git_init appends any missing required line (.llm-wiki/, .obsidian/workspace*.json, agent-workspace/) to an existing .gitignore; git_commit_all first checks that `.llm-wiki/` is ignored (`git check-ignore`) and appends the line if not. — Why: .llm-wiki/ holds secrets; never commit it. — Cost if wrong: an extra .gitignore line.
Ruling S3: the four Tauri commands are async and run git in `tauri::async_runtime::spawn_blocking`, like rebuild_wiki_index. Pure inner functions stay sync for tests. — Why: never block the UI thread. — Cost if wrong: none.
Ruling S4: raw/ is committed with the wiki. — Why: raw/sources is the SSOT for originals and lets the wiki be rebuilt. — Cost if wrong: repo size grows with PDFs; a user can add raw/assets to .gitignore.

## Tasks
Task 1: dispatched (base 375b84c, implementer sonnet)
Ruling S5: app-made commits (git_commit_all, and git_init's first commit) pass `--no-verify` and `-c commit.gpgsign=false`. — Why: an automatic commit must not open a pinentry dialog or run the user's hooks inside a background ingest. — Cost if wrong: the user's signing and hook policy does not apply to wiki auto-commits.
Task 1: minor (deferred): already-tracked .llm-wiki/ files stay tracked; Windows creation_flags branch not compiled here
Task 1: review needs fixes (2 Important: S5 missing; pre-tracked .llm-wiki/ leaks into commits)
Ruling S6: when .llm-wiki/ is already tracked, git_commit_all untracks it with `git rm -r --cached -q -- .llm-wiki` before committing (files stay on disk). — Why: never commit secrets. — Cost if wrong: the next commit shows .llm-wiki/ removed from the index.
Task 1: minor (deferred): no timeout on git subprocesses; failed git lookups re-spawn the macOS git shim
Task 1: fix round 1 dispatched (resume implementer; fix base 159ee1d)
Ruling S6a: when .llm-wiki is in the index or in HEAD, commit the whole index (no '-- .' pathspec) after 'git rm -r --cached', and refuse with Err when the repo has staged changes outside the project folder. — Why: a path-limited commit re-reads the file from disk and re-commits the secret (reproduced). — Cost if wrong: a nested project with that rare setup cannot auto-commit until the parent repo's staged changes are resolved.
Task 1: fix round 1/5 (5 addressed, 0 open; commits 159ee1d..d560706)
Task 1: minor (deferred, worth fixing): `git rm -r --cached` without `-f` fails when a staged .llm-wiki file was edited again on disk (no leak, but auto-commit keeps failing); refusal test asserts only is_err(); index-only .llm-wiki case takes the whole-index route unnecessarily
Task 1: complete (commits 375b84c..d560706, review clean after 1 fix round)
Task 2: dispatched (base d560706, implementer sonnet)
Ruling S7: in ask mode, save `on` silently only when the project folder is the repo top level. A project nested inside another repo gets the same ask dialog (Yes = use the enclosing repo with commits limited to the folder; No = off). This needs `GitInfo.isRoot` (Rust: canonical `rev-parse --show-toplevel` equals the canonical project path). — Why: never auto-commit into an unrelated repo (for example a home folder in git). — Cost if wrong: one extra question for users with nested wikis.
Ruling S8: resolveGitHistory catching errors (warn, resolve false, do not cache) is accepted. — Why: global rule "git failures never fail an ingest". — Cost if wrong: the ask can repeat after a failed init.
Task 2: review needs fixes (2 Important: S7 missing; store name duplicated)
Ruling S7a: a Yes for a nested project does not call gitInit; the enclosing repo is used with commits limited to the folder. — Why: git_init refuses inside a repo; nested commits already stay in the folder. — Cost if wrong: history lives in the enclosing repo.
Task 2: fix round 1 dispatched (resume implementer; fix base f1cb433)
Task 2: fix round 1/5 (5 addressed, 0 open; commits f1cb433..0629692)
Task 2: minor (deferred): resolveGitHistory .catch deletes the cache entry unconditionally (stale delete after a reset in flight); purity guard misses `export ... from`; an in-flight decision can saveMode after an SP6 toggle reset (note for SP6)
Task 2: complete (commits d560706..0629692, review clean after 1 fix round)
Task 3: dispatched (base 0629692, implementer sonnet)
Ruling S10: accept getCachedGitHistory(id) export, the pre-warm in startTask, a single restore at the top of catch, and stale-project re-checks after commit/restore. — Why: keeps existing tick-counting tests unchanged and keeps the limit-1 rule true for the first batch. — Cost if wrong: one more export.
Ruling S9: when a project switch makes runTask return early (stale), still act on the OLD project by path when history was on for that run: after a successful autoIngest → commitIngest; in catch → restoreFailedIngest. Do not touch the queue in those paths. — Why: otherwise partial or finished pages fold into the next baseline commit and cannot be undone cleanly. — Cost if wrong: one git call on a project that is no longer open.
Task 3: review needs fixes (2 Important: S9 missing; cancel-after-success restore lacks a stale re-check)
Ruling S11: effective worker limit is 1 while the git decision is unsettled; workerLimit applies only when the decision is settled and false. — Why: two concurrent history-on runs can sweep or wipe each other's writes. — Cost if wrong: the first ingest batch after a failed resolve runs one at a time.
Task 3: minor (deferred, design gap): chat-message.tsx:623 calls autoIngest directly (bypasses the queue, so no commit/restore); manual edits during an ingest can be committed under the ingest title or wiped by a restore (SP6 makes pages read-only)
Task 3: minor (deferred): usage-limit test does not distinguish its branch; cancel during the commit window is dropped (commit already landed)
Task 3: fix round 1 dispatched (resume implementer; fix base 7bfd233)
Ruling S11a: a git probe that keeps failing holds that project at one worker. — Why: safe default; only a settled 'off' restores the configured limit. — Cost if wrong: slower batches when git is broken.
Task 3: fix round 1/5 (3 addressed, 0 open; commits 7bfd233..48e68cd)
Task 3: minor (deferred, final review): same-project race — stale commit/restore by path is not serialized with a fresh run if the user switches away and back quickly; dead export isGitHistoryOnCached; cancelled task finishing after a switch is committed (abort-ignoring autoIngest only)
Task 3: complete (commits 0629692..48e68cd, review clean after 1 fix round)
Task 4: dispatched (base 48e68cd, implementer sonnet)
Ruling S12: revertAction success returns `{ ok: true, sha: <new undo commit sha>, reverted: <reverted commit sha> }`. — Why: the undo commit sha lets a later undo of the undo, and the panel can show both. — Cost if wrong: one field name.
Ruling S13: accept: unresolvable sha, sha starting with "-", sha outside HEAD history, and merge commits return not-action; a root commit with an action prefix can be reverted; staged changes outside a nested project count as dirty. — Why: safe refusals. — Cost if wrong: a rare refusal.
Task 4: review needs fixes (3 Important: S12 missing; fallback identity differs from Task 1; wrong --project silently corrupts the undo)
Ruling S14: wiki/log.md is append-only — after git revert --no-commit, always restore it to HEAD, then append the undo line. — Why: a clean revert otherwise deletes the reverted action's log line. — Cost if wrong: the log keeps lines for undone actions (with an undo line after them).
Task 4: fix round 1 dispatched (resume implementer; fix base f80187b)
Task 4: fix round 1/5 (7 addressed, 0 open; commits f80187b..70765f2)
Task 4: minor (deferred): SKILL.md step 3 says "JSON array" but list can print an object; "Check a newer action" needs `git show --relative`; `undone` heuristic matches same-title actions; step 9 warning comes after the confirm step; gitignored untracked log.md edge case; listActions (JS) not guarded; LF append on CRLF logs; nested tests do not assert log content
Task 4: complete (commits 48e68cd..70765f2, review clean after 1 fix round)
Final review (opus): With fixes — 3 Critical (C1 whole-wiki restore destroys other writers' files; C2 undo deletes raw sources swept into a commit; C3 restore after a failed baseline wipes earlier ingests), 7 Important (I1 stale resume state; I2 crash mid-ingest; I3 undo can re-track .llm-wiki; I4 nested dialog vague; I5 commit sweeps other changes; I6 git deletions trigger external-delete cleanup; I7 app/skill commit coordination — SP3)
Ruling T1–T9 (see final-fix-findings.md): scoped restore by written paths; undo keeps raw/ and .gitignore; restore only after a good baseline plus visible warnings; clear resume state; in-flight record for crash recovery; .llm-wiki untracking as its own commit and undo refuses protected paths; nested dialog names the repo; commit only this run's paths; tell the watcher about restored paths. — Why: the old design could silently destroy user work. — Cost if wrong: more git calls per ingest.
S4 note: its cost was incomplete (undo could delete raw files); T2 closes it.
S7 amended by T7 (nested dialog text names the enclosing repo).
Carried to SP2 plan: fingerprints must check the existing source page still exists; wiki/indexes/ writes must be tracked as written files; isAppManagedAggregatePath includes wiki/indexes/.
Carried to SP3 plan: one shared JS commit helper and a `.llm-wiki/git.lock` honored by the app, undo.mjs, and wiki-tool (I7).
Final fix wave: dispatched (fix base 70765f2, implementer opus — data-safety-critical, multi-file)
Final fix wave: commits 4d3e410, d49c408, d6c7afc (on top of docs commit d6b7410); cargo 56, vitest 2390 pass
Ruling T10: accept fix-wave deviations — M2 names both Embeddings "Re-index all pages" (search) and Maintenance "Rebuild index" (index page); I3 builds the untracking commit from HEAD in a temporary index, which removes the S6a refusal (outer staged changes stay staged and uncommitted); I2 deletes the in-flight record after any commit or restore attempt and a run whose record was already recovered skips its own restore; I6 uses snapshot invalidation and Rust app-write marks; restore never deletes git-ignored files. — Why: each is safer or more accurate than the finding's wording. — Cost if wrong: small.
Final fix: open limits (deferred): restoring wiki/index.md, log.md, overview.md as whole files drops lines that other features added during a failing run; interactive chat ingest (executeIngestWrites) bypasses per-ingest commits; an undo still triggers the watcher's delete cleanup for pages the undo removed
Final re-review (opus): all final findings addressed; new breakage N1 (Important, confirmed: empty new media folder fails git add, ingest commit lost), N2 (Important, plausible: core.ignorecase restore deletes a tracked page whose case differs), N3–N6 Minor, plus pre-existing out-of-scope: path-limited commit re-tracks a file removed with `git rm --cached`.
Ruling T11: N1 and N2 are load-bearing (N2 can delete a user page; N1 loses the ingest commit). Fix both in one narrow residual dispatch (brief residual-fix-brief.md, one file, 4 tests), then one scoped check. — Why: the one-fix-wave rule exists to stop endless loops; a data-loss residual still needs the smallest unblocking change. — Cost if wrong: one extra small dispatch.
Ruling T12: park N3 (temp-index chore commit can end an in-progress merge → SP3 shared commit helper must refuse during merge/rebase), N4 (crash recovery overwrites edits made after the crash → per-path hashes, later), N5 (temp index name collision across nested projects → SP3 lock), N6 (.gitignore in the ingest commit makes it `protected` → revisit with SP3 helper), and the `git rm --cached` re-track issue (pre-existing upstream behaviour of path-limited commit). — Why: none loses data in the common single-wiki flow. — Cost if wrong: rare surprising commits; carried to SP3 plan notes and the final report.
Residual fix: dispatched (base d6c7afc, implementer sonnet)
Residual fix: review base is 271f2f7 (docs commit landed during the dispatch)
Residual fix: commit dee60a0 (cargo git_history 62 pass: 56 + 4 brief + 2 extra)
Ruling T13: accept the residual-fix deviations — N2 compares against tracked names under the whole wiki/ folder (a parent-only pathspec misses a case-variant folder); 2 extra tests; the commit trailer names the model that wrote it. — Why: wider match is the safer direction. — Cost if wrong: one extra ls-files call per restore.
Residual fix: scoped check dispatched (sonnet, package review-271f2f7..dee60a0.diff)
Residual fix: scoped check clean (N1, N2 addressed; Minor (deferred): a repo tracking `Wiki/` with capital W on an ignorecase disk still misses the case match; lowercase cost is O(unknown × tracked); no-HEAD + ignorecase now errors instead of deleting)
Ruling T14: keep every plan workspace until the whole branch finishes, then collect all Ruling lines into the final report and delete the workspaces. — Why: the final report needs the ledgers. — Cost if wrong: a few KB of git-ignored scratch for longer.
SUB-PROJECT 1: COMPLETE (commits 375b84c..dee60a0)
