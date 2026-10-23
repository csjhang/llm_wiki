# Page type: concept

## Purpose

A concept page explains one idea, technique, or phenomenon. The page belongs to exactly one domain.
A structure that repeats across domains is a mechanism. Write the concept or entity page for the domain-specific thing, and write or update a mechanism page that lists it as an instance.
See `schema/page-types/mechanism.md` and `docs/glossary.md`.

## Location

Write the page in `wiki/concepts/`. Follow the file-name rules in `schema.md`.
Two domains can have a concept with the same name. Write two pages. Never rename an existing file.
Add the suffix `--<last-domain-segment>` to the new page only. Keep the file name of the old page.
If the `--<last-domain-segment>` file name already exists, use the full domain path instead. Replace each `/` in the domain with `--`. For example, `attention` in `ai/architecture` becomes `attention--ai--architecture.md`.

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
- Cite a source for every claim. Link the source page with `[[slug]]`. A claim counts as sourced when its section has at least one `[[<source-page-slug>]]` link that supports it.
- If another domain has a concept with the same name, add `--<last-domain-segment>` to the new page only.
- Put one line at the top of each of the two pages, directly under the title. Each line links to the other page.
- Write a claim from a note as the view of the user.
- When the idea is one instance of a mechanism, still write this concept page. Then write or update the mechanism page that lists it.

### Do not

- Put two domains in `domain`.
- Mix the meanings of a same-name concept from two domains on one page.
- State a structure that repeats across domains on a concept page. The mechanism page states it.
- Move a claim to another concept because the two concepts share a term.
- Use a synonym for a glossary term.
- Rename an existing file. Renaming an old page is a job for the `wiki-recut` skill.

## Example

The slugs in this example are Latin for readability. A real Chinese wiki keeps CJK titles as CJK file names, as `schema.md` says.

The example is the old page `attention.md` of the domain `ai`. The new same-name page of the domain `cognition` is `attention--cognition.md`.

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

注意力讓模型依輸入的相關程度分配權重。[[attention-primer]]

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
- [ ] Does each section that holds claims link at least one source page that supports it?
- [ ] If a same-name page exists in another domain, does only the new page carry the `--<last-domain-segment>` suffix?
- [ ] If the `--<last-domain-segment>` file name exists, did you use the full domain path?
- [ ] Did you keep the file name of every existing page?
- [ ] If a same-name page exists, does each of the two pages have a line at the top that links to the other?
- [ ] Does the page use each glossary term with its one meaning?
