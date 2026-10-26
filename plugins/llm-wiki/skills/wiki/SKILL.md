---
name: wiki
description: Use this skill to see all LLM Wiki skills and to choose one. It shows one line for each skill, asks which skill to run, and then runs that skill with the Skill tool.
---

# wiki

Use this skill as the menu for all LLM Wiki skills.

## The menu

The table has one row for each skill. The row of `wiki` is last, because `wiki` is this menu.

| name | what it does |
|---|---|
| `wiki-sync` | Sync the wiki with Heptabase. Up saves cards as source files. Down writes wiki pages as mirror cards. |
| `wiki-fuse` | Fuse a mechanism with another domain. It writes a checked hypothesis page and makes its card in Heptabase. |
| `wiki-lint` | Check the pages and file each problem as a review item. It never edits a page. |
| `wiki-recut` | Rename, move, split, or merge domains. It shows the plan and waits for a yes. |
| `wiki-undo` | Undo one change to the wiki with git. |
| `wiki` | Show this menu and run the skill that you choose. |

## Steps

1. Show the table of the menu to the user.
2. Find the `skills` folder that contains this skill. If it has a folder that the table does not list, read the `description` in the `SKILL.md` of that folder. Add one row for it before the row of `wiki`.
3. Ask the user which skill to run.
4. Run the skill that the user selects. Use the Skill tool with the name of the skill. Do not read the `SKILL.md` of the skill and follow it by hand.
5. If the user selects `wiki`, show the table again and ask again.

## Rules

- Do not run a skill before the user selects it.
- Keep the row of `wiki` last.
- If a skill in the table is not installed, leave its row out and say so.
