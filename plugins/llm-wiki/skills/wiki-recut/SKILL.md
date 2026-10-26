---
name: wiki-recut
description: Use this skill to change the domain list of a mechanism wiki. It renames, moves, splits, or merges domains, changes every page that uses them, and makes one git commit. It shows the full plan and waits for a yes.
---

# wiki-recut

## Purpose

Use this skill to recut the domains of a mechanism wiki. A recut is one of four operations.

| Operation | What it does |
|---|---|
| `rename` | A domain and its child domains get a new name. |
| `move` | The same as `rename`. Use it when the domain goes below another parent. |
| `split` | One domain becomes two or more new domains. Each page that uses the old domain goes to one of them. |
| `merge` | Two or more domains become one domain. |

You plan the recut. The user confirms the plan. The tool `wiki-tool` runs it.
The tool changes these files:

- `domains.yaml`.
- The domain keys of the pages: `domain`, `also`, `from_domain`, and `to_domain`.
- The Known instances lines of the mechanism pages.
- The domain index files.

It makes one commit.
The tool never calls Heptabase. The recut changes the wiki only. The `domain` property of each mirror card changes at the next `wiki-sync`, after the user adds the select options ("Heptabase options").

## Requirements

- Node 20 or later.
- git. Version history must be on for the wiki.
- A mechanism wiki. The project folder has `domains.yaml`.
- A working tree without uncommitted changes in the wiki folder. The card map `heptabase-map.json` and the folder `.llm-wiki/` do not count.
- The `llm_wiki` MCP and the running app. A merge needs them to file its review items. The other operations do not.
- `LLM_WIKI_API_TOKEN` in the environment of the `llm_wiki` MCP. Adding a review item always needs it. The token is in Settings > API + MCP of the app.

This skill asks the user questions. Run it in a conversation.

## Paths

Every command works on the project folder (the folder that contains `wiki/` and `raw/`).
The base directory of this skill is the folder that contains this `SKILL.md` file.
The plugin directory, `<plugin dir>`, is two folders above the base directory.
The tool is `<plugin dir>/scripts/wiki-tool.mjs`.
From the base directory, the path is `<base>/../../scripts/wiki-tool.mjs`.

## Command lines

Every command has this form:

```
node "<plugin dir>/scripts/wiki-tool.mjs" recut <command> --project "<project>" ...
```

- `<command>` is `pages` or `apply`.
- The command prints one JSON object on one line.
- Exit code 0 means ok.
- Exit code 2 is a handled problem. The JSON has `"ok": false` and a list `problems`. Show every problem to the user as it is. Then follow the section "Problems of apply".
- Exit code 1 is an unexpected error. Show the message to the user. Stop.
- Put a path and a domain in double quotes.

The two commands:

```
node "<plugin dir>/scripts/wiki-tool.mjs" recut pages --project "<project>" --domain "<domain>"
node "<plugin dir>/scripts/wiki-tool.mjs" recut apply --project "<project>" --plan "<project>/.llm-wiki/recut-plan.json"
```

- `pages` changes nothing. It gives `pages`. Each entry has `path`, `title`, `type`, `key`, and `excerpt`.
- `key` is the key of the page that names the domain. It is `domain`. For a hypothesis page, it is `to_domain` or `from_domain`. It is `also` when the page lists the domain as another domain. A page that names the domain in two keys has two entries.
- `excerpt` is the first 300 characters of the body.
- `apply` reads the plan file. The plan is the JSON in the section "The plan file".
- `apply` checks everything before it writes. Then it changes the files and makes one commit. The subject is `recut: <operation> <from> → <to> (<N> pages)`. N counts the changed pages only.
- `apply` gives `sha` and `pages`, the paths of the changed pages. It gives `mergeCandidates` for a merge. It gives `notes` when it has one.

## MCP rules

