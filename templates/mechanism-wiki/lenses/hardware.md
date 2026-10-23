# Lens: hardware

## Purpose

This lens says what each mechanism field means in a hardware domain. It also sets the evidence standard and the strength rules.
A hardware domain studies circuits, chips, and the systems built from them.
Use this lens in these cases:

- You read or write a page of a domain whose `lens` is `hardware` in `domains.yaml`. Concept, entity, and source pages use only the Evidence standard. The Fields section applies to mechanism pages.
- You write a mechanism page that has a hardware instance. Add `hardware` to its `lenses:` list.
- You write a hypothesis page. The lens of `to_domain` sets the Strength rules and the Evidence standard. The lens of `from_domain` explains the parts of the mechanism.

## Fields

Each field is one section of a mechanism page. The lines below say what the field holds when the instance is in a hardware domain.

### Parts

Write: one line for each component, cell, or interconnect. A component is a block that does one job. A cell is a small unit that repeats. An interconnect carries signals between them.

Do not write: a vendor name, a part number, or a process name. Do not write the signals or the data that move between parts.

### Flows

Write: the signals, the data, the clock, and the power that move between the parts, in order. Name each part by its name in Parts.

Do not write: a frequency, a voltage, or a bandwidth figure. Do not define a part again.

### Constraints and trade-offs

Write: the trade-offs among area, power, and latency. Add the limits of the process and the yield. State each trade-off as a gain and its cost.

Do not write: a figure from one chip. Do not write a trade-off that only one instance has.

### Why it works

Write: the optimum that physical limits create, for example a balance between wire delay and switching energy. Give the reason as cause and effect.

Do not write: a list of chips that use the structure. Do not write "it is faster" without the limit that makes it so.

### Failure conditions

Write: the change that moves the design away from its optimum, for example a new process, a longer wire, or a lower yield. Say what changes and what breaks.

Do not write: the bug of one chip. Do not write a failure condition that only one instance has.

## Evidence standard

Rank evidence from strongest to weakest. When two pieces of evidence disagree, trust the higher item.

1. Measured silicon data, which comes from a fabricated chip.
2. Simulation.
3. Paper claims.

Evidence does not set `strength`. It decides two other things on a hypothesis page.

- Role mapping: a "Fits?" cell has a value other than "unknown" only when a cited page supports the row. Otherwise write "unknown" and move the claim to "What to verify".
- Status: `supported` needs evidence from the top two ranks to resolve every "What to verify" row. A row that rests only on lower ranks stays open, so the status stays `testing` at most. `refuted` needs evidence from the top two ranks to refute one row.

## Strength rules

`strength` measures the kind of match that the hypothesis claims. Set it from these rules, not from evidence. Read each level by the `relation` of the page. Pick the highest level that the match meets. If it meets neither `structural` nor `mathematical`, use `surface`.

- `surface`: For an analogy, the words look alike, but the parts and the flows do not match one to one. For a stack, only a general dependency is known.
- `structural`: For an analogy, the parts and the flows match one to one. For a stack, each upper-layer part maps to named lower-layer components.
- `mathematical`: For an analogy, both sides follow the same equations or the same trade-off curve. For a stack, the equations or the trade-off curve of the lower layer define the behavior of the upper layer.

Compare trade-off curves only for designs built in a similar process, because area, power, and delay change with the process.

## Example

The slugs in this example are Latin for readability. A real Chinese wiki keeps CJK titles as CJK file names, as `schema.md` says.
This example uses domain words to show the lens. A real mechanism page uses domain-neutral words, as `schema/page-types/mechanism.md` says.

```markdown
---
type: mechanism
title: 分段並行處理
lenses: [hardware]
instances: [instruction-pipeline]
tags: [throughput]
related: []
sources: ["pipeline-tradeoffs-survey.md"]
created: 2026-01-15
updated: 2026-01-15
---
# 分段並行處理

一句話：把一件工作切成幾個階段，讓不同階段同時處理不同的工作。

## 組成

- 階段：只做整件工作的一小部分。
- 暫存單元：保存前一步留下的中間結果。
- 連線：負責連接的導線。
- 時鐘：給出同步節拍的來源。[[pipeline-tradeoffs-survey]]

## 流動

- 時鐘每跳一次，每個暫存單元就把保存的資料交給下一個階段。
- 階段處理資料，結果經連線送到下一個暫存單元。[[pipeline-tradeoffs-survey]]
- 同一時間，不同階段處理不同的工作項目。
- 每次時鐘跳動，所有暫存單元都消耗切換用的電力。

## 約束與取捨

- 階段越多，時鐘可以越快，代價是暫存單元增加面積和功耗。[[pipeline-tradeoffs-survey]]
- 吞吐量上升，代價是每個工作項目的延遲變長。
- 晶片做得越大，放得下的階段越多，代價是良率下降，可用成品變少。

## 為什麼有效

每個階段變短，時鐘就能變快。但暫存單元有固定的延遲，連線的延遲也不會消失。所以階段數有一個最佳點。超過最佳點，增加階段的開銷大於節省的時間。[[pipeline-tradeoffs-survey]]

## 失效條件

- 各階段耗時差很多時，最慢的階段限制整體速度。
- 後一個工作項目要用前一個的結果時，階段必須等待，吞吐量下降。[[pipeline-tradeoffs-survey]]
- 暫存單元的延遲接近階段本身的延遲時，增加階段沒有收益。

## 已知實例

- [[instruction-pipeline]] (hardware/processors): 指令管線
```
