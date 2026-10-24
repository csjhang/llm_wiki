---
name: wiki-sync
description: Use this skill to sync the wiki with Heptabase. Up saves Heptabase cards as source files in raw/sources/heptabase/. Down writes wiki pages as mirror cards in Heptabase. It needs the Heptabase MCP.
---

# wiki-sync

## Purpose

Use this skill to keep a wiki project and a Heptabase space in step.
The skill has two directions.

- Up (Heptabase to wiki): save the Heptabase cards that belong to the wiki as source files in `raw/sources/heptabase/`. The app ingests these files.
- Down (wiki to Heptabase): write wiki pages as mirror cards in Heptabase. A mirror card is a card that has the mirror tag. The skill also sets its properties.

The tool `wiki-tool` plans each direction. It also keeps the card map `heptabase-map.json`.
The tool never calls Heptabase.
You call the Heptabase MCP and run the plan. Then you tell the tool what you did.
Every step follows the same pattern: plan, run, record.

## Requirements

- Node 20 or later.
- The Heptabase plugin. It gives the Heptabase MCP tools.
- A project folder that has `wiki.yaml`.
- The `llm_wiki` MCP is optional. The skill uses its tool `llm_wiki_status` when it is there.

## Paths

Every command works on the project folder (the folder that contains `wiki/` and `raw/`).
The base directory of this skill is the folder that contains this `SKILL.md` file.
The plugin directory, `<plugin dir>`, is two folders above the base directory.
The tool is `<plugin dir>/scripts/wiki-tool.mjs`.
From the base directory, the path is `<base>/../../scripts/wiki-tool.mjs`.
`reference/mcp-steps.md` lists the exact arguments and the file name for each MCP call. Read it before the first MCP call.

## Command lines

Every command has this form:

```
node "<plugin dir>/scripts/wiki-tool.mjs" hepta <command> --project "<project>" ...
```

- `<command>` is `init`, `plan-down`, `plan-up`, `snapshot`, or `record`.
- The command prints one JSON object on one line.
- Exit code 0 means ok.
- Exit code 2 is a handled problem. The JSON has `"ok": false` and a list `problems`. Show every problem to the user as it is. Then stop that step.
- Exit code 1 is an unexpected error. Show the message to the user. Stop.
- Put a path in double quotes. Put a title or a JSON text in single quotes. A single quote inside the text is written `'\''`.
- A list option is given once for each file. Example: `--cards "<file 1>" --cards "<file 2>"`.
- Never edit `heptabase-map.json` or `heptabase.yaml` by hand. Only the tool changes the map.

## MCP results

- Save every raw MCP result as a file in `<project>/.llm-wiki/hepta/`. Create the folder first. The folder is git-ignored. Never commit it.
- Pass the file to the tool. Never paste MCP output into a command line.
- If Claude Code saved a long result to a file, copy that file with `cp`. Do not type it again.
- Check the `status` of every result before you use it. Only `succeeded` is a good result.
- A failed result reads like an empty list. Never give a failed result to a command.
- If a result says `clientTaskFailed`, call the same tool again once with `"runOn": {"type": "server"}`. The server can miss edits that the user made a moment ago. Tell the user when you use it.
- If the second call fails, or the status is anything else, stop that step. Show the message to the user.
- A list result can have more pages. Its last line is `More cards are available. Showing a-b of N.` Call the tool again with the `offset` that the line gives. Save every page. Pass every page to the command.
- Never pass only some pages of a list.

## Before you start

1. Find the project folder. Use the current folder if it contains `wiki/` and `raw/`. Otherwise ask the user for the path.
2. Create the folder `<project>/.llm-wiki/hepta/` with `mkdir -p`.
3. Check that `<project>/heptabase.yaml` exists. If it does not, do the section "Set up Heptabase" first.
4. Call the `llm_wiki_status` tool of the `llm_wiki` MCP. It tells you if the app is running and which project is open.
5. If the tool is missing or the call fails, tell the user that the app is not running. If another project is open, tell the user that too. Go on: the skill can work without the app.
6. Tell the user this: the Up direction writes the snapshot files only. The app ingests new snapshots from `raw/sources/` itself. Ingest waits until the app runs. The Down direction does not need the app.
7. Ask the user which direction to run. If the user wants both, run Up first, then Down.
8. Each direction starts with a plan. Show the plan to the user as counts per action. Wait for a yes before the first write.
9. Live Heptabase calls are real writes. A `create`, an `update`, a `retire`, and a `place` change the space of the user. Do not run them without the yes.