- Pass `project_id` to every `llm_wiki_*` project tool. Set it to the full path of the project folder. The app can have another project open.
- The skill uses `llm_wiki_status` and `llm_wiki_add_review`.
- Call no Heptabase tool. The MCP cannot add a select option. The user adds it.

## Rules

1. Read `CLAUDE.md` of the wiki before you read a page. Follow its read order.
2. Never run `recut apply` before the user says yes to the full plan. If the plan changes, show it again and ask again.
3. Never edit a page, `domains.yaml`, or an index file by hand. The tool does it.
4. Never commit, stash, or discard the changes of the user. Tell the user to commit or discard them. Rule 10 names one file that the user must not discard.
5. Run no git command that changes the repository.
6. Use only a lens that is in `lenses/`. The lens id is the file name without `.md`.
7. A split needs a new domain for every page that uses the old domain. Never leave a page without one.
8. Write the description of a new domain in the output language of the wiki. Read it from the line `Output language:` in `purpose.md`.
9. Never choose a name, a lens, or a page for the user when the data does not decide it. Ask.
10. Never edit `heptabase-map.json` or `heptabase.yaml`. Never discard, revert, or reset `heptabase-map.json`, and never tell the user to do it. It maps wiki pages to Heptabase cards, and nothing can rebuild it.

## Before you start

1. Find the project folder. Use the current folder if it contains `wiki/` and `raw/`. Otherwise ask the user for the path.
2. Read `CLAUDE.md`, `purpose.md`, `domains.yaml`, and the file names in `lenses/`.
3. Call `llm_wiki_status`. A missing tool or a failed call means that the app is not running.
4. Tell the user that the working tree must have no uncommitted change in the wiki folder. The card map `heptabase-map.json` and the folder `.llm-wiki/` do not count. Rule 4 and Rule 10 say what to tell the user about the other changes.
5. If the user did not name an operation, ask which one to run: `rename`, `move`, `split`, or `merge`.
6. For a merge, the app must run, or the merge cannot file its review items. If it does not run, tell the user that. Ask if the user wants to go on.

## Plan a rename or a move

1. Ask for the domain to change and its new name. The domain must be in `domains.yaml`.
2. A name has lowercase letters, digits, and "-". A `/` separates the levels.
3. The new name must not be in `domains.yaml`. It must not be below the old name.
4. The moved domains are the domain and every domain below it. In `domains.yaml`, these are `<from>` and `<from>/...`. Each one gets the new name in place of the start of its old name. Show the user the old name and the new name of each.
5. Run `recut pages` for each moved domain. Count the pages. This count is a guide. The report names the pages that changed.
6. Build the plan in the form that "The plan file" shows. Keep it in your notes. Do not write the file yet. Go to "Confirm the plan".

## Plan a split

1. Ask for the domain to split. Ask for the new domains. A new domain needs a name, a lens, and a description. Propose a lens and a description. The user confirms them.
2. A new name cannot be the old name. It cannot be a name that is in `domains.yaml`.
3. Run `recut pages` for the domain. Save the answer in your notes.
4. For each path in `pages`, decide the new domain. Read the `excerpt`. Read the whole page when the `excerpt` does not decide it. Give one reason for each page, in one short sentence.
5. A path can have two entries. Give it one new domain. For a hypothesis page, the new domain replaces the old domain in `to_domain`, in `from_domain`, or in both.
6. An entry with `key` `also` is a page that belongs to another domain. The new domain replaces the old domain in its `also` list. Choose the new domain that the page relates to.
7. Ask the user about each page that fits no new domain, and about each page that mixes two of them. Offer these choices: give the page to the nearest new domain, add one more new domain, or stop the split. `recut apply` refuses a plan with a page that has no new domain.
8. Tell the user what a split does not carry over:
   - The whiteboard hints of the old domain in `domains.yaml` are dropped. The user can add them to the new domains by hand.
   - The child domains of the old domain stay where they are.
   - A Known instances line of a mechanism page takes the new domain of the instance page. A line with no matching page stays, and the tool gives a note.
   - The dismissed fusion candidates of the old domain stay under the old name. The app can show them again.
