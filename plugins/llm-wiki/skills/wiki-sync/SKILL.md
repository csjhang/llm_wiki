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
- The `llm_wiki` MCP is optional. The skill uses its tools `llm_wiki_status`, `llm_wiki_rescan_sources`, and `llm_wiki_add_review` when they are there.

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
- Never discard, revert, or reset `heptabase-map.json`. It maps wiki pages to Heptabase cards, and nothing can rebuild it.

## MCP results

- Save every raw MCP result as a file in `<project>/.llm-wiki/hepta/`. Create the folder first. The folder is git-ignored. Never commit it.
- Pass the file to the tool. Never paste MCP output into a command line.
- If Claude Code saved a long result to a file, copy that file with `cp`. Do not type it again.
- Check the `status` of every result before you use it. Only `succeeded` is a good result.
- A failed result reads like an empty list. Never give a failed result to a command.
- A list result can have more pages. Its last line is `More cards are available. Showing a-b of N.` Call the tool again with the `offset` that the line gives. Save every page. Pass every page to the command.
- Never pass only some pages of a list.
- Send the text of a body file as it is. Never retype a body.

## When a call fails

This section is the one rule for a failed call. Other sections point to it.

1. Read the status of the result. Only `succeeded` is good.
2. For a read call or a list call, if the status is `clientTaskFailed`, call the same tool again once with `"runOn": {"type": "server"}`. The server can miss edits that the user made a moment ago. Tell the user when you use it.
3. For `edit_object_content`, `edit_card_properties`, and `update_database_card_membership`, call the tool again once with the same arguments. Then stop if it fails again.
4. Never call `create_object` again, and never call `place_whiteboard_objects` again, after any failure. The first call may have worked.
5. After a failed `create_object`, look for the new card. Call `list_cards` with `hasNoTags` true, `createdAfter` set to the time before the call, and `include` with `timestamps`. If a card has the title of the action, it is the new card. Go on from `record created`. If no card has that title, ask the user before you try again.
6. After a failed `place_whiteboard_objects`, call `read_whiteboard` in `structure` mode. If the card is there, run `record placed`. If it is not, ask the user before you try again.
7. If a step fails and these rules do not fix it, stop that card. Show the message to the user. Do not run `record` for the step that failed.
8. A card that failed in this run is not tried again in this run. Leave it out of the next rounds.

## Before you start

If the command has the argument `--yes`, read the section "Run without questions" before step 1. It changes steps 1, 3, 7, 8, and 9.

1. Find the project folder. Use the current folder if it contains `wiki/` and `raw/`. Otherwise ask the user for the path.
2. Create the folder `<project>/.llm-wiki/hepta/` with `mkdir -p`.
3. Check that `<project>/heptabase.yaml` exists. If it does not, do the section "Set up Heptabase" first.
4. Call the `llm_wiki_status` tool of the `llm_wiki` MCP. It tells you if the app is running and which project is open.
5. If the tool is missing or the call fails, tell the user that the app is not running. If another project is open, tell the user that too. Go on: the skill can work without the app.
6. Tell the user this: the Up direction writes the snapshot files only. The app ingests new snapshots from `raw/sources/` itself. Ingest waits until the app runs. The Down direction does not need the app.
7. Ask the user which direction to run. If the user wants both, run Up first, then Down.
8. Each direction starts with a plan. Show the plan to the user as counts per action. Wait for a yes before the first write.
9. Live Heptabase calls are real writes. A `create`, a `setup`, an `update`, a `relink`, a `retire`, and a `place` change the space of the user. Do not run them without the yes.

## Run without questions

Use this section when the command has the argument `--yes`. The panel of the app runs `/wiki-sync --yes` in the background.
Nobody is there to answer. A question would stop the run for good.
A command with no `--yes` ignores this section.
The steps below replace steps 1, 3, 7, 8, and 9 of "Before you start". Do the other steps of that section.

