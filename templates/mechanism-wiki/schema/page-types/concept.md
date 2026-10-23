# Page type: concept

## Purpose

A concept page explains one idea, technique, or phenomenon. The page belongs to exactly one domain.
A structure that repeats across domains is not a concept. It is a mechanism. See `schema/page-types/mechanism.md` and `docs/glossary.md`.

## Location

Write the page in `wiki/concepts/`. Follow the file-name rules in `schema.md`.
Two domains can have a concept with the same name. Write two pages. Add the suffix `--<last-domain-segment>` to both file names.

## Frontmatter

| Field | Required | Rule |
|---|---|---|
| `type` | yes | Write `concept`. |
| `title` | yes | The name of the concept, in the output language. Quote it if it has a colon. |
| `domain` | yes | Exactly one path from `domains.yaml`. |
| `also` | no | A list of other domain paths from `domains.yaml`. Omit the field if you have none. |
| `tags` | yes | A list of bare words. Write `[]` if you have none. |
| `related` | yes | A list of bare slugs of related pages. Write `[]` if you have none. |
| `sources` | yes | The raw file names that support the page, with extensions, for example `["paper.md"]`. |
| `created` | yes | The date in `YYYY-MM-DD` form, without quotes. |
| `updated` | yes | The date in `YYYY-MM-DD` form. Set it to today when you change the page. |

## Rules

### Do

- Start the body with one sentence that defines the concept. Put the conclusion first.
- Choose exactly one `domain`. Put every other related domain in `also`.
- Explain the concept in the words of its domain.
- Keep each claim on the concept that it describes.
- Cite a source for every claim. Link the source page with `[[slug]]`.
- If another domain has a concept with the same name, add `--<last-domain-segment>` to both file names.
- Put one line directly under the title that links to the same-name page of the other domain.
- Write a claim from a note as the view of the user.

### Do not

- Put two domains in `domain`.
- Mix the meanings of a same-name concept from two domains on one page.
- Write one concept page for a structure that repeats across domains. Use a mechanism page, as `schema.md` says.
- Move a claim to another concept because the two concepts share a term.
- Use a synonym for a glossary term.

## Example

```markdown
---
type: concept
title: 注意力
domain: ai
also: []
tags: [attention, model]
related: [transformer-architecture]
sources: ["attention-primer.md"]
created: 2026-01-15
updated: 2026-01-15
---
# 注意力

另見：[[attention--cognition]]。那一頁說明認知領域的注意力。

注意力讓模型依輸入的相關程度分配權重。

## 運作方式

- 模型為每個輸入計算一個分數。[[attention-primer]]
- 分數越高，這個輸入影響輸出的程度越大。
- 模型把分數正規化，使它們的總和為 1。

## 限制

- 輸入越長，計算量越大。[[attention-primer]]
```

## Checklist

- [ ] Is the page in `wiki/concepts/`?
- [ ] Does `domain` hold exactly one path from `domains.yaml`?
- [ ] Does the page explain only the meaning that this domain uses?
- [ ] Does each claim stay on the concept that it describes?
- [ ] Does each claim have a source?
- [ ] If a same-name page exists in another domain, do both file names carry the `--<last-domain-segment>` suffix?
- [ ] If a same-name page exists, does a line under the title link to it?
- [ ] Does the page use each glossary term with its one meaning?
