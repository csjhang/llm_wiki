# Page type: comparison

## Purpose

A comparison page sets two or more named pages side by side. It shows how they differ on stated points.
The page links to each page that it compares. Each row cites a source.

## Location

Write the page in `wiki/comparisons/`. Follow the file-name rules in `schema.md`.

## Frontmatter

| Field | Required | Rule |
|---|---|---|
| `type` | yes | Write `comparison`. |
| `title` | yes | Name the compared pages, for example `Polling and event-driven design`. Quote it if it has a colon. |
| `domain` | yes | Exactly one path from `domains.yaml`. Use the domain of the main subject. |
| `also` | no | A list of other domain paths from `domains.yaml`. Use it when a compared page has another domain. |
| `tags` | yes | A list of bare words. Write `[]` if you have none. |
| `related` | yes | The bare slugs of all compared pages. Add other related pages. |
| `sources` | yes | The raw file names that the rows cite, with extensions, for example `["paper.md"]`. |
| `created` | yes | The date in `YYYY-MM-DD` form, without quotes. |
| `updated` | yes | The date in `YYYY-MM-DD` form. Set it to today when you change the page. |

## Rules

### Do

- Start the body with the conclusion. Say which item wins on which point, or say that none wins.
- Name every compared page in the opening sentence. Link each one with `[[slug]]`.
- Choose `domain` by the main subject. The main subject is the first page named in the title. If it is not clear, ask the user.
- Write the comparison as a table. Use one column for each compared page.
- Add a last column named for the source. Put a `[[slug]]` link to a source page in every row.
- Cite a source for every claim outside the table too. A claim counts as sourced when its section has at least one `[[<source-page-slug>]]` link that supports it.
- Compare the items on points that they share. Name the point in the first column.
- Put every compared page in `related`.
- Write a claim from a note as the view of the user.

### Do not

- Write a row without a source.
- Compare a thing that has no page. Write the page first.
- Put two domains in `domain`.
- Mix the claims of two compared pages. Keep each claim in the column of the page that it describes.
- Write a number that the cited source does not give.

## Example

The slugs in this example are Latin for readability. A real Chinese wiki keeps CJK titles as CJK file names, as `schema.md` says.

```markdown
---
type: comparison
title: 輪詢與事件驅動的比較
domain: hardware/async-circuits
also: []
tags: [event-driven, polling]
related: [polling, event-driven-circuits]
sources: ["async-circuits-survey.md", "snn-primer.md"]
created: 2026-01-15
updated: 2026-01-15
---
# 輪詢與事件驅動的比較

[[event-driven-circuits]]在閒置時比[[polling]]省電，但比較難驗證。[[async-circuits-survey]]

| 比較項目 | 輪詢 | 事件驅動 | 來源 |
|---|---|---|---|
| 閒置時的耗能 | 持續檢查，持續耗能 | 沒有事件就不耗能 | [[async-circuits-survey]] |
| 回應速度 | 受檢查間隔限制 | 事件一到就處理 | [[async-circuits-survey]] |
| 驗證難度 | 較低 | 較高 | [[snn-primer]] |

## 沒有結論的部分

- [[async-circuits-survey]]和[[snn-primer]]都沒有比較事件很密集時的耗能。
```

## Checklist

- [ ] Is the page in `wiki/comparisons/`?
- [ ] Does the opening sentence give the conclusion?
- [ ] Does the opening sentence name and link every compared page?
- [ ] Does each section outside the table link at least one source page that supports it?
- [ ] Does every compared page appear in `related`?
- [ ] Does every row cite a source page?
- [ ] Does each source page in a row have its raw file name in `sources`?
- [ ] Does each claim stay in the column of the page that it describes?
- [ ] Does `domain` hold exactly one path from `domains.yaml`?
