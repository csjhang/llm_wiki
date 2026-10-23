# Lens: ai

## Purpose

This lens says what each mechanism field means in an AI domain. It also sets the evidence standard and the strength rules.
An AI domain studies models, learning algorithms, and the systems that train and run them.
Use this lens in these cases:

- You read or write a page of a domain whose `lens` is `ai` in `domains.yaml`. Concept, entity, and source pages use only the Evidence standard. The Fields section applies to mechanism pages.
- You write a mechanism page that has an AI instance. Add `ai` to its `lenses:` list.
- You write a hypothesis page. The lens of `to_domain` sets the Strength rules and the Evidence standard. The lens of `from_domain` explains the parts of the mechanism.

## Fields

Each field is one section of a mechanism page. The lines below say what the field holds when the instance is in an AI domain.

### Parts

Write: one line for each layer, module, or kind of state. State is what the system keeps between steps, for example weights or a cache.

Do not write: a model name or a product name. Do not write the information or the gradients that move between parts.

### Flows

Write: how information, gradients, and tokens move between the parts, in order. Name each part by its name in Parts.

Do not write: a parameter count, a benchmark score, or a date. Do not define a part again.

### Constraints and trade-offs

Write: the limits of compute, memory, and data. State each trade-off as a gain and its cost.

Do not write: the cost of one training run. Do not write a trade-off that only one instance has.

### Why it works

Write: the inductive bias. An inductive bias is an assumption that the structure builds in, and that makes learning easier. Give the reason as cause and effect.

Do not write: a list of models that use the structure. Do not write "it works better" without the bias that explains it.

### Failure conditions

Write: when the bias does not fit the data or the task, or when compute, memory, or data runs out. Say what changes and what breaks.

Do not write: the failure of one training run. Do not write a failure condition that only one instance has.

## Evidence standard

Rank evidence from strongest to weakest. When two pieces of evidence disagree, trust the higher item.

1. A reproduced benchmark with an ablation. An independent group repeated it, and removed the claimed part to measure the change.
2. A single benchmark.
3. Paper claims.

Evidence does not set `strength`. It decides two other things on a hypothesis page.

- Role mapping: a "Fits?" cell has a value other than "unknown" only when a cited page supports the row. Otherwise write "unknown" and move the claim to "What to verify".
- Status: `supported` needs evidence from the top two ranks to resolve every "What to verify" row. A row that rests only on lower ranks stays open, so the status stays `testing` at most. `refuted` needs evidence from the top two ranks to refute one row.

## Strength rules

`strength` measures the kind of match that the hypothesis claims. Set it from these rules, not from evidence. Read each level by the `relation` of the page. Pick the highest level that the match meets. If it meets neither `structural` nor `mathematical`, use `surface`.

- `surface`: For an analogy, the words look alike, but the parts and the flows do not match one to one. For a stack, only a general dependency is known.
- `structural`: For an analogy, the parts and the flows match one to one. For a stack, each upper-layer part maps to named lower-layer components.
- `mathematical`: For an analogy, both sides follow the same equations or the same trade-off curve. For a stack, the equations or the trade-off curve of the lower layer define the behavior of the upper layer.

A match of layer names alone is `surface`, so compare what flows through the modules and what bias the structure builds in.

## Example

The slugs in this example are Latin for readability. A real Chinese wiki keeps CJK titles as CJK file names, as `schema.md` says.
This example uses domain words to show the lens. A real mechanism page uses domain-neutral words, as `schema/page-types/mechanism.md` says.

```markdown
---
type: mechanism
title: 捷徑相加
lenses: [ai]
instances: [residual-connection]
tags: [training]
related: []
sources: ["residual-shortcut-survey.md"]
created: 2026-01-15
updated: 2026-01-15
---
# 捷徑相加

一句話：模組只學習對狀態的修正，捷徑把狀態原樣送到後面。

## 組成

- 狀態：系統保存的中間資料。
- 模組：負責變換的單元。
- 捷徑：負責保留原樣的路徑。
- 合併點：負責合併的位置。[[residual-shortcut-survey]]

## 流動

- 狀態同時進入模組和捷徑。
- 模組輸出一個修正量，捷徑輸出原來的狀態，合併點把兩者相加。[[residual-shortcut-survey]]
- 合併後的結果成為下一個模組收到的狀態。
- 反向傳播時，梯度也走捷徑，直接回到前面的模組。

## 約束與取捨

- 捷徑不增加計算，代價是兩條路徑的形狀必須一致。[[residual-shortcut-survey]]
- 堆疊可以很深，代價是訓練時要保留每個模組的中間結果，記憶體隨深度增加。
- 容量變大，代價是需要更多資料，否則多出來的容量只會記住訓練資料。

## 為什麼有效

這個結構偏好「不改變狀態」的解。模組只需要學習一個小修正，不必重學整個變換。梯度也有一條不經過模組的直達路徑。所以很深的堆疊仍然可以訓練。[[residual-shortcut-survey]]

## 失效條件

- 模組的輸出遠大於捷徑送來的狀態時，結構對保留原狀的偏好消失。[[residual-shortcut-survey]]
- 兩條路徑的形狀不同，又沒有補上變換時，相加無法進行。
- 任務需要大幅改變狀態時，偏好保留原狀會拖慢學習。

## 已知實例

- [[residual-connection]] (ai/architecture): 殘差連接
```
