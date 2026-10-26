---
name: wiki-lint
description: Use this skill to run the semantic lint of a mechanism wiki. It reads the pages of each domain that changed, and then the mechanism pages. It files each problem as a review item in the app. It never edits a page.
---

# wiki-lint

## Purpose

Use this skill for the semantic lint of a mechanism wiki. It covers layer 2 and layer 3 of the lint.

- Layer 1 is the structural lint. It needs no model. The app runs it after each ingest. This skill shows it and does not repeat it.
- Layer 2 reads the pages of one domain at a time. It finds contradictions, superseded claims, and duplicate pages.
- Layer 3 reads the mechanism pages and the first section of their instance pages. It finds domain detail inside a mechanism, two mechanisms that are the same, an instance that does not fit, and a missing failure condition.

You judge the pages. The tool `wiki-tool` lists the domains that changed, cuts the pages of a domain into batches, and writes the marker of the last lint. It never calls a model and never edits a page.
Every finding becomes one review item in the app. The user decides what to do with it.
This skill never edits a page. A finding is a review item, never a fix.
The app can run this skill in the background, where nobody can answer a question. The skill asks no question. It decides by the rules below.

## Requirements

- Node 20 or later.
- git. Version history must be on for the wiki.
- A mechanism wiki. The project folder has `domains.yaml`.
- The `llm_wiki` MCP and the running app. The skill files the findings through them. Rule 8 says what happens without them.
- `LLM_WIKI_API_TOKEN` in the environment of the `llm_wiki` MCP. Adding a review item always needs it. The token is in Settings > API + MCP of the app.

The skill never calls Heptabase.

## Paths

Every command works on the project folder (the folder that contains `wiki/` and `raw/`).
The base directory of this skill is the folder that contains this `SKILL.md` file.
The plugin directory, `<plugin dir>`, is two folders above the base directory.
The tool is `<plugin dir>/scripts/wiki-tool.mjs`.
From the base directory, the path is `<base>/../../scripts/wiki-tool.mjs`.

## Command lines

Every command has this form:

```
node "<plugin dir>/scripts/wiki-tool.mjs" lint <command> --project "<project>" ...
```

- `<command>` is `structure`, `changed-domains`, `batch`, or `mark`.
- The command prints one JSON object on one line.
- Exit code 0 means ok.
- Exit code 2 is a handled problem. The JSON has `"ok": false` and a list `problems`. Show every problem to the user as it is. Then stop the lint as Rule 8 says.
- Exit code 1 is an unexpected error. Show the message to the user. Stop.
- Put a path and a domain in double quotes.
- Only `mark` writes a file. It writes `.llm-wiki/semantic-lint.json`. Never commit that file.

The four commands. The skill always gives `--commit` to `mark`:

```
node "<plugin dir>/scripts/wiki-tool.mjs" lint structure --project "<project>"
node "<plugin dir>/scripts/wiki-tool.mjs" lint changed-domains --project "<project>"
node "<plugin dir>/scripts/wiki-tool.mjs" lint batch --project "<project>" --domain "<domain>"
node "<plugin dir>/scripts/wiki-tool.mjs" lint mark --project "<project>" --commit "<noted commit>"
```

- `structure` gives `findings`. Each finding has `check`, `page`, and `message`, and can have `domains`. `page` is `null` for a finding about a domain. A broken config file gives a `config-invalid` finding.
- `changed-domains` gives `since`, `domains`, `mechanismsChanged`, and `ingestsSince`. It gives `note` when the marker cannot be used.
- `since` is the commit of the last `lint mark`. It is `null` when there is no usable marker. Then `domains` lists every domain of `domains.yaml`, and `mechanismsChanged` is true when the wiki has a mechanism page.
- `domains` lists the domains of the pages that changed since `since`. It includes their `also` domains. In a work wiki, it can name a domain of the reading wiki.
- `mechanismsChanged` is true when a file in `wiki/mechanisms/` changed.
- `ingestsSince` is the number of ingest commits after `since`.
- `changed-domains` counts commits only. Changes that are not committed do not count.
- `batch` gives `batches`, a list of lists of page paths. It gives `notes` when it has one.
- The pages of a domain are the pages with that `domain` and the hypothesis pages with that `to_domain`. A page that names the domain only in `also` is not one. A mechanism page is not one.
- A batch holds pages of one type. It holds at most 60000 characters. Add `--max-chars <number>` to set another limit. A page above the limit is a batch alone, and `notes` names it.
- `mark` gives `commit` and `at`. Without `--commit`, it marks `HEAD`. With `--commit <sha>`, it marks that commit. The commit must be `HEAD` or one of its ancestors. If it is not, `mark` exits with 2 and writes nothing.
- `changed-domains` and `batch` exit with 2 when a config file is not valid, because the list of domains is not reliable. `structure` then shows `config-invalid` findings.

## MCP rules