1. The press of the button is the yes for the plans. Do not wait for another yes.
2. Run Up, then Down. Do not ask which direction.
3. Never ask the user a question. Do not wait for an answer.
4. Use the current folder as the project folder. If it has no `wiki/` and no `raw/`, stop and say so.
5. If `heptabase.yaml` does not exist, stop. Do not do the section "Set up Heptabase". Tell the user to run `/wiki-sync` once in a conversation.
6. Follow "Up (Heptabase to wiki)" and "Down (wiki to Heptabase)" for the rest. Skip each step that asks the user.
7. Leave out each step that needs a choice. Go on with the other steps.
8. Put each left-out step, and each message for the user, in the report at the end.

These steps need a choice:

- An `ask` action of the Up plan (`two-wikis` or `no-root`). Leave the card out. Do not run `record` for it. The next plan gives the action again.
- A select option that is missing in the mirror tag. Leave out the card, as step 7 of Down says. Name the property and the option in the report.
- A problem that says `refusing to retire`. Retire no card. Never pass `--allow-mass-retire` in this mode. Put the count and the reason in the report.
- A failed `create_object` call, for example with the status `clientTaskFailed`. Follow "When a call fails", but do not ask the user. Never call `create_object` again. If the new card is found, go on from `record created`. If it is not found, leave out the card. Put the card, the page, and the message in the report.
- A failed `place_whiteboard_objects` call. Follow "When a call fails", but do not ask the user. Never call `place_whiteboard_objects` again. If the card is not on the whiteboard, leave out the place action. Put the card and the whiteboard in the report.
- Any other step where "When a call fails" says to ask the user. Do not ask the user before a new try. Leave out the card and put it in the report.

## Set up Heptabase

Use this section when `heptabase.yaml` does not exist.

1. Ask the user for the names of two tags. The ingest tag marks the cards that belong to the wiki. The mirror tag holds the mirror cards. The two tags must differ.
2. Call `list_tags` to find the id of each tag. Ask the user to confirm the two ids.
3. Call `read_database` for the mirror tag. Save the result.
4. Call `list_whiteboards`. Save every page.
5. Show the whiteboard tree to the user. To look inside a whiteboard, call `read_whiteboard` in `structure` mode.
6. Ask which whiteboards are roots. The cards under a root belong to this wiki. At least one root is needed.
7. Ask if another wiki uses the same Heptabase space. If it does, ask which whiteboards are the roots of that wiki. Cards under those roots are not sources of this wiki.
8. Ask which whiteboards are source boards, and which are archive boards. Both are optional. An archive board is never synced.
9. Run the init command:

```
node "<plugin dir>/scripts/wiki-tool.mjs" hepta init --project "<project>" --database "<database file>" --whiteboards "<page 1 file>" --whiteboards "<page 2 file>" --ingest-tag <ingest tag id> --mirror-tag <mirror tag id> --root <root id> --other-root <other root id> --source-board <board id> --archive-board <board id>
```

10. Give `--root`, `--other-root`, `--source-board`, and `--archive-board` once for each whiteboard. Leave out an option when there is none.
11. Init checks the property names and types of the database. If it reports a missing property, tell the user to add it in Heptabase. The MCP cannot add a property. Then run steps 3 and 9 again.
12. Do not pass `--force` unless the user asks to replace an existing `heptabase.yaml`.
13. Show `warnings` to the user. Tell the user that `heptabase.yaml` is written. The map `heptabase-map.json` is written when the whiteboard list is complete.
14. Tell the user that a source board does not ingest by itself. The user can set `auto_ingest: true` for it in `heptabase.yaml`.

## Up (Heptabase to wiki)

Up never writes to Heptabase. It writes snapshot files and the card map.

1. Read `heptabase.yaml`. Note the ingest tag, the roots, and each whiteboard that has `auto_ingest: true`.
2. Call `list_whiteboards` with `depth` 10. Save every page.
3. Call `list_cards` for the ingest tag. Save every page.
4. If a whiteboard has `auto_ingest: true`, call `list_cards` for these whiteboards too. Save every page.
5. Run the plan:

```
node "<plugin dir>/scripts/wiki-tool.mjs" hepta plan-up --project "<project>" --cards "<cards file 1>" --cards "<cards file 2>" --whiteboards "<whiteboards file 1>" --whiteboards "<whiteboards file 2>"
```

