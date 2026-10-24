# MCP steps of wiki-sync

This file lists every MCP call of the skill `wiki-sync`.
Each section gives the tool, the exact arguments, and the file name of the result.
Read it before the first MCP call.

## Rules for every call

- Save the whole result in `<project>/.llm-wiki/hepta/`. The file holds the JSON object with `content` and `status`.
- `<n>` in a file name is the page number, starting at 1. `<card id>` and `<page slug>` stand for the real values.
- Check `status` first. Only `succeeded` is good.
- If the result says `clientTaskFailed`, send the same arguments again once with `"runOn": {"type": "server"}`. Add nothing else.
- On any other failure, stop that step. Show the message to the user.
- Every id in this file is a placeholder. Take the real ids from `heptabase.yaml`, from the plan, or from a saved result.
- Never type MCP output into a command line. Pass the saved file.

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
{ "offset": 0 }
```

- Do not set `limit` or `depth`. The defaults are 20 and 4.
- Do not set `parentWhiteboardId`. It lists part of the tree.
- A list that has more pages ends with `More top-level whiteboards are available. Showing a-b of N.`
- Call again with the `offset` that this line gives. Do this until a page has no such line.
- Save as `list_whiteboards-p<n>.json`.
- Pass every page with a repeated `--whiteboards` to `init` and to `plan-up`. Never pass one partial page.

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

One card, to get its time after a write (Down):

```json
{
  "cardIds": ["<card id>"],
  "include": ["whiteboards", "tags", "timestamps"]
}
```

- Save as `list_cards-card-<card id>.json`.
- Read the time after `updated:` in the line of the card. This is `cardUpdatedAt`.

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
- Pass every page with a repeated `--content` to `snapshot`. Pass the pages in page order.

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

Use it to look inside a whiteboard in "Set up Heptabase", and to check a `place` action before a second try.

```json
{
  "whiteboardId": "<whiteboard id>",
  "mode": "structure"
}
```

- Save as `read_whiteboard-<whiteboard id>.json`.
- The structure lists the cards by title and id. Look for the card id.

## create_object

Use it for a `create` action.

```json
{
  "objectType": "card",
  "content": "<body of the action>"
}
```

- Send `body` exactly as the plan gives it. It is Hepta Markdown and starts with the title as a heading.
- Save as `create_object-<page slug>.json`.
- Read the new card id from the result.
- If the result does not say whether the card exists, ask the user to check Heptabase before you call again. A second call makes a second card.

## edit_object_content

Use it for an `update`, a `relink`, and a `retire` action.

```json
{
  "objectType": "card",
  "objectId": "<card id>",
  "oldString": "<old text>",
  "newString": "<new text>"
}
```

- Read the card first with `read_object`, all pages.
- The whole body changes, so it is one edit. `oldString` is the whole old text.
- Build the old text from the content lines. Remove only the line number and the tab from each line. Join the lines with line feeds.
- Leave out the header line and the `--- Databases ---` block.
- Copy every protected region byte for byte. These are `hepta-placeholder` tags, media, bookmarks, and complex tables.
- For an `update` or a `relink`, `newString` is the `body` of the action.
- For a `retire`, `newString` is `# ` and the `title` of the action, an empty line, and the `body` of the action.
- Do not use `replaceAll`.
- Save as `edit_object_content-<card id>.json`.
- If the tool refuses the edit, stop for this card. Do not run `record`.

## update_database_card_membership

Use it for a `create` action, to add the new card to the mirror tag.

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

Use it for a `create`, an `update`, and a `retire` action.

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
- Save as `place_whiteboard_objects-<card id>.json`.
- Each valid call adds the card to the whiteboard once more. Do not repeat a call that may have worked. Check with `read_whiteboard` first.

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

## llm_wiki_add_review

Use it for a `skip-edited` action. This tool belongs to the `llm_wiki` MCP.
It may not exist yet. Look at the tool list first. If the tool is not there, skip this call. Do not fail.

```json
{
  "type": "mirror-edited",
  "title": "<card title> was edited in Heptabase",
  "description": "The user edited this mirror card. The text is saved as a note in raw/sources/heptabase/.",
  "affectedPages": ["<page>"]
}
```

- Save as `llm_wiki_add_review-<card id>.json`.
- If the call fails, go on. Name the card in the report.