## Set up Heptabase

Use this section when `heptabase.yaml` does not exist.

1. Ask the user for the names of two tags. The ingest tag marks the cards that belong to the wiki. The mirror tag holds the mirror cards.
2. Call `list_tags` to find the id of each tag. Ask the user to confirm the two ids.
3. Call `read_database` for the mirror tag. Save the result.
4. Call `list_whiteboards`. Save every page.
5. Show the whiteboard tree to the user. To look inside a whiteboard, call `read_whiteboard` in `structure` mode.
6. Ask which whiteboards are roots. The cards under a root belong to this wiki. At least one root is needed.
7. Ask which whiteboards are source boards, and which are archive boards. Both are optional. An archive board is never synced.
8. Run the init command:

```
node "<plugin dir>/scripts/wiki-tool.mjs" hepta init --project "<project>" --database "<database file>" --whiteboards "<page 1 file>" --whiteboards "<page 2 file>" --ingest-tag <ingest tag id> --mirror-tag <mirror tag id> --root <root id> --source-board <board id> --archive-board <board id>
```

9. Give `--root`, `--source-board`, and `--archive-board` once for each whiteboard. Leave out `--source-board` or `--archive-board` when there is none.
10. Init checks the property names and types of the database. If it reports a missing property, tell the user to add it in Heptabase. The MCP cannot add a property. Then run steps 3 and 8 again.
11. Do not pass `--force` unless the user asks to replace an existing `heptabase.yaml`.
12. Show `warnings` to the user. Tell the user that `heptabase.yaml` and `heptabase-map.json` are written.
13. Tell the user that a source board does not ingest by itself. The user can set `auto_ingest: true` for it in `heptabase.yaml`.

## Up (Heptabase to wiki)

Up never writes to Heptabase. It writes snapshot files and the card map.

1. Read `heptabase.yaml`. Note the ingest tag, the roots, and each whiteboard that has `auto_ingest: true`.
2. Call `list_whiteboards`. Save every page.
3. Call `list_cards` for the ingest tag. Save every page.
4. If a whiteboard has `auto_ingest: true`, call `list_cards` for these whiteboards too. Save every page.
5. Run the plan:

```
node "<plugin dir>/scripts/wiki-tool.mjs" hepta plan-up --project "<project>" --cards "<cards file 1>" --cards "<cards file 2>" --whiteboards "<whiteboards file 1>" --whiteboards "<whiteboards file 2>"
```

6. Read the JSON. It has `actions`, `skipped`, and `warnings`. Show the `warnings` and the counts in `skipped` to the user.
7. Show the counts per action (`snapshot`, `ask`, `download-pdf`). Wait for a yes.
8. Handle each `ask` action as the section "ask" says. Do the `ask` actions first.
9. If you recorded an answer, run the plan command again with the same files. Use the new list of actions.
10. Handle each `snapshot` action and each `download-pdf` action as the sections below say.
11. Tell the user where the snapshots are: `raw/sources/heptabase/`. Remind the user that ingest waits for the app.

### ask

1. Name the card to the user. Say why you ask: the card is under two roots (`two-roots`), or under no root (`no-root`).
2. Offer the roots of `heptabase.yaml` by title. Offer `skip` too. The titles are in the whiteboard list you saved.
3. Run `record` with the answer:

```
node "<plugin dir>/scripts/wiki-tool.mjs" hepta record --project "<project>" --event '{"type":"up-decision","cardId":"<card id>","decision":"skip"}'
```

4. For a root, write the root id in `decision` instead of `skip`.
5. The tool remembers the answer. It does not ask again about this card.

### snapshot

1. Call `read_object`. Use `cardType` of the action as `objectType`, and `cardId` as `objectId`. Save the page.
2. If the result has `hasMore: true`, call `read_object` again. Use the last line number you have as `offset`. Save each page.
3. Read until you have all `totalLines` lines. The line numbers must run from 1 to `totalLines` with no gap.
4. If lines are missing, read the missing range again before step 6. Save it as one more page.
5. Find the line of the card in the `list_cards` file you saved. Copy the time after `updated:`.
6. Run the snapshot command. Give one `--content` for each page file, in page order:

