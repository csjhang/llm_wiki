# Directed mode

Use these steps for `/wiki-fuse <board>`.
The whiteboard has source cards and target cards. The source cards give the mechanism. The target cards give the target domain.
`reference/explore.md` and `reference/update.md` point to some of these steps. A step number here always means a step of this file.
`SKILL.md` has the rules, the command lines, and the MCP rules. Read it first.

## Step 1: Read the board

1. Find the id of the whiteboard. If `<board>` is a UUID, use it. Otherwise call `list_whiteboards` as the section "list_whiteboards" of `wiki-sync/reference/mcp-steps.md` says. Find the title in the saved pages.
2. If no whiteboard has that title, or two have it, show the matches to the user and ask. Never guess.
3. Call `read_whiteboard`. Save it as `read_whiteboard-<board id>.json`.

```json
{ "whiteboardId": "<board id>", "mode": "structure" }
```

4. The saved file is the JSON envelope of the MCP. Read the lines in its `content` text. Find the lines whose first word is `mindMap`. Ignore the indent. Each line holds the title and the id of a mind map. Call `read_object` for each mind map. `objectType` is the first word of the line.

```json
{ "objectType": "mindMap", "objectId": "<mind map id>" }
```

5. Save each result as `read_object-<mind map id>-p<n>.json`.
6. If a result has `hasMore: true`, call again with `offset` set to the last line number you have. Save every page. Pass every page of a mind map to the next command.
7. Check `status` of every result. Only `succeeded` is good. Follow "When a call fails" of `wiki-sync` for a failed call.
8. Give `--mindmap` once for each file. Give `--wiki` once for each other wiki that the cards may belong to. In a work wiki, give the reading wiki as `--wiki`. Its path is `mechanism_library` in `wiki.yaml`. The path is relative to the project folder.
9. Run the command.

```
node "<plugin dir>/scripts/wiki-tool.mjs" fuse resolve-board --project "<project>" --structure "<structure file>" --mindmap "<mind map file 1>" --mindmap "<mind map file 2>" --wiki "<other wiki path>"
```

10. Read the JSON. It has `boardId`, `boardTitle`, `pairing`, `cards`, and `warnings`. Show the `warnings` to the user.
11. If a warning says that a mind map has no file, read that mind map and run the command again.
12. Each entry of `cards` has `title`, `section`, `side`, `status`, `wiki`, and `pages`. `side` is `source`, `target`, or `null`.

### The pairing

1. If `pairing` is not `null`, tell the user in one line which cards are the source side and which cards are the target side. Go on.
2. If `pairing` is `null`, the board has no source section and no target section, or only one of them. Do not pick a side yourself.
3. Propose a pairing. Group the cards by `wiki` and by the domain of their pages. Name the cards of each side to the user.
4. Wait for the answer of the user. Use the answer as the pairing. A card that the user leaves out is not used.

## Step 2: Find the wiki page of each card

Read the `status` of each card that is in the pairing.

| `status` | What to do |
|---|---|
| `mirror` | The card is the mirror card of the page in `pages`. Use that page. |
| `ingested` | The pages in `pages` came from the card. Use them. If `pages` is empty, the app has not made pages from the snapshot yet. Tell the user to open the app and wait for the ingest. Leave the card out. |
| `not-ingested` | No wiki knows the card. Name the card. Ask the user to add the ingest tag to it in Heptabase and to run `/wiki-sync`. Do not go on with this card until it is ingested. |
| `retired` | The page of the card is gone. Leave the card out. Tell the user. |

1. If the user says that a `not-ingested` card belongs to another wiki, ask for the path of that wiki. Run `resolve-board` again with that path as `--wiki`.
2. The target wiki is the wiki of the target pages. Its id is `wiki` in the entry. If it is not the project folder, ask the user for its path. The folder of the target wiki is the project folder from now on. Use it as `<project>` and as `project_id`.
3. Leave out each target card whose `wiki` is not the target wiki. The page of the card is in another wiki, and a hypothesis page never cites or links a page of another wiki. Add the card to the cards that you left out. The report names them.
4. Read `CLAUDE.md` of the target wiki, as Rule 1 of `SKILL.md` says. Read `wiki.yaml` and `domains.yaml`. Read `purpose.md` for the `Output language:` line.
5. Read the `domain` in the frontmatter of the target pages. This is `to_domain`. Do the same for the source pages. This is `from_domain`.
6. A page that is not a mechanism page and has no `domain` cannot give a domain. An example is a hypothesis page. Leave its card out.
7. Each side needs at least one card that has a page. If a side has none, stop. Tell the user what is missing.
8. If you left out any card, name each card and say why. Ask the user: go on without it? Wait for the answer. If the answer is no, stop.
9. If a side has pages from more than one domain, ask the user which domain to use. A domain must be in `domains.yaml` of the target wiki or of the reading wiki.
10. A mechanism page has no `domain`. If the source page is a mechanism page, propose the domain of one instance from "Known instances". Ask the user to confirm it.

