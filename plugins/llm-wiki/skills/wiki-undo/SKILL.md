---
name: wiki-undo
description: Use this skill to undo one change to the wiki. It reverts one ingest, fusion, recut, or lint commit with git. It adds an undo commit and an undo line in the wiki log.
---

# wiki-undo

Use this skill to revert one action commit of the wiki.
An action commit is a git commit with the subject prefix `ingest:`, `fuse:`, `recut:`, `lint:`, or `undo:`.
The undo adds one new commit. It keeps the old commits.

## Requirements

- Node 20 or later.
- git.
- Version history must be on for the wiki. The wiki folder must be a git repository.

## Paths

The base directory of this skill is the folder that contains this `SKILL.md` file.
Paths in this skill start at the base directory.
The script is `scripts/undo.mjs`. In the commands below, `<base>` stands for the base directory.

## Steps

1. Find the wiki folder. Use the current folder. If the current folder has no `wiki/` folder, ask the user for the path of the wiki folder.
2. Run `node <base>/scripts/undo.mjs list --project <wiki folder>`.
3. Read the JSON array that the command prints. Each item has `sha`, `subject`, and `date`. The newest action is first.
4. If the array is empty, tell the user that the wiki has no action to undo. Stop.
5. Show the actions as a numbered table with the columns `#`, `date`, and `subject`.
6. Ask the user which action to undo.
7. Confirm with the user. Name the subject of the action. Say that the undo removes the changes of that action.
8. Run `node <base>/scripts/undo.mjs revert <sha> --project <wiki folder>`. Use the full `sha` of the chosen action.
9. Read the JSON result and answer as the next section says.

## Results

- `{"ok": true}`: Tell the user that the action is undone. Tell the user that the app updates its search index on the next ingest.
- `"reason": "conflict"`: Show the files in `files`. Say that a later action changed the same pages. Suggest that the user undoes the later action first. Say that nothing changed.
- `"reason": "dirty"`: Tell the user that the wiki has changes that are not saved in git. Ask the user to save or discard them. Then run the steps again.
- `"reason": "not-action"`: Tell the user that the commit is not an action that can be undone. Say that nothing changed.
- `"reason": "error"`: Show the `message` to the user. Stop. If the message says "not a git repository", tell the user that version history is off for this wiki.

## Rules

- Do not run `git revert`, `git reset`, or other git commands yourself. Use the script only.
- Do not run `revert` before the user confirms.
- Undo one action at a time.
- Do not edit the wiki files by hand to finish an undo that reported a conflict.