9. Build the plan in the form that "The plan file" shows. Keep it in your notes. Do not write the file yet. Go to "Confirm the plan".

## Plan a merge

1. Ask for the domains to merge. A merge needs at least two. Ask for the target domain. The target can be a new name, one of the merged domains, or another domain that exists.
2. The target needs a lens and a description. Propose them. If the target exists, the plan replaces its lens and its description. Show the user the old text from `domains.yaml`, and ask the user to confirm the new text.
3. The target takes the whiteboard hints of every domain that joins. The child domains of a merged domain stay where they are.
4. Run `recut pages` for each merged domain. Count the pages.
5. Look for a hypothesis page that `recut pages` lists for two of the domains that join, with `from_domain` in one and `to_domain` in the other. After the merge, its two domains are one domain. If its `relation` is `stack`, `recut apply` refuses the plan, because a stack needs two domains. For another relation, `recut apply` gives a note. Tell the user which pages these are before you ask for the yes.
6. Build the plan in the form that "The plan file" shows. Keep it in your notes. Do not write the file yet. Go to "Confirm the plan".

## The plan file

The plan is one JSON object. The value of `op` is the operation. The first step of "Apply" writes it to a file, after the user says yes.

A rename or a move:

```json
{ "op": "rename", "from": "<old domain>", "to": "<new domain>" }
```

A split. `assignments` has one entry for every path that `recut pages` gave, with the new domain of the page:

```json
{
  "op": "split",
  "from": "<old domain>",
  "into": [
    { "domain": "<new domain>", "lens": "<lens id>", "description": "<one sentence>" },
    { "domain": "<other new domain>", "lens": "<lens id>", "description": "<one sentence>" }
  ],
  "assignments": {
    "wiki/concepts/<slug>.md": "<new domain>",
    "wiki/entities/<other slug>.md": "<other new domain>"
  }
}
```

A merge:

```json
{
  "op": "merge",
  "from": ["<domain>", "<other domain>"],
  "into": { "domain": "<target domain>", "lens": "<lens id>", "description": "<one sentence>" }
}
```

## Confirm the plan

1. Show the full plan. Never cut the list.
2. Name the operation. Show the domains before and after, as a table.
3. For a split, show every page with its key, its new domain, and its reason. Show the pages of the `also` entries too.
4. Show the count of the pages that change, from `recut pages`.
5. Show what the tool changes: `domains.yaml`, the domain keys of the pages, the Known instances lines, the domain index files, and one commit.
6. Show what the tool does not carry over, as the section of the operation says.
7. For a merge, show each hypothesis page that gets one domain, with its relation.
8. Ask: "Run this plan?" Wait for the answer.
9. A yes starts the next section. Any other answer ends it. If the user changes the plan, go back to the section of the operation. Show the new plan and ask again.

## Heptabase options

Do this after the yes and before `recut apply`.
The mirror tag has a `domain` property of type select. Each option is a domain name. The next `wiki-sync` sets the property of each card to the domain of its page. It stops a card whose option does not exist, and it names the missing option.
Tell the user to add these options to the `domain` property of the mirror tag in Heptabase before the next `wiki-sync`:

- Rename and move: the new name of each moved domain. The user can rename the old option in place of this. Then the cards follow the new name.
- Split: each new domain of `into`.
- Merge: the target domain, if no option has its name.

Tell the user that the old options stay. The user can remove them by hand after the sync.

## Apply

1. Write the plan to `<project>/.llm-wiki/recut-plan.json` with the file tool. Create the folder first. Never commit it.
2. Run `recut apply` with the plan file.
3. If the exit code is 2, follow "Problems of apply".
4. If the exit code is 0, show `notes` to the user as they are. Then go on to "After the recut".