## Step 3: Find the mechanism

1. If a source page has `type: mechanism`, that page is the mechanism page.
2. Otherwise, search the mechanism pages of the reading wiki for a link to the source pages.

```
grep -n '\[\[<slug>[]|#\]' "<reading wiki>/wiki/mechanisms/"*.md
```

3. A hit counts only in two cases. The link is a line under "Known instances", or the slug is in the `instances:` list of the frontmatter. A link in another section does not count. In a reading wiki, the folder is `wiki/mechanisms/` of the project. In a work wiki, it is in the reading wiki.
4. If more than one mechanism page is found, show them to the user and ask which one to use.
5. Read the whole mechanism page. Note its parts, its flows, its constraints, and its failure conditions.
6. If no mechanism page is found, the source side has no mechanism yet. Do not write a mechanism page in this run. Do these steps:
   1. Read the source pages. Extract one candidate mechanism in domain-neutral words, as `schema/page-types/mechanism.md` says.
   2. Call `llm_wiki_add_review` with the arguments below. In a reading wiki, change the item as the note under the block says. Save the result as `llm_wiki_add_review-new-mechanism.json`.
   3. Stop the fusion for now. Say that the user can run the fusion again after the mechanism page exists.
   4. In a work wiki, tell the user that the mechanism needs approval first. The option `mech:propose-mechanism` sends the proposal to the reading wiki as a note.
   5. In a reading wiki, tell the user that the mechanism page can be written in this wiki directly. A proposal is not needed.

```json
{
  "project_id": "<project folder>",
  "type": "new-mechanism",
  "title": "<mechanism title>",
  "description": "<one line that states the mechanism, then the six sections of the mechanism rule file>",
  "affectedPages": ["<source page path>"],
  "options": [
    { "label": "Write to reading wiki", "action": "mech:propose-mechanism" },
    { "label": "Skip", "action": "Skip" }
  ]
}
```

   In a reading wiki, the library is this wiki. The action `mech:propose-mechanism` would write a note that says "Instances: 1 in work wiki", which is wrong there. Start the `description` with the sentence "This reading wiki can hold the mechanism page itself. Write the page here directly." Then replace `options` with this:

```json
{ "options": [{ "label": "Skip", "action": "Skip" }] }
```

7. If the app does not run, give the proposal to the user as text. Then stop.

## Step 4: Judge the relation

1. Decide if the relation is `analogy` or `stack`. An analogy borrows the mechanism for a domain that stays separate. In a stack, one domain is the base layer of the other domain.
2. The data decides in two cases only. Both domains have an instance under "Known instances" of the one mechanism page: the relation is `analogy`. A page of the target wiki says that the target domain is built on the source domain: the relation is `stack`.
3. In every other case, name the two choices to the user and ask. Wait for the answer.
4. In a stack, `from_domain` is the base layer and `to_domain` is the upper layer. Tell the user which domain you put in each place.
5. Check that `from_domain` and `to_domain` are two different domains.

## Step 5: Apply the mechanism

1. Read the lens of `to_domain`. The domain entry in `domains.yaml` names the lens. Read the lens of `from_domain` too.
2. Read the target pages from Step 2. Read the index of the target domain: `wiki/indexes/<domain>.md`. Replace each `/` in the domain with `--` in the file name. If the file does not exist or lists no page, use the target pages from Step 2 only.
3. Open the other pages of the index that could relate to a part, a flow, or a constraint. When the index is long, call `llm_wiki_search`. It needs the app. Skip it when the app is not running.

```json
{ "project_id": "<project folder>", "query": "<a part or a flow of the mechanism, in the words of the target domain>", "top_k": 10 }
```

4. Read the failure conditions of the mechanism. Check each one against the target domain.
5. Write one mapping row for each part, each flow, and each constraint of the mechanism. Find the counterpart in the target pages.
6. For each row, pick the "Fits?" value as the rule file says. Follow Rule 4 of `SKILL.md` for a row that has no page.
7. A failure condition that the target domain meets goes under "Gaps and impact". Follow Rule 4 for its page.
8. If the target domain has no page that you can cite, stop. Tell the user to ingest sources about the target domain first.

## Step 6: Judge the strength

1. Read the Strength rules in the lens of `to_domain`. Read the Do list of `schema/page-types/hypothesis.md` for the rules about `strength`.
2. Pick the level as they say.
3. Write down the rule of the lens that gave the level. You need it for the report.