6. Read the JSON. It has `actions`, `skipped`, and `warnings`. Show the `warnings` and the counts in `skipped` to the user.
7. If a warning says that the whiteboard list is cut off, call `list_whiteboards` again with a larger `depth`. Then run the plan again.
8. Show the counts per action (`snapshot`, `ask`, `download-pdf`). Wait for a yes.
9. Handle each `ask` action as the section "ask" says. Do the `ask` actions first.
10. If you recorded an answer, run the plan command again with the same files. Use the new list of actions.
11. Handle each `snapshot` action and each `download-pdf` action as the sections below say.
12. Tell the user where the snapshots are: `raw/sources/heptabase/`.
13. If `llm_wiki_status` said that the app runs, call `llm_wiki_rescan_sources` with `project_id` set to the project folder. Tell the user that the source watch of the app must be on, or the app does not see the new files.
14. If the app does not run, remind the user that ingest waits for the app.

The `skipped` counts mean this:

- `mirror` and `mirror-tag`: a mirror card. It is never a source.
- `other-wiki`: the card is only under the roots of another wiki.
- `archived`: the card is on an archive board.
- `unchanged`: the snapshot is up to date.
- `declined`: the user chose `skip` before.

### ask

1. Name the card to the user. Say why you ask: the card is under a root of this wiki and a root of another wiki (`two-wikis`), or under no root (`no-root`).
2. Offer two answers. `this-wiki` makes the card a source of this wiki. `skip` leaves it out.
3. Run `record` with the answer:

```
node "<plugin dir>/scripts/wiki-tool.mjs" hepta record --project "<project>" --event '{"type":"up-decision","cardId":"<card id>","decision":"skip"}'
```

4. For the first answer, write `this-wiki` in `decision` instead of `skip`.
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
3. Call `list_cards` for the mirror tag. Save every page. The plan needs the whole list and refuses a list that stops early.
4. Run the plan:

```
node "<plugin dir>/scripts/wiki-tool.mjs" hepta plan-down --project "<project>" --database "<database file>" --mirror-cards "<cards file 1>" --mirror-cards "<cards file 2>"
```

5. Read the JSON. It has `pass`, `actions`, and `problems`. It has `notes` when there is a note. The plan writes the text of each card to a body file named in `bodyFile`.
6. Show every problem and every note to the user as it is. Each problem names a page.
7. If a problem says to add an option, tell the user which option to add in which property of the mirror tag. The MCP cannot add an option. Go on with the other cards.
8. If a problem says `refusing to retire`, the plan retires no card. Do not retire a card by hand. Show the user the count and the reason. The `wiki/` folder may be unreadable, or the user may have removed many pages. Tell the user to check the `wiki/` folder. Ask the user if these cards must be retired. Only after a yes, run the plan again with `--allow-mass-retire` added to the command. Use the flag on this plan only. If a later plan of this run refuses again, ask the user again. If the user says no, go on without the retires.
9. If a problem says that a card is not in the mirror tag, tell the user. The plan does nothing for that page. Do not create, update, or retire the card by hand.
10. Show the counts per action (`create`, `setup`, `update`, `relink`, `retire`, `skip-edited`, `place`, `forget`). Wait for a yes.
11. Handle the actions in the order of the list. For each action, run its MCP calls. Then run `record` at once, before the next action. A `forget` action has no MCP call. Run `record` with a `forgotten` event for it.
12. When the list is done, go back to step 2. Plan again. Stop when the plan has no action, or when only cards that failed in this run are left. Stop after four rounds.
13. Pass 2 of the plan gives the `relink` actions. They appear when no `create`, `update`, or `retire` is left.

### Record events

Run `record` for every action that changed Heptabase:

```
node "<plugin dir>/scripts/wiki-tool.mjs" hepta record --project "<project>" --event '<event json>'
```

The events are:

