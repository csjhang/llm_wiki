---
name: wiki-undo
description: Use this skill to undo one change to the wiki. It reverts one ingest, fusion, recut, or lint commit with git. It adds an undo commit and an undo line in the wiki log.
---

# wiki-undo

Use this skill to revert one action commit of the wiki.
An action commit is a git commit with the subject prefix `ingest:`, `fuse:`, `recut:`, `lint:`, or `undo:`.
The undo adds one new commit. It keeps the old commits.
The undo keeps every earlier line of `wiki/log.md` and adds one undo line.
The undo changes only the wiki pages. It never changes `raw/`, `.gitignore`, or `heptabase-map.json`.

## Requirements

- Node 20 or later.
- git.
- Version history must be on for the wiki. The project folder must be a git repository.

## Paths

Every command works on the project folder (the folder that contains `wiki/` and `raw/`).
Do not use `<project folder>/wiki` as the project.
The base directory of this skill is the folder that contains this `SKILL.md` file.
Paths in this skill start at the base directory.
The script is `scripts/undo.mjs`. In the commands below, `<base>` stands for the base directory.

## Steps

1. Find the project folder. Use the current folder if it contains `wiki/` and `raw/`. Otherwise ask the user for the path of the project folder.
2. Run `node <base>/scripts/undo.mjs list --project <project folder>`.
3. Read the JSON that the command prints. It is an array of actions, or an object with `reason`. If it is an object, go to the section "Results".
4. Each item of the array has `sha`, `subject`, and `date`. The newest action is first.
5. If the array is empty, tell the user that the wiki has no action to undo. Stop.
6. Check the list for actions that are already undone. An undone action still appears in the list. A newer `undo:` entry that has the same text after `undo: ` names it.
7. Show the actions as a numbered table with the columns `#`, `date`, `subject`, and `state`. Write `undone` in `state` for each action that a newer `undo:` entry names.
8. Ask the user which action to undo.
9. If the action is marked `undone`, tell the user that undoing it again only adds a log line.
10. Confirm with the user. Name the subject of the action. Say that the undo removes the changes of that action.
11. Run `node <base>/scripts/undo.mjs revert <sha> --project <project folder>`. Use the full `sha` of the chosen action.
12. Read the JSON on stdout and answer as the next section says.

## Results

Exit code 2 is a normal handled result. It is not a failure of the tool.
Read the JSON on stdout for exit code 0 and for exit code 2.

- `"ok": true`: Tell the user that the action is undone. Then tell the user these two things:
  - Pages that the undo changed keep their old search text. The user can run "Re-index all pages" in the app's Embeddings settings to update it.
  - `wiki/index.md` can still list pages that the undo removed. The user can run "Rebuild index" in the app's Maintenance settings to update it.
- `"reason": "conflict"`: Show the files in `files`. Then check the newer actions in the list, as the section "Check a newer action" says.
  - If a newer action changed these files: Say that a later action changed the same pages. Suggest that the user undoes the later action first. Say that nothing changed.
  - If no newer action changed these files: Say that nothing changed. Stop.
- `"reason": "dirty"`: Tell the user that the project folder has changes that are not saved in git. The user must save or discard these changes. Do not discard them yourself. Never discard or revert `heptabase-map.json`: it maps wiki pages to Heptabase cards. After the user confirms, run the revert command again.
- `"reason": "not-action"`: Tell the user that the commit is not an action that can be undone. Say that nothing changed.
- `"reason": "busy"`: Tell the user that another wiki tool (the app or a skill) is using git in this project. Say that nothing changed. Ask the user to wait until it is done. Then run the revert command again.
- `"reason": "not-a-wiki-project"`: Tell the user that the path is not a project folder. Ask for the folder that contains `wiki/` and `raw/`. Then run the steps again.
- `"reason": "protected"`: Tell the user that this action changed `.llm-wiki/` or `.gitignore`. Undoing it could put secrets back in git, so the script refuses it. Say that nothing changed.
- `"reason": "error"`: This result has exit code 1. Show the `message` to the user. Stop. If the message says "not a git repository", tell the user that version history is off for this wiki.

## Check a newer action

Use this check for a conflict.
Run `git -C <project folder> show --relative --name-only --format= <sha>` with the `sha` of each newer action.
The output lists the files that the action changed, with paths that start at the project folder.

## Rules

- Do not run `git revert`, `git reset`, or any other git command that changes the repository. Use the script only.
- Never discard, revert, or reset `heptabase-map.json`. It maps wiki pages to Heptabase cards, and nothing can rebuild it. The script keeps it as it is.
- Use `git show` only to read the files of a newer action.
- Do not run `revert` before the user confirms.
- Undo one action at a time.
- Do not edit the wiki files by hand to finish an undo that reported a conflict.
