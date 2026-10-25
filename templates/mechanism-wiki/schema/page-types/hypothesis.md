# Page type: hypothesis

## Purpose

A hypothesis page records one fusion: one mechanism applied to one target domain. See `docs/glossary.md` for the terms Fusion, Hypothesis page, Relation, Analogy, Stack, and Analogy strength.
The page says which parts of the mechanism fit the target domain and which parts do not. It lists what to verify.
The page is a hypothesis. Do not write it as a fact.

## Location

Write the page in `wiki/hypotheses/` of the target wiki. The target wiki is the wiki of the target domain.
Fusion writes hypothesis pages. Ingest does not.
Write the page only in the target wiki. Never copy work content into a reading wiki.

## Frontmatter

| Field | Required | Rule |
|---|---|---|
| `type` | yes | Write `hypothesis`. |
| `title` | yes | The hypothesis, in the output language. Quote it if it has a colon. |
| `mechanism` | yes | The mechanism page. Write the bare slug if the mechanism page is in this wiki. Write `reading:<slug>` if it is in the reading wiki and this wiki is a work wiki. The `role` field of `wiki.yaml` says which wiki this is: `role: work` is a work wiki. |
| `from_domain` | yes | The domain that gives the mechanism. The user or the whiteboard picks it. Write one path from `domains.yaml`. In a stack, it is the base layer. |
| `to_domain` | yes | The domain that receives the mechanism. Write one path from `domains.yaml`. In a stack, it is the upper layer. For indexes, lint, and Heptabase, it is the domain of the page. |
| `relation` | yes | `analogy` or `stack`. In a stack, `from_domain` is the base layer and `to_domain` is the upper layer. |
| `strength` | yes | `surface`, `structural`, or `mathematical`. Set it from the Strength rules in the lens of `to_domain`. |
| `status` | yes | `draft`, `testing`, `supported`, or `refuted`. Write `draft` for a new page. The Rules section has the condition for each value. |
| `heptabase_whiteboard` | no | The ID of the whiteboard that the hypothesis came from. Omit the field if there is none. |
| `tags` | yes | A list of bare words. Write `[]` if you have none. |
| `related` | yes | A list of bare slugs of pages in this wiki that the hypothesis uses. Write `[]` if you have none. |
| `sources` | yes | The raw file names behind the pages that you cite, with extensions, for example `["paper.md"]`. |
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
| `claim` | One-line hypothesis | 一句話假說 | 一句话假说 |
| `mapping` | Role mapping | 角色對照表 | 角色对照表 |
| `gaps` | Gaps and impact | 套不上的部分與影響 | 套不上的部分与影响 |
| `verify` | What to verify | 要驗證的事 | 要验证的事 |
| `search` | Search keywords | 建議搜尋關鍵字 | 建议搜索关键词 |
| `related` | Related pages | 相關頁面 | 相关页面 |

## Rules

### Do

- Read the lens of `to_domain` for the strength rules and the evidence rules. The domain entry in `domains.yaml` names the lens.
- Read the lens of `from_domain` to understand the parts of the mechanism. Find the domain entry in `domains.yaml` of this wiki. In a work wiki, you can also find it in `domains.yaml` of the reading wiki.
- Take `from_domain` and `to_domain` from `domains.yaml` of this wiki. In a work wiki, you can also take them from `domains.yaml` of the reading wiki. Do not invent a domain.
- For indexes, lint, and Heptabase, the domain of a hypothesis page is its `to_domain`.
- In a stack, `from_domain` is the base layer and `to_domain` is the upper layer.
- Read the Failure conditions section of the mechanism page before you map the parts.
- Cite a wiki page for every claim. Use a `[[slug]]` link to a page in this wiki.
- Write a claim that has no wiki page only under "What to verify".
- These citation rules win over rule 7 in `schema/writing-rules.md`. A hypothesis page may cite any wiki page. It does not need a source page.
- If a part, a flow, or a constraint has no supporting page in this wiki, write its mapping row with "Fits?" set to "unknown". Move the claim to "What to verify".
- The one-line hypothesis needs no citation. The sections below support it.
- Give every row under "What to verify" a "How to refute" cell. The cell says which result would disprove the claim.
- Set `strength` from the Strength rules in the lens of `to_domain`. `strength` measures the kind of match that the hypothesis claims. Evidence does not set it.
- Read the levels by `relation`. For `relation: stack`, `mathematical` means the equations or the trade-off curve of the base layer define the behavior of the upper layer.
- For `relation: stack`, `structural` means each upper-layer part maps to named base-layer components. `surface` means only a general dependency is known.
- Write `status: draft` when you create the page. `draft` means you wrote the page and have not tested it.
- Change `draft` to `testing` when at least one row under "What to verify" links a query page that holds evidence.
- Set `status: supported` only when evidence from the top two ranks resolves every row under "What to verify". The ranks are in the Evidence standard of the lens of `to_domain`.
- `supported` also needs at least one row under "What to verify". A page with zero rows stays `draft`.
- A row that rests only on lower ranks stays open. Then the status stays `testing` at most.
- Set `status: refuted` only when evidence from the top two ranks refutes one row under "What to verify".
- A later fusion update changes the status after it reads new evidence.
- Write only in the target wiki.

### Do not

- Write a `domain` field. A hypothesis page uses `from_domain` and `to_domain`.
- Link the mechanism page of the reading wiki from a work wiki. In a work wiki, write the mechanism name as plain text.
- Write a claim without a cited page outside "What to verify". The one-line hypothesis is the exception.
- Leave a "How to refute" cell empty.
- Raise `strength` because two terms look alike.
- Raise or lower `strength` because of the rank of the evidence.
- Write the hypothesis as a fact.

### What to write in each section