```
node "<plugin dir>/scripts/wiki-tool.mjs" hepta snapshot --project "<project>" --card-id <card id> --title '<title>' --card-type <card type> --whiteboards '[{"id":"<whiteboard id>","title":"<whiteboard title>"}]' --updated-at <updated time> --content "<page 1 file>" --content "<page 2 file>"
```

7. Copy `title`, `cardType`, and `whiteboards` from the action. The `--whiteboards` JSON is the `whiteboards` list of the action.
8. For a web card, add `--url '<url>'` when `read_object` shows the address of the page.
9. Read the JSON. Keep `written`, `source_kind`, `domain`, and `warnings` for the report.

### download-pdf

1. Call `read_object` with `objectType` `pdfCard`. Save the result. Find the file id in it.
2. Call `get_file_download_url` with the file id. Save the result.
3. Tell the user where the PDF is: the card title and the download address. Say that the address works for a short time only.
4. Tell the user to save the PDF in `raw/sources/`. The app reads PDF files from there.
5. Do not run `snapshot` for a PDF card.
6. Add the card to the report. The plan lists a PDF card again on each run.

## Down (wiki to Heptabase)

1. Read `heptabase.yaml`. Note the mirror tag.
2. Call `read_database` for the mirror tag. Save the result. It holds the select options that exist now.
3. Call `list_cards` for the mirror tag. Save every page.
4. Run the plan:

```
node "<plugin dir>/scripts/wiki-tool.mjs" hepta plan-down --project "<project>" --database "<database file>" --mirror-cards "<cards file 1>" --mirror-cards "<cards file 2>"
```

5. Read the JSON. It has `pass`, `actions`, and `problems`.
6. Show every problem to the user as it is. Each problem names a page.
7. If a problem says to add an option, tell the user which option to add in which property of the mirror tag. The MCP cannot add an option. Go on with the other cards.
8. If a problem says `refusing to retire`, tell the user to check the `wiki/` folder. The plan retires no card in that case. Do not retire a card by hand.
9. Show the counts per action (`create`, `update`, `relink`, `retire`, `skip-edited`, `place`). Wait for a yes.
10. Handle the actions in the order of the list. For each action, run its MCP calls. Then run `record` at once, before the next action.
11. When the list is done, go back to step 2. Plan again. Stop when the plan has no action. Stop after four rounds.
12. Pass 2 of the plan gives the `relink` actions. They appear when no `create`, `update`, or `retire` is left.

### Record events

Run `record` for every action that changed Heptabase:

```
node "<plugin dir>/scripts/wiki-tool.mjs" hepta record --project "<project>" --event '<event json>'
```

The events are:

```
{"type":"created","page":"<page>","cardId":"<card id>","cardUpdatedAt":"<time>","contentHash":"<contentHash>"}
{"type":"updated","page":"<page>","cardUpdatedAt":"<time>","contentHash":"<contentHash>"}
{"type":"retired","page":"<page>","cardUpdatedAt":"<time>","contentHash":"<contentHash>"}
{"type":"placed","page":"<page>","whiteboardId":"<whiteboard id>"}
```

- Copy `page` and `contentHash` from the action. Do not compute a hash.
- Use the event `updated` for a `relink` too.
- Get `<time>` after the last write to the card. Call `list_cards` with `cardIds` and read the time after `updated:`.
- If `record` fails, show the problems. Do not run the next action until you fix the cause.

### create

1. Call `create_object` with `objectType` `card` and `content` set to the `body` of the action. The body starts with the title as a heading.
2. Read the new card id from the result.
3. Call `update_database_card_membership` to add the card to the mirror tag.
4. Call `edit_card_properties` with the `properties` of the action. Add `cardId` to each edit. Keep `propertyId`, `type`, and `value` as they are.
5. Get the card time. Run `record` with a `created` event.
6. If a call after `create_object` fails, call it once more. If it fails again, stop for this page. Tell the user the card id and the page. Do not call `create_object` again for this page.

### update and relink