- Pass `project_id` to every `llm_wiki_*` project tool. Set it to the full path of the project folder. The app can have another project open.
- The skill uses `llm_wiki_status`, `llm_wiki_reviews`, and `llm_wiki_add_review`.
- `llm_wiki_reviews` lists the oldest item first and stops at `limit`. To find items, pass `title_prefix`. The app applies it before it cuts the list. Never list the items and search the list for one item.
- Call no Heptabase tool.

## Rules

1. Read `CLAUDE.md` of the wiki before you read a page. Follow its read order.
2. Never edit, create, move, or delete a file of the wiki. Only `lint mark` writes a file. Run no git command that changes the repository.
3. Read every page of a batch in full. Never judge a page from its title, its summary, or its first lines.
4. File one review item for each finding. Never put two findings in one item.
5. File a finding only when you can name the pages and quote the lines that show it. Never file a doubt.
6. Never file what layer 1 reports.
7. Write the description, and the short finding in the title, in the output language of the wiki. Read it from the line `Output language:` in `purpose.md`. If the line is missing or empty, write in English. Do not ask. Keep the other words of the title as the forms below write them.
8. Run `lint mark` only when the lint reached Step 5, the app ran, and every finding was filed. An item that exists already counts as filed. With no finding, nothing is left to file, so `lint mark` runs. If the app does not run, run no `lint mark`, also when there is no finding. If an `llm_wiki_*` call fails, or the lint stops before Step 5 for any cause, print every finding that was not filed. Exit code 2 is one cause of a stop. Run no `lint mark`. Tell the user to run the skill again with the app open. A marker after findings that were not filed would hide those domains from the next run.
9. Mark the commit that you noted in Step 2, with `--commit`. Never mark a newer `HEAD`. A commit can come in during the lint, and you did not read its pages. The next lint reads its changes.
10. Ask the user no question.

## Filing a finding

Every step below that finds a problem files it as the rules here say.

| Finding | Review type |
|---|---|
| Two pages contradict each other | `contradiction` |
| A newer source or a newer page replaces a claim | `suggestion` |
| Two pages describe the same thing | `duplicate` |
| A mechanism problem | `suggestion` |
| A mechanism problem where the user must choose, for example two mechanisms that may be the same | `confirm` |

- The id of an item comes from its type and its title. Two findings with one title merge into one item. So the title names the domain, and the short finding names the pages by their slugs.
- A title of layer 2 is `Lint (<domain>): <short finding>`.
- A title of layer 3 is `Lint (mechanisms): <short finding>`.
- `affectedPages` lists every page that the finding names. A path starts at the project folder, for example `wiki/concepts/<slug>.md`.
- The description says what you found. It quotes the lines. It says what the user can do about it.
- Send no `options`. The app then adds one Dismiss button.

For layer 2, call `llm_wiki_add_review` with these arguments. Use the type from the table.

```json
{
  "project_id": "<project folder>",
  "type": "contradiction",
  "title": "Lint (<domain>): <short finding>",
  "description": "<What you found. The lines of each page. What the user can do.>",
  "affectedPages": ["wiki/concepts/<slug>.md", "wiki/concepts/<other slug>.md"]
}
```

For layer 3, call `llm_wiki_add_review` with these arguments. Use `confirm` where the table says so.

```json
{
  "project_id": "<project folder>",
  "type": "suggestion",
  "title": "Lint (mechanisms): <short finding>",
  "description": "<What you found. The lines of the page. What the user can do.>",
  "affectedPages": ["wiki/mechanisms/<slug>.md"]
}
```

Before you file the findings of a domain, or the findings of layer 3, look for items that exist. A run that stopped, or a run that did the same domain again, can have filed them.

1. Call `llm_wiki_reviews` with the prefix of the title. For layer 3, the prefix is `Lint (mechanisms): `. Read the titles and the affected pages in the answer.

```json
{
  "project_id": "<project folder>",
  "status": "all",
  "title_prefix": "Lint (<domain>): ",
  "limit": 1000
}
```

2. The prefix ends in a space. Keep the space.
3. Skip a finding when an item states it already and the user decides about it. This holds for an open item (`Resolved: no`). It holds for an item that the user resolved, for example with Dismiss. A dismissal is a decision of the user.
4. For a resolved item, read `Resolved action`. The app closes some items by itself, with the action `llm-judged` or `auto-resolved`. The user did not decide about those. Such an item does not state the finding.
5. File that finding with a new title. Write ` [<the first 7 characters of the noted commit>]` after the short finding. The old title would merge into the closed item, and the finding would stay closed.
6. Two items state the same finding when they name the same pages and the same problem, also when the words of the titles differ.
7. If this call fails, do what the next paragraph says.

If `llm_wiki_status` fails, or any `llm_wiki_*` call fails, make no more `llm_wiki_*` calls. Show the text of the failed call to the user. Keep every finding that is not filed in a list, with its type, title, description, and pages. Go on with the steps. Print the list in the report.

## Steps

### Step 1: Layer 1

