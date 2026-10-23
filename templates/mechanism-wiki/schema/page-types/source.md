# Page type: source

## Purpose

A source page summarizes one source. It records what the source says. It adds no claim from another source.
The glossary defines the terms Source, Article, and Note. Read `docs/glossary.md`.

## Location

Write the page in `wiki/sources/`. The app prompt gives the file name of the summary page.
Write one source page for each file in `raw/sources/`. Never edit a file in `raw/`.

## Frontmatter

| Field | Required | Rule |
|---|---|---|
| `type` | yes | Write `source`. |
| `title` | yes | The title of the source, in the output language. Quote it if it has a colon. |
| `domain` | yes | Exactly one path from `domains.yaml`. |
| `also` | no | A list of other domain paths from `domains.yaml`. Omit the field if you have none. |
| `source_kind` | yes | `article` or `note`. Copy the value from the raw file header when it has one. |
| `tags` | yes | A list of bare words, for example `[async, handshake]`. Write `[]` if you have none. |
| `related` | yes | A list of bare slugs of related pages. Write `[]` if you have none. |
| `sources` | yes | The name of the raw file, with its extension, for example `["paper.md"]`. |
| `created` | yes | The date in `YYYY-MM-DD` form, without quotes. |
| `updated` | yes | The date in `YYYY-MM-DD` form. Set it to today when you change the page. |

## Rules

### Do

- Start the body with one sentence that summarizes the source.
- List the main claims of the source. Write one claim in each bullet.
- Link the entity pages and concept pages that the source supports. Use `[[slug]]` in the body.
- Set `source_kind` to `article` for a web clip, a PDF, or any text from an outside author.
- Set `source_kind` to `note` for text that the user wrote. Ask the user if you cannot tell.
- Write a note as the view of the user. Say who holds the view. See rule 6 in `schema/writing-rules.md`.
- Keep each claim on the subject that the source describes.
- Record a contradiction in the page that holds the claim. Open or update a query page, as `schema.md` says.

### Do not

- Edit any file in `raw/`.
- Write a second source page for the same raw file.
- Write a source page for a work that the source only cites. Link an existing page instead.
- Write a note as a fact.
- Move a claim to another subject because the two subjects share a term.
- Write a number that the source does not give.

## Example

The slugs in this example are Latin for readability. A real Chinese wiki keeps CJK titles as CJK file names, as `schema.md` says.

```markdown
---
type: source
title: 非同步電路綜述
domain: hardware/async-circuits
also: [ai/architecture]
source_kind: article
tags: [event-driven, async]
related: [request-ack-handshake, spiking-neural-network]
sources: ["async-circuits-survey.md"]
created: 2026-01-15
updated: 2026-01-15
---
# 非同步電路綜述

這篇綜述指出，沒有全域時鐘的電路只在輸入變化時計算。

## 重點

- 作者說明[[request-ack-handshake]]如何協調兩個模組。
- 作者認為，這種電路在閒置時耗能較低。
- 作者指出，驗證這種電路比驗證同步電路困難。
- 作者提到脈衝神經網路也有類似的結構。[[spiking-neural-network]]

## 限制

- 綜述沒有給出耗能的數字。
```

## Checklist

- [ ] Is there exactly one source page for this raw file?
- [ ] Is the page in `wiki/sources/`?
- [ ] Does `sources` hold the raw file name with its extension?
- [ ] Does `domain` hold exactly one path from `domains.yaml`?
- [ ] Is `source_kind` either `article` or `note`?
- [ ] If `source_kind` is `note`, does the page name the user as the holder of each view?
- [ ] Does each claim stay on the subject that the source describes?
- [ ] Do `related` and `tags` hold bare words and bare slugs, without `[[ ]]`?
- [ ] Did you leave every file in `raw/` unchanged?
