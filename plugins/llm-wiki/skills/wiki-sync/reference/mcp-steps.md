# MCP steps of wiki-sync

This file lists every MCP call of the skill `wiki-sync`.
Each section gives the tool, the exact arguments, and the file name of the result.
Read it before the first MCP call.

## Rules for every call

- Save the whole result in `<project>/.llm-wiki/hepta/`. The file holds the JSON object with `content` and `status`.
- `<n>` in a file name is the page number, starting at 1. `<card id>` and `<page slug>` stand for the real values.
- Check `status` first. Only `succeeded` is good.
- If a call fails, follow the section "When a call fails" in `SKILL.md`. It is the one rule for failed calls.
- Every id in this file is a placeholder. Take the real ids from `heptabase.yaml`, from the plan, or from a saved result.
- Never type MCP output into a command line. Pass the saved file.
- Never retype a body. Send the text of the body file as it is.

## list_tags

Use it in "Set up Heptabase", to find the id of a tag.

```json
{ "nameFilter": "<tag name>" }
```

- If the list has more pages, add `offset` and `limit`.
- Save as `list_tags-p<n>.json`.
- Take the id from the line `tag "<tag name>" [<tag id>]`.

## read_database

Use it in "Set up Heptabase" and at the start of each Down round.

```json
{ "tagId": "<mirror tag id>" }
```

- Save as `read_database-mirror.json`.
- Pass the file with `--database` to `init` and to `plan-down`.
- The result holds `configuration.schema`: the properties, their types, and the select options.
- Read it again in each Down round. The user may have added an option.

## list_whiteboards

Use it in "Set up Heptabase" and at the start of Up.

```json
{ "offset": 0, "depth": 10 }
```

- Always set `depth` to 10. The default is 4, and a deeper tree is cut off.
- Do not set `limit`. The default is 20.
- Do not set `parentWhiteboardId`. It lists part of the tree.
- A list that has more pages ends with `More top-level whiteboards are available. Showing a-b of N.`
- Call again with the `offset` that this line gives, and the same `depth`. Do this until a page has no such line.
- Save as `list_whiteboards-p<n>.json`.
- Pass every page with a repeated `--whiteboards` to `init` and to `plan-up`. Never pass one partial page.
- The tool warns when a whiteboard says it holds more whiteboards than the list shows. Then call again with a larger `depth`.

## list_cards

Always send `include` with the three values. The tool needs them to read the whiteboards, the tags, and the times.
Send `limit` 100. Send the sort order shown here. Paging then stays stable when a card changes during the run.
A list that has more pages ends with `More cards are available. Showing a-b of N.`
Call again with the `offset` that this line gives. Save every page.
The text `No cards found.` is a good result for an empty list.

Mirror cards (Down, step 3):

```json
{
  "tagIds": ["<mirror tag id>"],
  "include": ["whiteboards", "tags", "timestamps"],
  "limit": 100,
  "offset": 0,
  "sortBy": "createdTime",
  "sortDirection": "ascending"
}
```

- Save as `list_cards-mirror-p<n>.json`.
- Pass every page with a repeated `--mirror-cards` to `plan-down`.
- The plan refuses a list when the last page still has a next page. It also refuses a result with a status that is not `succeeded`.

Ingest cards (Up, step 3):

```json
{
  "tagIds": ["<ingest tag id>"],
  "include": ["whiteboards", "tags", "timestamps"],
  "limit": 100,
  "offset": 0,
  "sortBy": "createdTime",
  "sortDirection": "ascending"
}
```

- Save as `list_cards-ingest-p<n>.json`.

Cards of the source boards that have `auto_ingest: true` (Up, step 4):

```json
{
  "whiteboardIds": ["<source board id>"],
  "include": ["whiteboards", "tags", "timestamps"],
  "limit": 100,
  "offset": 0,
  "sortBy": "createdTime",
  "sortDirection": "ascending"
}
```

- Save as `list_cards-boards-p<n>.json`.
- Pass every ingest page and every board page with a repeated `--cards` to `plan-up`.

One card, to get its time or to check it (Down):

```json
{
  "cardIds": ["<card id>"],
  "include": ["whiteboards", "tags", "timestamps"]
}
```

- Save as `list_cards-card-<card id>.json`.
- Read the time after `updated:` in the line of the card. This is `cardUpdatedAt`.
- Use it after a write, as "Get the card time" says.
- Use it right before a write, as "Check the card before a write" says.
- Use it to check the title of a new card.

New cards without a tag, to look for a card that `create_object` may have made (Down, "When a call fails"):

```json
{
  "hasNoTags": true,
  "createdAfter": "<time before the create call>",
  "include": ["tags", "timestamps"],
  "limit": 20,
  "sortBy": "createdTime",
  "sortDirection": "descending"
}
```

- Save as `list_cards-new-<page slug>.json`.
- Look for the title of the action. A card with that title and no tag is the new card.

## read_object

Use it to read a card in full: for a snapshot, before an edit, and for a `skip-edited` card.

```json
{
  "objectType": "<card type>",
  "objectId": "<card id>",
  "offset": 0,
  "limit": 500
}
```

- `<card type>` is `cardType` of the `snapshot` action. For a mirror card it is `card`.
- If the tool rejects `limit`, use a smaller number such as 200.
- The result has `totalLines`. It has `hasMore: true` when more lines follow.
- Each content line is the line number, a tab, and the text. The numbers are absolute.
- For the next page, send `offset` with the last line number you have.
- Save as `read_object-<card id>-p<n>.json`.
- Page 1 also has a `--- Databases ---` block. It is not content.
- Check that the line numbers run from 1 to `totalLines` with no gap. Read a missing range again with `offset` and `limit`. Save it as one more page.
- Pass every page with a repeated `--content` to `snapshot`, and to `record` for a `feedback` event. Pass the pages in page order.

