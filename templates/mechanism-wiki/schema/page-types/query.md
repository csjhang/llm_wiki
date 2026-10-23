# Page type: query

## Purpose

A query page holds an open question under investigation. It also tracks a contradiction between sources.
It links to the sources and concepts that it uses. It shows what is known and what is not.

## Location

Write the page in `wiki/queries/`. Follow the file-name rules in `schema.md`.

## Frontmatter

| Field | Required | Rule |
|---|---|---|
| `type` | yes | Write `query`. |
| `title` | yes | The question or the contradiction, in the output language. Quote it if it has a colon. |
| `domain` | yes | Exactly one path from `domains.yaml`. |
| `also` | no | A list of other domain paths from `domains.yaml`. Omit the field if you have none. |
| `tags` | yes | A list of bare words. Write `[]` if you have none. |
| `related` | yes | The bare slugs of the source pages and concept pages that the query uses. |
| `sources` | yes | The raw file names that the query cites, with extensions, for example `["paper.md"]`. |
| `created` | yes | The date in `YYYY-MM-DD` form, without quotes. |
| `updated` | yes | The date in `YYYY-MM-DD` form. Set it to today when you change the page. |

## Rules

### Do

- Start the body with the question in one sentence.
- Write the best current answer next. If you have no answer, say so.
- Link every source page and concept page that the query uses. Use `[[slug]]` in the body.
- For a contradiction, link both source pages. State the claim of each source in one sentence.
- Say what evidence would settle the question.
- Save the result of a deep research run in this directory only after the user approves it.
- Link the hypothesis page from the query page when the query checks an item under "What to verify".
- Update the page when new evidence arrives. Set `updated` to today.

### Do not

- Write the result of a deep research run here before the user approves it.
- Write an open question as a fact.
- Close a contradiction without a source that settles it.
- Put two domains in `domain`.
- Write a claim that cites no source.

## Example

```markdown
---
type: query
title: 事件驅動電路真的比較省電嗎？
domain: hardware/async-circuits
also: []
tags: [event-driven, power]
related: [async-circuits-survey, snn-primer, event-driven-circuits]
sources: ["async-circuits-survey.md", "snn-primer.md"]
created: 2026-01-15
updated: 2026-01-15
---
# 事件驅動電路真的比較省電嗎？

兩篇來源對耗能的說法不同。目前的答案是：閒置時省電，事件密集時不一定。

## 目前的答案

- 閒置時，事件驅動電路不計算，所以耗能低。
- 事件很密集時，處理事件的成本可能超過輪詢。

## 矛盾

- [[async-circuits-survey]]指出，事件驅動電路整體耗能較低。
- [[snn-primer]]指出，事件很密集時，耗能與輪詢相近。

## 要查的事

- 找出兩篇來源使用的事件密度。
- 比較同一個工作負載下的耗能。
```

## Checklist

- [ ] Is the page in `wiki/queries/`?
- [ ] Does the body start with the question?
- [ ] Does the page link every source and concept that it uses?
- [ ] For a contradiction, does the page link both sources and state each claim?
- [ ] Does the page say what evidence would settle the question?
- [ ] Did the user approve any deep research result before you saved it here?
- [ ] Does `domain` hold exactly one path from `domains.yaml`?
- [ ] Do `related` and `sources` follow the cross-reference rules in `schema.md`?