- One-line hypothesis: Write one sentence. Say which mechanism explains what in the target domain.
- Role mapping: Write one table. Use these columns: Mechanism part, Target counterpart, Fits?, Reason. Write one row for each part, each flow, and each constraint of the mechanism. One row can cover a short chain of flows. In "Fits?", write "fits", "partly fits", "does not fit", or "unknown" in the output language. For all values except "unknown", cite a page of this wiki in "Target counterpart" or "Reason". A row with "unknown" cites no page and has a matching row under "What to verify".
- Gaps and impact: For each row that does not fit or partly fits, write the gap and what it means for the hypothesis.
- What to verify: Write one table. Use these columns: Claim, Evidence needed, How to refute. Write one row for each claim that has no page. When a query page tracks a claim, link that page in the "Evidence needed" cell.
- Search keywords: Write 3 to 8 keywords or short phrases. A reader can search the web with them.
- Related pages: Link the pages of this wiki that the hypothesis uses. In a work wiki, do not link the mechanism page.

## Example

The slugs in this example are Latin for readability. A real Chinese wiki keeps CJK titles as CJK file names, as `schema.md` says.

```markdown
---
type: hypothesis
title: 事件驅動計算可以用在庫存補貨
mechanism: reading:event-driven-computing
from_domain: hardware/async-circuits
to_domain: business/inventory
relation: analogy
strength: structural
status: draft
heptabase_whiteboard: 00000000-0000-4000-8000-000000000001
tags: [fusion, inventory]
related: [stock-count-process, restock-policy]
sources: ["restock-notes.md"]
created: 2026-01-15
updated: 2026-01-15
---
# 事件驅動計算可以用在庫存補貨

## 一句話假說

事件驅動計算的結構，可以說明為什麼「庫存降到門檻才補貨」比「定期盤點」省工。

## 角色對照表

| 機制的部分 | 目標領域的對應 | 套得上嗎 | 原因 |
|---|---|---|---|
| 事件 | 庫存量降到補貨門檻 | 套得上 | [[restock-policy]]把門檻當成補貨的觸發條件。 |
| 偵測器 | 庫存系統的警示 | 不確定 | 目前沒有頁面說明系統能否即時警示。見「要驗證的事」。 |
| 通道 | 採購通知 | 部分套得上 | 通知要經過人工審核。[[restock-policy]] |
| 處理單元 | 採購人員 | 部分套得上 | [[restock-policy]]顯示人員同時處理多張訂單。 |
| 流動：變化、通知、計算 | 庫存下降、通知、下單 | 套得上 | [[restock-policy]]的補貨流程依這個順序進行。 |
| 約束：閒置時省電，代價是時間不固定 | 不盤點時省工，代價是補貨時間不固定 | 套得上 | [[stock-count-process]]指出定期盤點要耗費人力。 |
| 約束：不用共用時鐘，代價是要自己協調 | 不用統一盤點日，代價是各品項要自訂門檻 | 部分套得上 | [[restock-policy]]要求每個品項自訂門檻。 |
| 約束：回應快，代價是更難驗證 | 補貨快，代價是更難稽核 | 套不上 | [[stock-count-process]]顯示系統已保留完整紀錄。 |

## 套不上的部分與影響

- 採購通知要人工審核。所以事件到補貨之間有延遲，這會削弱「回應快」的優勢。[[restock-policy]]
- 採購人員一次處理多張訂單。所以「一次處理一個事件」只能當近似。[[restock-policy]]
- 每個品項要自訂門檻。所以管理成本會隨品項數增加。[[restock-policy]]
- 庫存系統已保留完整紀錄。所以「更難驗證」的代價在這裡不成立。[[stock-count-process]]

## 要驗證的事

| 主張 | 需要什麼證據 | 怎樣算推翻 |
|---|---|---|
| 門檻補貨的總人力比定期盤點低 | 兩種做法在同一批品項上的人力紀錄 | 門檻補貨的人力紀錄不低於定期盤點 |
| 事件密集時，門檻補貨會變得沒有效率 | 缺貨高峰期的補貨紀錄 | 高峰期的補貨效率與平常相同 |
| 庫存系統能即時警示補貨門檻 | 系統的警示設定與警示紀錄 | 警示紀錄顯示系統常常延遲警示 |

## 建議搜尋關鍵字

- reorder point policy
- continuous review inventory
- event-driven replenishment

## 相關頁面

- [[stock-count-process]]
- [[restock-policy]]
```

## Checklist

- [ ] Is the page in `wiki/hypotheses/` of the target wiki?
- [ ] Is there no `domain` field?
- [ ] Is `mechanism` a bare slug, or `reading:<slug>` in a work wiki?
- [ ] Do `from_domain` and `to_domain` each hold one path from `domains.yaml`?
- [ ] For a stack, is `from_domain` the base layer and `to_domain` the upper layer?
- [ ] Are `relation`, `strength`, and `status` values from the allowed lists?
- [ ] Does `status` follow the Rules: `testing` needs a linked query page, and `supported` needs at least one row?
- [ ] Did you set `strength` from the Strength rules, and `status` from the evidence ranks, in the lens of `to_domain`?
- [ ] Did you read the lens of `to_domain` and the lens of `from_domain`?
- [ ] Are the six sections present, in order, with headings in the output language?
- [ ] Does every claim except the one-line hypothesis cite a wiki page, or sit under "What to verify"?
- [ ] Does each row with "unknown" in "Fits?" have a matching row under "What to verify"?
- [ ] Does every row under "What to verify" have a "How to refute" cell?
- [ ] Does the table have a row for every part, flow, and constraint of the mechanism?
- [ ] Does each row that does not fit, or partly fits, have an entry under "Gaps and impact"?
- [ ] In a work wiki, did you leave the mechanism page of the reading wiki unlinked?