A PDF card:

```json
{
  "objectType": "pdfCard",
  "objectId": "<card id>"
}
```

- The result is metadata, not the pages of the file.
- Save as `read_object-<card id>-pdf.json`.
- Find the file id in the result.

## read_whiteboard

Use it to look inside a whiteboard in "Set up Heptabase", and before every `place` action.

```json
{
  "whiteboardId": "<whiteboard id>",
  "mode": "structure"
}
```

- Save as `read_whiteboard-<whiteboard id>.json`.
- The structure lists the cards by title and id. Look for the card id.
- Before a `place` action, a card that is on the whiteboard already must not be placed again.

## create_object

Use it for a `create` action.

```json
{
  "objectType": "card",
  "content": "<text of the body file>"
}
```

- Read the file named in `bodyFile`. Send its text exactly as it is. It is Hepta Markdown and starts with the title as a heading.
- Save as `create_object-<page slug>.json`.
- Read the new card id from the result. Run `record` with a `created` event at once.
- Never call it again after a failure. See "When a call fails" in `SKILL.md`.

## edit_object_content

Use it for an `update`, a `relink`, and a `retire` action.

```json
{
  "objectType": "card",
  "objectId": "<card id>",
  "oldString": "<old text>",
  "newString": "<text of the body file>"
}
```

- Read the card first with `read_object`, all pages.
- Do "Check the card before a write" right before this call.
- The whole body changes, so it is one edit. `oldString` is the whole old text.
- Build the old text from the content lines. Remove only the line number and the tab from each line. Join the lines with line feeds.
- Leave out the header line and the `--- Databases ---` block.
- Copy every protected region byte for byte. These are `hepta-placeholder` tags, media, bookmarks, and complex tables.
- `newString` is the text of the file named in `bodyFile`. For a `retire`, the file holds the title as a heading, an empty line, and the body.
- Do not use `replaceAll`.
- Save as `edit_object_content-<card id>.json`.
- If the tool refuses the edit, stop for this card. Do not run `record`.

## update_database_card_membership

Use it for a `create` action and for a `setup` action, to add the card to the mirror tag.

```json
{
  "tagId": "<mirror tag id>",
  "operation": "add",
  "cardIds": ["<card id>"]
}
```

- Save as `update_database_card_membership-<card id>.json`.
- The tool cannot remove a card from a tag. A repeated add is skipped.

## edit_card_properties

Use it for a `create`, a `setup`, an `update`, and a `retire` action.

```json
{
  "tagId": "<mirror tag id>",
  "edits": [
    { "type": "select", "value": "<option name>", "cardId": "<card id>", "propertyId": "<property id>" },
    { "type": "text", "value": "<text>", "cardId": "<card id>", "propertyId": "<property id>" },
    { "type": "date", "value": { "start": "<date>T00:00:00.000Z" }, "cardId": "<card id>", "propertyId": "<property id>" }
  ]
}
```

- Each edit comes from `properties` of the action. Keep `propertyId`, `type`, and `value` as they are. Add `cardId`.
- The tool runs each edit on its own. Read the result of every edit. If one failed, treat the call as failed.
- A select value must be an option that exists. The plan checks this. The tool cannot add an option.
- Save as `edit_card_properties-<card id>.json`.

## place_whiteboard_objects

Use it for a `place` action only.

```json
{
  "whiteboardId": "<whiteboard id>",
  "objects": [{ "id": "<card id>", "objectType": "card" }],
  "destination": { "type": "auto" }
}
```

- Take `whiteboardId` and `cardId` from the action.
- Call `read_whiteboard` first. Do not place a card that is on the whiteboard already.
- Do "Check the card before a write" before this call.
- Save as `place_whiteboard_objects-<card id>.json`.
- Each valid call adds the card to the whiteboard once more. Never call it again after a failure. See "When a call fails" in `SKILL.md`.

## get_file_download_url

Use it for a `download-pdf` action.

```json
{
  "fileId": "<file id>",
  "sourceObjectId": "<card id>",
  "sourceObjectType": "pdfCard"
}
```

- Get the file id from the `read_object` result of the PDF card.
- Save as `get_file_download_url-<card id>.json`.
- The result is a temporary address. It does not hold the file.
- Give the address to the user. Do not write it into the wiki.

## llm_wiki_status

Use it in "Before you start". It belongs to the `llm_wiki` MCP, not to Heptabase.

```json
{}
```

- Save as `llm_wiki_status.json`.
- A good result means that the app answers. It names the open project.
- A missing tool or a failed call means that the app is not running. Ingest of new snapshots then waits for the app.

## llm_wiki_rescan_sources

Use it at the end of Up, when `llm_wiki_status` said that the app runs. It belongs to the `llm_wiki` MCP.

```json
{ "project_id": "<project folder>" }
```

- Use the full path of this project folder. The app can have another project open.
- Save as `llm_wiki_rescan_sources.json`.
- The tool asks the app to scan the source folder with the source watch rules of the user. The source watch of the app must be on.
- If the call fails, go on. Tell the user that the app will see the new snapshots at its next scan.

## llm_wiki_add_review

Use it for a `skip-edited` action when the tool saved a note. This tool belongs to the `llm_wiki` MCP.
It may not exist yet. Look at the tool list first. If the tool is not there, skip this call. Do not fail.

```json
{
  "type": "mirror-edited",
  "title": "<card title> was edited in Heptabase",
  "description": "The user edited this mirror card. The changes are saved as a note in raw/sources/heptabase/.",
  "affectedPages": ["<page>"]
}
```

- Save as `llm_wiki_add_review-<card id>.json`.
- If the call fails, go on. Name the card in the report.
