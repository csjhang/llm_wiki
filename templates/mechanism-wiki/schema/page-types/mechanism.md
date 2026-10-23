# Page type: mechanism

## Purpose

A mechanism page states a structure that repeats across domains. See `docs/glossary.md` for the terms Mechanism and Instance.
Every mechanism page has the same six sections. The lens of a domain says what each field means in that domain. A field is one of those sections.
The page holds no domain detail. The instance pages hold the detail.
A mechanism page can start with one instance. Write the concept or entity page for the domain-specific thing, and write or update a mechanism page that lists it as an instance.

## Location

Write the page in `wiki/mechanisms/`. Only a reading wiki writes mechanism pages.
A work wiki does not write them. It sends a `new-mechanism` review item instead.
Before you write a page, search `wiki/indexes/_mechanisms.md` for the same mechanism. If a page exists, add one line to its Known instances section. Do not write a second page.

## Frontmatter

| Field | Required | Rule |
|---|---|---|
| `type` | yes | Write `mechanism`. |
| `title` | yes | The name of the mechanism, in the output language. Use domain-neutral words. Quote it if it has a colon. |
| `lenses` | yes | A list of lens ids, for example `[hardware, ai]`. Add the lens of each domain that has an instance. Use only ids that have a file in `lenses/`. |
| `instances` | yes | A list of bare slugs of the instance pages. Keep it equal to the links in the Known instances section. |
| `tags` | yes | A list of bare words. Write `[]` if you have none. |
| `related` | yes | A list of bare slugs of related pages. A reading wiki can list the hypothesis pages that use this mechanism. |
| `sources` | yes | The raw file names that support the page, with extensions, for example `["paper.md"]`. |
| `created` | yes | The date in `YYYY-MM-DD` form, without quotes. |
| `updated` | yes | The date in `YYYY-MM-DD` form. Set it to today when you change the page. |

## Sections

Write the six sections below as level-2 headings. Keep this order. Do not add, remove, or rename a section.
Pick the headings by the meaning of the output language, as `schema.md` says.
`Traditional Chinese` uses the Traditional Chinese headings. `繁體中文`, `zh-TW`, and `zh-Hant` mean the same.
`Chinese` is the app value for Simplified Chinese. It uses the Simplified Chinese headings. `简体中文`, `zh-CN`, `zh-Hans`, and `Simplified Chinese` mean the same.
`auto` and every other language use the English headings.

| Key | English | Traditional Chinese | Simplified Chinese |
|---|---|---|---|
| `parts` | Parts | 組成 | 组成 |
| `flows` | Flows | 流動 | 流动 |
| `constraints` | Constraints and trade-offs | 約束與取捨 | 约束与取舍 |
| `why` | Why it works | 為什麼有效 | 为什么有效 |
| `failure` | Failure conditions | 失效條件 | 失效条件 |
| `instances` | Known instances | 已知實例 | 已知实例 |

## Rules

### Do

- Write the title, then one line that states the mechanism. In Traditional Chinese, start that line with `一句話：`.
- Write every section in domain-neutral words. Use "event", not the word that one domain uses.
- Write at least one failure condition. A mechanism page without one is not complete.
- Cite a source for every claim. See rule 7 in `schema/writing-rules.md`. A claim counts as sourced when its section has at least one `[[<source-page-slug>]]` link that supports it.
- Skip the source link in the one-line summary and in Known instances. The other sections support the summary. Each instance page holds its own sources.
- Use one word for one part on the whole page. See rule 1 in `schema/writing-rules.md`.
- Keep `instances` equal to the slugs that you link under Known instances.
- Add the lens of each instance domain to `lenses`.

### Do not

- Write a `domain` field or an `also` field. A mechanism page applies to many domains.
- Write an industry name, a vendor name, a product name, or a number that belongs to one domain.
- Explain an instance on the mechanism page. Write one line in the known-instance form and link the instance page.
- Write a mechanism page in a work wiki.
- Write a second page for a mechanism that already has a page.
- Write a failure condition that only one instance has.

### What to write in each section

- Parts: Name each part and its role in one line. Write 3 to 7 parts. Do not describe what the parts exchange.
- Flows: Write what moves between the parts, for example signals, material, or information. Name the parts by the names that Parts uses. Do not define a part again. Write 3 to 7 lines, in order.
- Constraints and trade-offs: Write what limits the mechanism and what it gives up. Write 2 to 5 lines. State each trade-off as a gain and its cost.
- Why it works: Write the reason that the structure works. Write one short paragraph of at most 5 sentences. Do not list instances.
- Failure conditions: Write when the mechanism stops working. Write 1 to 5 lines. Each line says what changes and what breaks.
- Known instances: Write one line for each instance. Use exactly this form in every language: `- [[<slug>]] (<domain>): <local term>`. Use ASCII punctuation. `<domain>` is the full domain path, for example `ai/architecture`. The local term is the name that the domain uses.

## Example

The slugs in this example are Latin for readability. A real Chinese wiki keeps CJK titles as CJK file names, as `schema.md` says.

```markdown
---
type: mechanism
title: 事件驅動計算
lenses: [hardware, ai]
instances: [async-handshake, spiking-neural-network]
tags: [event-driven]
related: [polling]
sources: ["async-circuits-survey.md", "snn-primer.md"]
created: 2026-01-15
updated: 2026-01-15
---
# 事件驅動計算

一句話：沒有全域時鐘，有變化才計算。

## 組成

- 事件：狀態的一次變化。
- 偵測器：監看狀態，發現變化。
- 通道：負責傳遞。
- 處理單元：執行計算。[[async-circuits-survey]]

## 流動

- 偵測器發現變化後，產生事件。
- 通道把事件送到處理單元。
- 處理單元收到事件才計算，並把結果當成新事件送出。
- 沒有事件時，偵測器、通道和處理單元都保持閒置。[[async-circuits-survey]]

## 約束與取捨

- 系統在閒置時省電，代價是事件到達的時間不固定。[[async-circuits-survey]]
- 處理單元不需要共用時鐘，代價是它們要自己協調順序。
- 系統回應快，代價是它更難驗證。[[snn-primer]]

## 為什麼有效

大多數時間裡，狀態沒有變化。這個機制只在變化發生時計算。所以它不在不變的狀態上浪費資源。[[async-circuits-survey]]

## 失效條件

- 事件太密集時，處理事件的成本超過輪詢的成本。
- 計算需要全域一致的順序時，事件各自到達會造成錯誤。
- 事件會遺失，又沒有重送機制時，結果會缺漏。[[snn-primer]]

## 已知實例

- [[spiking-neural-network]] (ai/architecture): 脈衝
- [[async-handshake]] (hardware/async-circuits): request/ack
```

## Checklist

- [ ] Is the page in `wiki/mechanisms/` of a reading wiki?
- [ ] Does the page have no `domain` field and no `also` field?
- [ ] Does `lenses` hold only ids that have a file in `lenses/`?
- [ ] Does `instances` equal the slugs linked under Known instances?
- [ ] Are the six sections present, in order, with headings in the output language?
- [ ] Does Failure conditions hold at least one condition?
- [ ] Is the text free of industry names, vendor names, and product names?
- [ ] Does each instance line have the exact form `- [[<slug>]] (<domain>): <local term>`?
- [ ] Did you search `wiki/indexes/_mechanisms.md` for the same mechanism?
- [ ] Does every section except Known instances link at least one source page that supports it?
- [ ] Does Parts give one role per part, and does Flows use the names that Parts uses?
