# Lens: physics

## Purpose

This lens says what each mechanism field means in a physics domain. It also sets the evidence standard and the strength rules.
A physics domain studies matter, energy, and the laws that link them.
Use this lens in these cases:

- You read or write a page of a domain whose `lens` is `physics` in `domains.yaml`. Concept, entity, and source pages use only the Evidence standard. The Fields section applies to mechanism pages.
- You write a mechanism page that has a physics instance. Add `physics` to its `lenses:` list.
- You write a hypothesis page. The lens of `to_domain` sets the Strength rules and the Evidence standard. The lens of `from_domain` explains the parts of the mechanism.

## Fields

Each field is one section of a mechanism page. The lines below say what the field holds when the instance is in a physics domain.

### Parts

Write: one line for each degree of freedom or field. A degree of freedom is a quantity that can change on its own, for example a position or a phase. A field gives a value to every point in space.

Do not write: the name of a lab, a device, or a person. Do not write the energy or the interactions between parts.

### Flows

Write: how energy moves between the parts, and which interactions couple the parts, in order. Name each part by its name in Parts.

Do not write: a measured value or a number with a unit. Do not define a part again.

### Constraints and trade-offs

Write: the conservation laws that bind the mechanism. Name the approximation that the page states, and the scale where it holds. State each trade-off as a gain and its cost.

Do not write: a law that the mechanism does not use. Do not write the result of one experiment.

### Why it works

Write: the symmetry or the stable solution that makes the structure work, for example an equilibrium at a minimum of energy. Give the reason as cause and effect.

Do not write: a list of systems that show the effect. Do not write "nature prefers it" or any other claim without a reason.

### Failure conditions

Write: the change that moves the system out of the valid scale, or that breaks the symmetry or the stability. Say what changes and what breaks.

Do not write: the error of one experimental setup. Do not write a failure condition that only one instance has.

## Evidence standard

Rank evidence from strongest to weakest. When two pieces of evidence disagree, trust the higher item.

1. A reproduced experiment, which an independent group has repeated.
2. A single experiment.
3. A simulation.
4. A theory claim.

Evidence does not set `strength`. It decides two other things on a hypothesis page.

- Role mapping: a "Fits?" cell has a value other than "unknown" only when a cited page supports the row. Otherwise write "unknown" in the output language, and move the claim to "What to verify".
- Status: `supported` needs evidence from the top two ranks to resolve every "What to verify" row. It also needs at least one row. A row that rests only on lower ranks stays open, so the status stays `testing` at most. `refuted` needs evidence from the top two ranks to refute one row.

## Strength rules

`strength` measures the kind of match that the hypothesis claims. Set it from these rules, not from evidence. Read each level by the `relation` of the page. Pick the highest level that the match meets. If it meets neither `structural` nor `mathematical`, use `surface`.

- `surface`: For an analogy, the words look alike, but the parts and the flows do not match one to one. For a stack, only a general dependency is known.
- `structural`: For an analogy, the parts and the flows match one to one. For a stack, each upper-layer part maps to named base-layer components.
- `mathematical`: For an analogy, both sides follow the same equations or the same trade-off curve. For a stack, the equations or the trade-off curve of the base layer define the behavior of the upper layer.

Before you claim `mathematical`, check that both sides obey the same conservation laws in the same scale range.

## Example

The slugs in this example are Latin for readability. A real Chinese wiki keeps CJK titles as CJK file names, as `schema.md` says.
This example uses domain words to show the lens. A real mechanism page uses domain-neutral words, as `schema/page-types/mechanism.md` says.

```markdown
---
type: mechanism
title: 回復與耗散
lenses: [physics]
instances: [damped-oscillation]
tags: [stability]
related: []
sources: ["damped-systems-primer.md"]
created: 2026-01-15
updated: 2026-01-15
---
# 回復與耗散

一句話：回復場把系統拉回平衡，耗散場移走能量，所以系統最後靜止。

## 組成

- 偏離量：描述系統離開平衡有多遠的自由度。
- 回復場：把系統拉回平衡的場。
- 耗散場：使系統能量減少的場。[[damped-systems-primer]]

## 流動

- 偏離量不為零時，回復場對它施力，能量在兩種形式之間轉換。
- 偏離量越過平衡後，回復場把能量轉回原來的形式。
- 每個來回，耗散場帶走一部分能量。[[damped-systems-primer]]
- 能量減少後，偏離量的幅度跟著變小。

## 約束與取捨

- 能量守恆：系統損失的能量，等於耗散場帶走的能量。耗散越強，系統越快靜止，代價是回應變得遲鈍。[[damped-systems-primer]]
- 回復場和偏離量成正比的近似讓分析變簡單，代價是偏離量大時近似不再成立。

## 為什麼有效

平衡是能量最低的狀態。偏離量越大，回復場的拉力越強。耗散場不斷移走能量，系統不會一直來回。所以唯一穩定的解是靜止在平衡。[[damped-systems-primer]]

## 失效條件

- 偏離量大到超出近似成立的範圍時，描述失準。
- 耗散場接近零時，偏離量一直來回，不會靜止。[[damped-systems-primer]]
- 耗散場反過來向系統供能時，偏離量越來越大。

## 已知實例

- [[damped-oscillation]] (physics/mechanics): 阻尼振盪
```
