---
name: wiki-fuse
description: Use this skill to fuse a mechanism with another domain. It writes a checked hypothesis page, commits it, and makes the hypothesis card in Heptabase. It starts from a whiteboard, from a fusion candidate, from a list of candidates, or from a hypothesis that has new evidence. It needs the Heptabase MCP.
---

# wiki-fuse

## Purpose

Use this skill to apply one mechanism to one target domain.
The result is a hypothesis page in `wiki/hypotheses/` of the target wiki.
The page says which parts of the mechanism fit the target domain and which parts do not. It lists what to verify.
The page is a hypothesis. Never write it as a fact.

You judge the fusion. The rule files and the tool `wiki-tool` set the limits.
The tool checks the page and writes the git commit. It never calls Heptabase.
The card of the page reaches Heptabase through the Down steps of the skill `wiki-sync`.

## Modes

| Command | What it does | Steps |
|---|---|---|
| `/wiki-fuse <board>` | Fuses the source cards and the target cards of a Heptabase whiteboard. `<board>` is the title or the id of the whiteboard. | `reference/directed.md` |
| `/wiki-fuse --candidate <review id>` | Fuses the mechanism and the domain of one fusion candidate. The app copies this command for the user. | `reference/explore.md`, section "Start from a candidate" |
| `/wiki-fuse --explore` | Shows up to five candidates. Fuses the one that the user picks. | `reference/explore.md` |
| `/wiki-fuse --update <hypothesis>` | Reads the new query pages. Updates the status and the tables of the hypothesis. | `reference/update.md` |

If the user gives no mode, ask which one to run.
Only the mode `<board>` writes `heptabase_whiteboard` in the page. The card of the page goes on that whiteboard.
The modes `--candidate` and `--explore` write no `heptabase_whiteboard`. The user places the card by hand.
The mode `--update` changes a page that exists.

## Requirements

- Node 20 or later.
- git. Version history must be on for the wiki.
- The Heptabase plugin. It gives the Heptabase MCP tools.
- The skill `wiki-sync` of this plugin.
- The `llm_wiki` MCP and the running app. The modes `--candidate` and `--explore` need them. The other modes use them for review items only.

## Paths

Every command works on the project folder (the folder that contains `wiki/` and `raw/`).
The base directory of this skill is the folder that contains this `SKILL.md` file.
The plugin directory, `<plugin dir>`, is two folders above the base directory.
The tool is `<plugin dir>/scripts/wiki-tool.mjs`.
From the base directory, the path is `<base>/../../scripts/wiki-tool.mjs`.
The skill `wiki-sync` is the folder `<base>/../wiki-sync/`. Its `SKILL.md` and `reference/mcp-steps.md` hold the MCP rules that this skill points to.
The target wiki is the wiki that receives the hypothesis page. A project folder means the folder of the target wiki, unless a step says otherwise.

## Command lines

Every command has this form:

```
node "<plugin dir>/scripts/wiki-tool.mjs" fuse <command> --project "<project>" ...
```

- `<command>` is `resolve-board`, `check`, or `commit`.
- The command prints one JSON object on one line.
- Exit code 0 means ok.
- Exit code 2 is a handled problem. The JSON has `"ok": false` and a list `problems`. Show every problem to the user as it is. Then fix the cause or stop that step.
- Exit code 1 is an unexpected error. Show the message to the user. Stop.
- Put a path in double quotes. Put a title in single quotes. A single quote inside the title is written `'\''`.
- A list option is given once for each file. Example: `--file "<file 1>" --file "<file 2>"`.
- A path of a page is relative to the project folder, for example `wiki/hypotheses/<slug>.md`.
- Never edit `heptabase-map.json` or `heptabase.yaml` by hand.
- Never discard, revert, or reset `heptabase-map.json`. It maps wiki pages to Heptabase cards, and nothing can rebuild it.

The two commands that every mode uses:

```
node "<plugin dir>/scripts/wiki-tool.mjs" fuse check --project "<project>" --file "wiki/hypotheses/<slug>.md"
node "<plugin dir>/scripts/wiki-tool.mjs" fuse commit --project "<project>" --title '<title>' --file "wiki/hypotheses/<slug>.md"
```