## Problems of apply

A recut that exits with 2 has written nothing. If a problem says that a file could not be put back, tell the user to restore that file with git.

| The problem says | What to do |
|---|---|
| The working tree has uncommitted changes | Show the files. Follow Rule 4 and Rule 10. After the user says it is done, run `recut apply` again. |
| A file is a link, a folder in its path is a link, or a file is outside the project | Show the path. Tell the user that the recut cannot run until the path is a plain file or folder inside the project. |
| A page names a key that the tool cannot edit | Show the page and the key. Tell the user to write the frontmatter of that page with its keys in the first column. After the user says it is done, run `recut apply` again. |
| A page changed while the recut ran | Run `recut apply` again. |
| Another wiki tool is using git | Wait. Run `recut apply` again. Never delete a lock file. |
| The plan has a mistake, for example a page without a new domain, a name that exists, or a lens that is not known | Show the problem. Go back to the section of the operation. Fix the plan with the user. Ask again, as "Confirm the plan" says. |
| A hypothesis with `relation: stack` would get one domain | Show the page. Tell the user that a stack needs two domains. Go back to "Plan a merge". Change the plan so that the two domains of the page stay two domains. Ask again, as "Confirm the plan" says. |
| The commit failed | The tool put every file back. Show the message. Ask the user what to do. |
| Anything else | Show the problem as it is. Stop. Do not try another way to make the change. |

## After the recut

1. Tell the user the commit `sha` and the number of changed pages.
2. For a merge, read `mergeCandidates`. Each entry is a pair `a` and `b` of pages with the same name that the merge brought into one domain. The app gives the second page of a name the suffix `--<domain>`, so `attention` and `attention--beta` have the same name. If the list is empty, say so.
3. Group the pairs. Pages that are in one pair, or in pairs that share a page, are one group. The slug of a group is its shortest file name, without the folder and without `.md`. For each group, call `llm_wiki_add_review` once, with the arguments below. `affectedPages` holds every page of the group.

```json
{
  "project_id": "<project folder>",
  "type": "duplicate",
  "title": "Recut merge (<target domain>): <slug>",
  "description": "The merge of <merged domains> brought these pages with one name into <target domain>. Check if they describe the same thing. If they do, merge them.",
  "affectedPages": ["<path a>", "<path b>"]
}
```

4. The title carries the domain and the slug. The id of an item comes from the type and the title. So two groups never share an item.
5. If the app does not run, or a call fails, make no more calls. Show the text of the failed call to the user. Print the groups that have no item. Tell the user to check them by hand.
6. If `notes` says that this is a reading wiki, tell the user this. A work wiki whose `mechanism_library` is this wiki keeps the old names in the `from_domain` and `to_domain` of its hypothesis pages. Those pages need the new names from the note. The recut of the work wiki cannot change them. Until the user changes them, `fuse check` and the lint of the work wiki report them.
7. Tell the user the select options again, as "Heptabase options" says. Tell the user to run `/wiki-sync` after the options exist.
8. Tell the user to run Lint in the app, or `wiki-tool lint structure`, to see the new domain sizes. The lint view shows the old items until then.
9. Tell the user that `wiki-undo` reverts the commit of the recut. The `domain` property of a card is not in git. After an undo, the next sync writes the value of the wiki back to the card.
10. Report as the next section says.

## Report

At the end, give the user a short report.

- The operation, and the plan in one table.
- The commit `sha` and the subject.
- The pages that changed. If the list is long, give the count and the first ten paths.
- The `notes` of the tool, as it printed them.
- The select options to add in Heptabase, and the old options that the user can remove after the sync.
- The review items filed for the merge candidates, one per group. If none was filed, say why.
- For a split, the page assignments and their reasons.
- For a reading wiki, the names that a work wiki must change.
- The advice of "After the recut" about the undo and the lint.
- The problems, as the tool printed them.