1. Find the project folder. Use the current folder if it contains `wiki/` and `raw/`. Otherwise stop. Tell the user to run the skill in the project folder.
2. Read `wiki.yaml`. Note the `role` of the wiki, and `lint.semantic_reminder_ingests`. If the key is missing, the value is 10.
3. Call `llm_wiki_status`. A missing tool or a failed call means that the app is not running. Then tell the user that Rule 8 applies: the skill prints the findings and writes no marker.
4. Run `lint structure`.
5. If the exit code is 2, show the problems. A project without `domains.yaml` is not a mechanism wiki. Stop.
6. Show the findings to the user, grouped by check id. For each id, give the count and then each page with its message. For a finding with no page, give its `domains`. If there is no finding, say so.
7. These findings are in the lint view of the app when the app runs. Do not file them. Do not fix them.

### Step 2: Find the domains

1. Run `git -C "<project>" rev-parse HEAD`. Note the commit as the noted commit. Step 5 marks it, as Rule 9 says.
2. Run `lint changed-domains`.
3. If the exit code is 2, a config file is not valid. Show the problems. Tell the user to fix the file that the `config-invalid` findings name. Stop as Rule 8 says.
4. Tell the user `since`, or that there is no marker. Show `note` if there is one. Tell the user the domains and `mechanismsChanged`.
5. Tell the user `ingestsSince`. If it is at least `lint.semantic_reminder_ingests`, say that this lint is overdue.
6. If the user wants every domain, tell the user to delete `.llm-wiki/semantic-lint.json` and run the skill again. Without a marker, the skill lints every domain. Never delete the file yourself.
7. If `domains` is empty and `mechanismsChanged` is false, tell the user that nothing changed. Go to Step 5.

### Step 3: Layer 2, one domain at a time

Do these steps for each domain of `domains`, in the order of the list. In a work wiki, a domain of the reading wiki gets the same steps.

1. Run `lint batch` for the domain.
2. Show `notes` to the user. If `batches` is empty, the domain has no page of its own. Say so and go to the next domain.
3. Read every page of every batch in full. A page above the size limit is a batch alone. Read it in parts until you have read all of it.
4. Write down the claims of each batch as you read it. Compare each new batch with the claims of the earlier batches of this domain.
5. Find these problems:
   - Contradiction: two pages state claims that cannot both be true.
   - Superseded claim: a page states a claim, and a newer source or a newer page replaces it. Compare the `updated` dates, the `created` dates, and the `sources` lists.
   - Duplicate pages: two pages describe the same thing.
6. File each finding as "Filing a finding" says. Do it when you have read the whole domain.

### Step 4: Layer 3, the mechanism pages

1. Do this step when `mechanismsChanged` is true, or when `since` is `null`. Otherwise tell the user that the mechanism pages did not change, and go to Step 5.
2. List `wiki/mechanisms/`. A work wiki has no mechanism page. If the folder has no page, say so and go to Step 5.
3. Read `schema/page-types/mechanism.md`. It says what a mechanism page holds.
4. Read every mechanism page in full.
5. For each mechanism page, read the first section of each page in its `instances` list. The first section is the frontmatter, the title, and the text up to the first level-2 heading. Find the file by its slug in `wiki/`. If a slug has no page, note it and go on.
6. Find these problems:
   - Domain detail in a mechanism: an industry name, a vendor name, a product name, or a number that belongs to one domain. Also an instance that the page explains instead of listing.
   - Two mechanisms that are the same: compare the one-line statement, the parts, and the flows of each mechanism with the others.
   - An instance that does not fit: the first section of the instance page does not match the parts and the flows of the mechanism.
   - A missing failure condition: the Failure conditions section (key `failure`) has no line, or it holds only a condition that one instance has. The heading is `Failure conditions`, `失效條件`, or `失效条件`, by the output language of the page.
7. File each finding as "Filing a finding" says. Use `confirm` for two mechanisms that may be the same. Use `suggestion` for the others. For two mechanisms, give both pages in `affectedPages`. For an instance that does not fit, give the mechanism page and the instance page.

### Step 5: Mark and report

1. Run `lint mark --commit "<noted commit>"` only as Rule 8 allows.
2. If `lint mark` exits with 2, show the problems. Say that no marker was written.
3. If you did not run it, say why. Print each finding that was not filed.
4. If a commit came in during the lint, tell the user that the next lint reads its changes.
5. Report as the next section says.

## Report

At the end, give the user a short report.

- The layer 1 findings, as counts per check id.
- `since`, the domains that were linted, and whether the mechanism pages were read.
- The number of pages read for each domain.
- The review items filed: counts per type, and counts for layer 2 and layer 3.
- The findings that were skipped because an item exists.
- The findings that were not filed, in full: type, title, description, and pages.
- Whether `lint mark` ran, and the commit that it wrote. If it did not run, say why.
- The reminder about `ingestsSince`, if it applies.
- The problems, as the tool printed them.
