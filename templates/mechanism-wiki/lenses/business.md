# Lens: business

## Purpose

This lens says what each mechanism field means in a business domain. It also sets the evidence standard and the strength rules.
A business domain studies how firms create, deliver, and capture value.
Use this lens in these cases:

- You read or write a page of a domain whose `lens` is `business` in `domains.yaml`. Concept, entity, and source pages use only the Evidence standard. The Fields section applies to mechanism pages.
- You write a mechanism page that has a business instance. Add `business` to its `lenses:` list.
- You write a hypothesis page. The lens of `to_domain` sets the Strength rules and the Evidence standard. The lens of `from_domain` explains the parts of the mechanism.

## Fields

Each field is one section of a mechanism page. The lines below say what the field holds when the instance is in a business domain.

### Parts

Write: one line for each role in the business. A role is a job that a party, a unit, or an asset does, for example buyer, seller, or sales channel.

Do not write: the name of a firm, a person, or a product. Do not write the money or the goods that move between roles.

### Flows

Write: how value and money move between the roles, in order. Say which role gives value and which role pays. Name each role by its name in Parts.

Do not write: a price, a revenue figure, or a date. Do not define a role again.

### Constraints and trade-offs

Write: the cost structure that limits the mechanism. Say which costs are fixed, which costs grow with volume, and what the mechanism gives up. State each trade-off as a gain and its cost.

Do not write: the cost figures of one firm. Do not write a trade-off that only one instance has.

### Why it works

Write: the moat. A moat is the reason that a rival cannot copy the result, for example switching cost, scale, or a network. Give the reason as cause and effect.

Do not write: the names of firms that have the moat. Do not write "it is a good business" or any other claim without a reason.

### Failure conditions

Write: the change in the market, the cost, or the customer that ends the moat. Say what changes and what breaks.

Do not write: the failure of one firm, for example poor management. Do not write a failure condition that only one instance has.

## Evidence standard

Rank evidence from strongest to weakest. When two pieces of evidence disagree, trust the higher item.

1. Audited financial statements.
2. Operating data that the firm discloses, for example filings and investor reports.
3. Interviews with people who work at or with the firm.
4. Press claims.

Evidence does not set `strength`. It decides two other things on a hypothesis page.

- Role mapping: a "Fits?" cell has a value other than "unknown" only when a cited page supports the row. Otherwise write "unknown" and move the claim to "What to verify".
- Status: `supported` needs evidence from the top two ranks to resolve every "What to verify" row. A row that rests only on lower ranks stays open, so the status stays `testing` at most. `refuted` needs evidence from the top two ranks to refute one row.

## Strength rules

`strength` measures the kind of match that the hypothesis claims. Set it from these rules, not from evidence. Read each level by the `relation` of the page. Pick the highest level that the match meets. If it meets neither `structural` nor `mathematical`, use `surface`.

- `surface`: For an analogy, the words look alike, but the parts and the flows do not match one to one. For a stack, only a general dependency is known.
- `structural`: For an analogy, the parts and the flows match one to one. For a stack, each upper-layer part maps to named lower-layer components.
- `mathematical`: For an analogy, both sides follow the same equations or the same trade-off curve. For a stack, the equations or the trade-off curve of the lower layer define the behavior of the upper layer.

Check who gives value and who pays on both sides, because a shared word such as "platform" is not a match.

## Example

The slugs in this example are Latin for readability. A real Chinese wiki keeps CJK titles as CJK file names, as `schema.md` says.
This example uses domain words to show the lens. A real mechanism page uses domain-neutral words, as `schema/page-types/mechanism.md` says.

```markdown
---
type: mechanism
title: 轉換成本鎖定
lenses: [business]
instances: [subscription-lock-in]
tags: [moat]
related: []
sources: ["lock-in-case-study.md"]
created: 2026-01-15
updated: 2026-01-15
---
# 轉換成本鎖定

一句話：離開的成本高於留下的成本，所以買方留下來付費。

## 組成

- 賣方：供應產品的一方。
- 買方：使用產品的一方。
- 累積資產：在使用過程中累積的資料、習慣或設定。
- 替代方案：另一個可以改用的選擇。[[lock-in-case-study]]

## 流動

- 賣方把價值交給買方，買方把錢付給賣方。
- 買方每使用一次，累積資產就增加一些。
- 累積資產只留在賣方的系統裡，不能帶去替代方案。[[lock-in-case-study]]
- 買方比較留下的成本和改用替代方案的成本，再決定是否續付。

## 約束與取捨

- 固定成本高、邊際成本低。多留一位買方的收益大，代價是賣方要先投入大量成本。[[lock-in-case-study]]
- 鎖得越緊，買方越難離開，代價是新買方更不願意開始。
- 賣方可以長期收費，代價是它要持續維護累積資產的價值。

## 為什麼有效

護城河來自轉換成本。買方離開時，要放棄累積資產，還要重新累積。只要離開的成本高於替代方案的好處，買方就會留下。所以賣方不必降價也能留住買方。[[lock-in-case-study]]

## 失效條件

- 替代方案提供搬移工具，把搬移累積資產的成本降到接近零時，鎖定消失。[[lock-in-case-study]]
- 累積資產過時時，買方放棄它的損失變小，鎖定變弱。
- 賣方漲價的幅度超過轉換成本時，買方轉而離開。

## 已知實例

- [[subscription-lock-in]] (business/subscriptions): 訂閱綁定
```
