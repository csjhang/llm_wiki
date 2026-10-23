# Page type: entity

## Purpose

An entity page describes one named thing. The thing is a person, an organization, a tool, a product, or a dataset.
The page belongs to exactly one domain. See `docs/glossary.md` for the term Domain.

## Location

Write the page in `wiki/entities/`. Follow the file-name rules in `schema.md`.
Two domains can have an entity with the same name. Write two pages. Add the suffix `--<last-domain-segment>` to both file names.

## Frontmatter

| Field | Required | Rule |
|---|---|---|
| `type` | yes | Write `entity`. |
| `title` | yes | The name of the thing, in its usual form. Quote it if it has a colon. |
| `domain` | yes | Exactly one path from `domains.yaml`. |
| `also` | no | A list of other domain paths from `domains.yaml`. Omit the field if you have none. |
| `tags` | yes | A list of bare words. Write `[]` if you have none. |
| `related` | yes | A list of bare slugs of related pages. Write `[]` if you have none. |
| `sources` | yes | The raw file names that support the page, with extensions, for example `["paper.md"]`. |
| `created` | yes | The date in `YYYY-MM-DD` form, without quotes. |
| `updated` | yes | The date in `YYYY-MM-DD` form. Set it to today when you change the page. |

## Rules

### Do

- Start the body with one sentence that says what the thing is.
- Choose exactly one `domain`. Put every other related domain in `also`.
- Keep each claim on the entity that it describes.
- Cite a source for every claim. Link the source page with `[[slug]]`.
- Link the concept pages that the entity uses.
- If another domain has an entity with the same name, add `--<last-domain-segment>` to both file names.
- Put one line directly under the title that links to the same-name page of the other domain.
- Write a claim from a note as the view of the user.

### Do not

- Put two domains in `domain`.
- Merge two things into one page because they share a name.
- Move a claim to another entity because the two entities share a term.
- Rename a file when you update a page.
- Invent a fact about the entity that no source gives.

## Example

```markdown
---
type: entity
title: 範例事件資料集
domain: ai/architecture
also: [hardware/async-circuits]
tags: [dataset, event-driven]
related: [spiking-neural-network]
sources: ["event-dataset-paper.md"]
created: 2026-01-15
updated: 2026-01-15
---
# 範例事件資料集

範例事件資料集是一組事件流的記錄，用來訓練脈衝神經網路。

## 內容

- 論文說明，資料集記錄的是亮度變化，不是完整畫面。[[event-dataset-paper]]
- 論文說明，每筆記錄有時間、位置和變化方向。

## 用途

- 論文用它測試[[spiking-neural-network]]的分類能力。

## 限制

- 論文沒有說明資料集的授權條款。
```

## Checklist

- [ ] Is the page in `wiki/entities/`?
- [ ] Does `domain` hold exactly one path from `domains.yaml`?
- [ ] Is each other related domain in `also`?
- [ ] Does each claim stay on the entity that it describes?
- [ ] Does each claim have a source?
- [ ] If a same-name page exists in another domain, do both file names carry the `--<last-domain-segment>` suffix?
- [ ] If a same-name page exists, does a line under the title link to it?
- [ ] Do `related` and `sources` follow the cross-reference rules in `schema.md`?