1. Read the card with `read_object`, all pages, as the snapshot steps say.
2. Build the old text. It is the content lines without the line numbers. Leave out the header line and the `--- Databases ---` block.
3. Call `edit_object_content` with one edit. `oldString` is the old text. `newString` is the `body` of the action.
4. Copy a protected placeholder, media, or table region into `oldString` exactly as it is.
5. If the tool refuses the edit, stop for this card. Show the message to the user. Do not run `record`.
6. For an `update`, call `edit_card_properties` with the `properties` of the action. A `relink` has no properties.
7. Get the card time. Run `record` with an `updated` event.

### retire

1. Read the card as in an update.
2. Call `edit_object_content` with one edit. `oldString` is the old text. `newString` is `# ` and the `title` of the action, an empty line, and the `body` of the action.
3. Call `edit_card_properties` with the `properties` of the action.
4. Get the card time. Run `record` with a `retired` event.
5. Never delete the card. The MCP cannot delete a card. Add the card to the list of retired cards for the report.

### skip-edited

The user edited this mirror card after the last sync. Never overwrite it.

1. Call `read_object` for the card, all pages. Save each page.
2. Write the text of the card, without line numbers, to `<project>/.llm-wiki/hepta/feedback-<card id>.txt`.
3. Build the event file. The text is long, so let node write the JSON:

```
node -e 'process.stdout.write(JSON.stringify({type:"feedback",page:process.argv[1],cardId:process.argv[2],cardUpdatedAt:process.argv[3],content:require("fs").readFileSync(process.argv[4],"utf8")}))' '<page>' '<card id>' '<cardUpdatedAt>' '<project>/.llm-wiki/hepta/feedback-<card id>.txt' > '<project>/.llm-wiki/hepta/event-feedback-<card id>.json'
```

4. Use the `cardUpdatedAt` of the action. Never use a newer time from a new `list_cards` call.
5. Run `record` with the text of the event file:

```
node "<plugin dir>/scripts/wiki-tool.mjs" hepta record --project "<project>" --event "$(cat '<project>/.llm-wiki/hepta/event-feedback-<card id>.json')"
```

6. The tool saves the text as a note in `raw/sources/heptabase/`. The app ingests it as a view of the user.
7. Check if the `llm_wiki` MCP has a tool named `llm_wiki_add_review`. If it has, call it to add a review item of type `mirror-edited` for the page. If it has not, go on. Do not fail.
8. Add the card to the list of edited cards for the report.

### place

1. Call `place_whiteboard_objects` for the `whiteboardId` and the `cardId` of the action. Use `objectType` `card` and the destination `auto`.
2. Run `record` with a `placed` event.
3. A repeated call puts the card on the whiteboard twice. Before you call again after a failure, call `read_whiteboard` in `structure` mode. Call again only if the card is not there.
4. Place a mirror card on a whiteboard only for a `place` action.

## Rules

- Run `record` after every action that changed Heptabase. Run it before the next action. A run that stops halfway then continues from the map.
- Edit only a card that is in the card map. All cards in the actions are. Never edit a card from a list result that is not in an action.
- A card of the user is read-only. This includes a card in the mirror tag that the map does not name.
- Never delete a card. The MCP cannot. List a retired card for the user to delete by hand.
- Never place a mirror card on a whiteboard, except for a `place` action.
- Copy `contentHash` from the action into the `created`, `updated`, and `retired` event.
- For a `skip-edited` action, use the `cardUpdatedAt` of the action in the `feedback` event.
- If a select option is missing, stop that card. Tell the user which option to add in which property. Go on with the other cards.
- Ask the user about every `ask` action. Do not guess a root.
- Check the `status` of every MCP result. On `clientTaskFailed`, retry once with `"runOn": {"type": "server"}`.

## Report

At the end, give the user a short report.

- The direction that ran.
- The counts per action: created, updated, relinked, retired, placed, skipped because edited, snapshots, questions asked, PDF cards.
- The problems, as the tool printed them. Include a missing option, and the name of the property.
- The edited cards: the title, the card id, and the wiki page of each. Say that the skill did not overwrite them, and that the text is saved as a note.
- The retired cards: the title and the card id of each. Tell the user to delete these cards by hand.
- The new snapshot files. Say that ingest waits until the app runs.
- The PDF cards that the user must save by hand.