```
{"type":"created","page":"<page>","cardId":"<card id>","setup":false,"contentHash":"<contentHash>"}
{"type":"setup-done","page":"<page>","cardUpdatedAt":"<time>"}
{"type":"updated","page":"<page>","cardUpdatedAt":"<time>","contentHash":"<contentHash>"}
{"type":"relinked","page":"<page>","cardUpdatedAt":"<time>","contentHash":"<contentHash>"}
{"type":"retired","page":"<page>","cardUpdatedAt":"<time>"}
{"type":"forgotten","page":"<page>"}
{"type":"placed","page":"<page>","whiteboardId":"<whiteboard id>"}
```

- Copy `page` and `contentHash` from the action. Do not compute a hash.
- Use the event `relinked` for a `relink` action.
- Every event except `created`, `placed`, and `forgotten` needs `cardUpdatedAt`. See "Get the card time".
- The tool finds the body file of the page itself. Do not name it.
- If `record` fails, show the problems. Do not run the next action until you fix the cause.

### Get the card time

1. Call `list_cards` with `cardIds` set to the card id and `include` with `timestamps`.
2. Do this after the last write to the card.
3. Read the time after `updated:`. This is `cardUpdatedAt` for the event.

### Check the card before a write

Do this check right before `edit_object_content` and right before `place_whiteboard_objects`.

1. Call `list_cards` with `cardIds` set to the card id and `include` with `timestamps`.
2. Read the time after `updated:`.
3. Take the time to compare. It is `cardUpdatedAt` of the action. If you wrote to this card earlier in this run, take the time you got after that write.
4. If the time on the card is later, the user edited the card after the plan. Stop that card. Do not write.
5. Handle that card as a `skip-edited` action in this run. Use the time on the card as `cardUpdatedAt`.
6. If the time is not later, go on with the write.

### create

1. Read the file named in `bodyFile`. Call `create_object` with `objectType` `card` and `content` set to the text of the file.
2. Read the new card id from the result. The id must be a lowercase UUID.
3. Search `heptabase-map.json` for the id. If the id is in the map, stop. Tell the user. Do not go on.
4. Run `record` with a `created` event and `"setup": false` at once. Do not wait for another call.
5. Call `update_database_card_membership` to add the card to the mirror tag.
6. Call `edit_card_properties` with the `properties` of the action. Add `cardId` to each edit. Keep `propertyId`, `type`, and `value` as they are.
7. Call `list_cards` for the new card as in "Get the card time". The title must equal the `title` of the action. If it does not, stop and tell the user.
8. Run `record` with a `setup-done` event.
9. If a step after step 4 fails, follow "When a call fails". Then stop for this card. Tell the user the card id and the page. The next plan gives a `setup` action for it.
10. Never call `create_object` again for this page.

### setup

The card exists, but its tag and properties are not set.

1. Call `update_database_card_membership` to add the card to the mirror tag.
2. Call `edit_card_properties` with the `properties` of the action. Add `cardId` to each edit. If `properties` is empty, skip this call.
3. Call `list_cards` for the card as in "Get the card time". The title must equal the `title` of the action. If it does not, stop and tell the user.
4. Run `record` with a `setup-done` event.
5. If a step fails, follow "When a call fails". Then stop for this card. The next plan gives the `setup` action again.

### update and relink

1. Read the card with `read_object`, all pages, as the snapshot steps say.
2. Build the old text. It is the content lines without the line numbers. Leave out the header line and the `--- Databases ---` block.
3. Do "Check the card before a write".
4. Read the file named in `bodyFile`. Call `edit_object_content` with one edit. `oldString` is the old text. `newString` is the text of the file.
5. Copy a protected placeholder, media, or table region into `oldString` exactly as it is.
6. If the tool refuses the edit, stop for this card. Show the message to the user. Do not run `record`.
7. For an `update`, call `edit_card_properties` with the `properties` of the action. A `relink` has no properties.
8. Get the card time. Run `record` with an `updated` event for an `update`, or a `relinked` event for a `relink`.
9. The user can choose "Discard the edit" on a `mirror-edited` item in the app. The plan then gives a normal `update` for that page, also when the page did not change. Handle it like any `update`. The `updated` event takes the page out of the list. A newer edit still gets a `skip-edited` action.

### retire