- `check` prints `{"ok":true,"problems":[]}` when the page follows `schema/page-types/hypothesis.md`. Otherwise `problems` names each rule that the page breaks.
- `commit` checks each listed hypothesis page first. If one fails, nothing is committed.
- `commit` commits only the listed files. The subject is `fuse: <title> (N pages)`. N is the number of files. The JSON has `sha`.
- If `sha` is `null`, the files had nothing to commit. Tell the user.
- If `commit` reports that another tool uses git, wait and run it again. Never delete a lock file.
- The skill `wiki-undo` reverts a commit of this skill. Tell the user this after a commit.

## Before you start

1. Find the project folder. Use the current folder if it contains `wiki/` and `raw/`. Otherwise ask the user for the path.
2. Create the folder `<project>/.llm-wiki/hepta/` with `mkdir -p`. The folder is git-ignored. Never commit it.
3. Read `wiki.yaml`. Note the `id` and the `role` of the wiki. In a work wiki, note `mechanism_library`. It is the path to the reading wiki.
4. Call `llm_wiki_status` of the `llm_wiki` MCP. Save it as `llm_wiki_status.json`. A missing tool or a failed call means that the app is not running.
5. If the app is not running, tell the user to open it. Go on without review items. The page and the card are the record.
6. Read `CLAUDE.md` of the project folder. Follow its read order. This is Rule 1.
7. Read the mode from the command of the user. Read the file that the table in "Modes" names.

## MCP rules

- Follow the sections "MCP results" and "When a call fails" of `<base>/../wiki-sync/SKILL.md`. They are the rules for saved results and for failed calls. This skill adds none.
- Save every raw MCP result as a file in `<project>/.llm-wiki/hepta/`.
- `<base>/../wiki-sync/reference/mcp-steps.md` gives the exact arguments for `list_whiteboards`, `read_whiteboard`, `read_object`, and the other Heptabase calls. The reference files of this skill name the section to use.
- Pass `project_id` to every `llm_wiki_*` project tool. Set it to the full path of the project folder. The app can have another project open.
- Heptabase writes are real. The Down steps of `wiki-sync` ask for a yes before the first write. Keep that rule.
- Never call a Heptabase write tool outside the Down steps.

## Rules

1. Read `CLAUDE.md` of the target wiki before you read or write a page of it. Follow its read order. If the target wiki is not the project folder, read the `CLAUDE.md` of both.
2. Read the mechanism page. Read the lens of `to_domain`, the lens of `from_domain`, and `schema/page-types/hypothesis.md`.
3. Write the page as `schema/page-types/hypothesis.md` says. That file is the one source for the frontmatter, the six sections, the table columns, and the checklist.
4. Cite a wiki page for every claim. Put every claim that has no page under "What to verify".
5. Set `strength` from the Strength rules in the lens of `to_domain`. Evidence never sets `strength`. Evidence sets the "Fits?" column and `status`.
6. Write the page in the output language of the wiki. Read it from the line `Output language:` in `purpose.md`. Use the section headings that the table in the rule file lists for that language.
7. Run `fuse check` until the page passes. Fix the page, never the check. If the same problem stays after three fixes, stop. Show the problems to the user.
8. Commit with `fuse commit`. Never use `git commit` for a hypothesis page.
9. After the commit, run the Down steps of `wiki-sync` for the new page only. `reference/directed.md`, Step 8, says how.
10. For each row under "What to verify", add one `suggestion` review item. `reference/directed.md`, Step 9, says how. The user can then start deep research in the app.
11. Write only in the target wiki. A work wiki hypothesis never links to a page of the reading wiki and never edits one. It may read the mechanism pages of the reading wiki.
12. A reading wiki hypothesis may also change the mechanism page. `reference/directed.md`, Step 7, says how.
13. Ask the user when a rule does not cover a case. Never choose a pairing, a domain, or a relation silently when the data does not decide it.
14. If a step stops, say so in the report. Do not undo the earlier steps. The page, the commit, and the card stay as they are.

## Report

At the end, give the user a short report.

- The mode that ran, and the whiteboard or the candidate that it started from.
- The target wiki, the page path, and the commit `sha`.
- `relation`, `strength`, and `status`. Name the rule of the lens that gave the `strength`.
- The counts of "fits", "partly fits", "does not fit", and "unknown" rows.
- The rows under "What to verify". Say how many review items were added. If none was added, say why.
- The card: created, placed on the whiteboard, or not made. Say why when it is not made.
- The number of other `wiki-sync` actions that wait for `/wiki-sync`.
- The review item that was resolved, if any.
- The problems and the warnings, as the tool printed them.
- The cards that failed in this run: the title and the card id of each.