## Step 7: Write, check, and commit

1. Look for a hypothesis page that has the same `mechanism` and `to_domain`. List `wiki/hypotheses/`. If one exists, tell the user. Offer `/wiki-fuse --update <hypothesis>`. Stop unless the user wants a second page.
2. Pick the file name as `schema.md` says. The file is `wiki/hypotheses/<slug>.md`.
3. Write the page as `schema/page-types/hypothesis.md` says. Use these values:
   - `mechanism`: the bare slug in a reading wiki. `reading:<slug>` in a work wiki.
   - `heptabase_whiteboard`: `boardId` from Step 1. Leave the field out in the modes that have no whiteboard.
   - `status`: `draft`.
   - `related`: the slugs of the pages of this wiki that you cite.
   - `sources`: the file names in the `sources` of the cited pages, each name once.
   - `created` and `updated`: today.
4. In a work wiki, write the mechanism name as plain text. Do not link the mechanism page. `fuse check` fails on a link to it.
5. Write the section headings of the output language. Write short sentences, as `schema/writing-rules.md` says.
6. Go through the Checklist at the end of `schema/page-types/hypothesis.md`. Fix each item that fails.
7. Run `fuse check`. Fix the page and run it again until it passes. Show the warnings to the user. Fix a link that is no page of this wiki when you can.
8. In a reading wiki, add the slug of the new page to the `related` list in the frontmatter of the mechanism page. The rule file of the mechanism page allows this. Set `updated` of that page to today. Change nothing else in it. A work wiki never does this.
9. Run `fuse commit` with the title of the hypothesis. Give `--file` for the hypothesis page. In a reading wiki, give `--file` for the mechanism page too.
10. Read the JSON. Keep `sha`. Tell the user the page path and the `sha`.

## Step 8: Make the card

The Down steps of `wiki-sync` make the card, add the mirror tag, and place the card on the whiteboard.
Read the section "Down" of `<base>/../wiki-sync/SKILL.md`. Do not copy its steps. Use its plan and its rules.

1. Follow "Before you start" of `wiki-sync` for the target wiki. The direction is Down. If `heptabase.yaml` does not exist, stop this step. Tell the user to run `/wiki-sync` once to set up Heptabase. Go on with Step 9.
2. Run the plan as the Down steps 1 to 4 say.
3. Keep only the actions whose `page` is a file that the fuse commit wrote. These are the hypothesis page and, in a reading wiki, the mechanism page.
4. Count the other actions. Do not run them. They wait for `/wiki-sync`.
5. Show the problems that name your pages, and the problems that name `wiki/`. If a problem asks for a select option, tell the user which option to add in which property. The card is made when the option exists.
6. Show the counts of your actions to the user. Wait for a yes.
7. Run each of your actions as the Down sections of `wiki-sync` say. Run `record` after each action.
8. After the last action, go back to step 2 of Down. Call `read_database` and `list_cards` for the mirror tag again, then run the plan again. The `place` action for the hypothesis page appears only after its card exists. It puts the card on the board that `heptabase_whiteboard` names.
9. Repeat until your pages have no action, or only cards that failed in this run are left. Stop after four rounds.
10. Follow "When a call fails" for every failed call. A card that failed in this run is not tried again in this run.
11. Tell the user how many other actions wait for `/wiki-sync`.

## Step 9: Add the review items

Do this step also when Step 8 stopped.

1. Read the table under "What to verify" in the page that you committed.
2. If the app does not run, skip this step. Tell the user to open the app. The page lists the rows.
3. For each row, call `llm_wiki_add_review` with the arguments below. Save each result as `llm_wiki_add_review-<slug>-<n>.json`.

```json
{
  "project_id": "<project folder>",
  "type": "suggestion",
  "title": "Verify (<hypothesis slug>): <claim, short>",
  "description": "Claim: <claim>. Evidence needed: <evidence needed>. How to refute: <how to refute>.",
  "affectedPages": ["wiki/hypotheses/<slug>.md"],
  "searchQueries": ["<query 1>", "<query 2>", "<query 3>"]
}
```

4. The hypothesis slug is the file name of the page without `.md`. Keep the claim in the title short. Give each row its own title. The id of the item comes from the type and the title.
5. Write two or three search queries for each row. A web search must be able to answer them. Use the "Search keywords" section as a base.
6. Adding the same item again merges into the first one. A repeated call is safe.
7. If a call fails, show the message to the user. Skip the rest of this step. Tell the user that the page lists the rows.
8. Tell the user that each item has search queries. The user can start deep research for an item in the app.