1. Read the card as in an update.
2. Do "Check the card before a write".
3. Read the file named in `bodyFile`. It holds the title as a heading, an empty line, and the body. Call `edit_object_content` with one edit. `oldString` is the old text. `newString` is the text of the file.
4. Call `edit_card_properties` with the `properties` of the action.
5. Get the card time. Run `record` with a `retired` event.
6. Never delete the card. The MCP cannot delete a card. Add the card to the list of retired cards for the report.

### skip-edited

The user edited this mirror card after the last sync. Never overwrite it.

1. Call `read_object` for the card, all pages. Save each page.
2. Run `record` with a `feedback` event. Give one `--content` for each page file, in page order:

```
node "<plugin dir>/scripts/wiki-tool.mjs" hepta record --project "<project>" --event '{"type":"feedback","page":"<page>","cardId":"<card id>","cardUpdatedAt":"<time>"}' --content "<page 1 file>" --content "<page 2 file>"
```

3. Use the `cardUpdatedAt` of the action. Never use a newer time from a new `list_cards` call. If "Check the card before a write" sent you here, use the time on the card from that check.
4. Read the JSON. The tool compares the card with the text the wiki sent.
5. If `note` is a path, the tool saved the lines that the user added and removed as a note in `raw/sources/heptabase/`. The app ingests it as a view of the user.
6. If `note` is `null`, the card is the same as the text the wiki sent. Nothing is saved. Add the card to the report as checked.
7. If `note` is a path and `llm_wiki_status` said that the app runs, call `llm_wiki_add_review` with `project_id` set to the project folder. Use the arguments in `reference/mcp-steps.md`. It adds a review item of type `mirror-edited` for the page. Each edit adds its own item.
8. If the app does not run, or the call fails, skip step 7. Do not fail. Say so in the report. The note is the record.
9. Add the card to the list of edited cards for the report.

### place

1. Do "Check the card before a write".
2. Call `read_whiteboard` in `structure` mode for the `whiteboardId`. If the card is there, do not place it again. Run `record` with a `placed` event.
3. If the card is not there, call `place_whiteboard_objects` for the `whiteboardId` and the `cardId` of the action. Use `objectType` `card` and the destination `auto`.
4. Run `record` with a `placed` event.
5. If the call fails, follow "When a call fails". A repeated call puts the card on the whiteboard twice.
6. Place a mirror card on a whiteboard only for a `place` action.

## Rules

- Run `record` after every action that changed Heptabase. Run it before the next action. A run that stops halfway then continues from the map.
- Edit only a card that is in the card map. All cards in the actions are. Never edit a card from a list result that is not in an action.
- A card of the user is read-only. This includes a card in the mirror tag that the map does not name.
- Never delete a card. The MCP cannot. List a retired card for the user to delete by hand.
- Never place a mirror card on a whiteboard, except for a `place` action.
- Copy `contentHash` from the action into the `created`, `updated`, and `relinked` event.
- For a `skip-edited` action, use the `cardUpdatedAt` of the action in the `feedback` event.
- If a select option is missing, stop that card. Tell the user which option to add in which property. Go on with the other cards.
- Ask the user about every `ask` action, except in a run without questions. Do not guess.
- Follow "When a call fails" for every failed call.

## Report

At the end, give the user a short report.

- The direction that ran.
- The counts per action: created, set up, updated, relinked, retired, forgotten, placed, skipped because edited, snapshots, questions asked, PDF cards.
- The counts in `skipped` of Up.
- The problems and warnings, as the tool printed them. Include a missing option, and the name of the property.
- The cards that failed in this run: the title, the card id, and the page of each.
- The edited cards: the title, the card id, and the wiki page of each. Say that the skill did not overwrite them. Say if a note was saved or the card was the same as the text the wiki sent. Say if a review item was added, or why it was not.
- The retired cards: the title and the card id of each. Tell the user to delete these cards by hand. The next plan then gives a `forget` action for each card that is gone.
- The new snapshot files. Say that ingest waits until the app runs, and that the source watch of the app must be on.
- The PDF cards that the user must save by hand.
- In a run without questions: each step that the run left out, and why. See the section "Run without questions".
- Say that `heptabase-map.json` maps wiki pages to Heptabase cards. The user must never discard or revert it.
