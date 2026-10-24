# SDD ledger — plan: docs/superpowers/plans/2026-10-23-sp0-template-skeleton.md

Spec: docs/superpowers/specs/2026-10-23-mechanism-wiki-heptabase-design.md (reachable)
Branch: design/heptabase-wiki. Plan start commit: ecae299. Baseline: 139 test files / 2063 tests pass; typecheck pass.

## Pre-flight scan

| Pair / task | Produces vs consumes | Finding |
|---|---|---|
| T1 -> T3 | T1 creates empty templates/mechanism-wiki/docs/glossary.md and AGENTS.md; T3 fills them | consistent |
| T2 -> T3 | T3 consumes parseDomainsYaml/parseHeptabaseYaml; T2 heptabase test uses inline YAML, T3 switches to the example file | consistent |
| T3 -> T4 -> T5 | shared contract test file grows; T4/T5 extend the STE list | consistent |
| T3 read-order test vs T4/T5 | T3 asserts every `<...>` path folder exists, but schema/page-types/ (T4) and lenses/ (T5) do not exist yet at T3 | CONFLICT -> Ruling R1 |
| T4 -> T5 | T5 lens field headings = MECHANISM_SECTIONS en values minus `instances` | consistent |
| T2 -> T5 | KNOWN_LENSES = business, physics, hardware, ai | consistent |
| T3/T4/T5 -> T6 | T6 loads all template files; test keys exist by then | consistent |
| T6 -> T7 | T7 consumes MECHANISM_TEMPLATE_FILES and mechanismTemplate.extraDirs | consistent |
| T1 self | ignore test needs real paths; T1 creates placeholders | consistent |
| T2 self | tests match signatures | consistent |
| T3 self | optional path (heptabase.yaml) skipped; CJK lines skipped by STE check | consistent apart from R1 |
| T4 self | examples are fenced, so STE check skips them; headings checked inside the fence text | consistent |
| T5 self | consistent | consistent |
| T6 self | glob outside src/ but tsconfig include is src only: the .ts file is in src, so typecheck is fine | consistent |
| T7 self | consistent | consistent |
| Rubric conflicts | no assert-nothing tests, no mandated duplication | none |

Ruling R1: T3's read-order test checks only concrete paths (no `<...>`, not optional). T5 adds the assertion that every `<...>` path names an existing folder. — Why: the folders appear in T4/T5; asserting earlier forces placeholder files. — Cost if wrong: one assertion lands two tasks later; low.

## Tasks
Task 1: dispatched (base ecae299, implementer sonnet)
Ruling R2: subagent commits carry the Co-Authored-By trailer of the model that did the work (its own session reminder), plus the same Claude-Session line. — Why: accurate attribution beats a uniform string. — Cost if wrong: trailer text differs across commits; cosmetic.
Ruling R3: plugin license is GPL-3.0-only. — Why: root LICENSE is stock GPLv3 with no "or later" grant. — Cost if wrong: one string in plugin.json and the test helper.
Task 1: minor (deferred): licenseSpdxId() can only return GPL-3.0-only, so the license assertion re-checks a constant (plugin-contract.test.ts:168-172)
Task 1: minor (deferred): "plugin manifest matches marketplace" test compares both to a literal, not to each other (plugin-contract.test.ts:205-217)
Task 1: minor (deferred): wiki/SKILL.md step 2/3 unclear whether the menu lists itself; step 5 does not say "invoke via the Skill tool"
Task 1: minor (deferred): ignore test covers two paths only; .claude/settings.json (sub-project 6) will hit the upstream .claude/ rule — add an exception then
Task 1: complete (commits ecae299..79b84af, review clean)
Task 2: dispatched (base 79b84af, implementer sonnet)
Ruling R4: accept extra src/lib/wiki-config/yaml-util.ts for shared YAML helpers. — Why: avoids duplicating load/unknown-key/UUID logic across two parsers. — Cost if wrong: one extra small file.
Ruling R5: accept implementer choices: wiki_id slug pattern ^[a-z0-9]+(?:-[a-z0-9]+)*$; missing domains/whiteboards/mechanism_library = empty/null; missing tags/properties = one issue; kind required; UUIDs lowercase only. — Why: consistent with spec examples. — Cost if wrong: an uppercase UUID from Heptabase would be rejected; Heptabase IDs observed are lowercase.
Task 2: minor (deferred): no regression tests for YAML-date-as-domains and __proto__ key handling; keyAt fallbacks untested; syntax-error tests do not assert line/column
Task 2: minor (deferred): parseWhiteboardIds and parseRoots repeat the same readUuid loop; readUuid uses "" as failure marker (easy to misread)
Task 2: minor (deferred): missing tags.ingest says "must be a lowercase UUID" while properties says "is required"; auto_ingest: null rejected while other nulls default
Ruling R6: keep exported type name `PropertyKey` in heptabase-config.ts (plan-mandated; shadows the TS global inside that module only). — Why: plan interface; no current conflict. — Cost if wrong: later code importing it may want an alias; trivial rename.
Task 2: complete (commits 79b84af..09c7fde, review clean)
Task 3: dispatched (base 09c7fde, implementer sonnet)
Ruling R7: keep the added 40-character limit for Chinese sentences in writing-rules.md rule 5. — Why: matches the short-sentence rule for wiki text. — Cost if wrong: one sentence to delete.
Task 3: review needs fixes (4 Important: sources format, hypothesis domain wording, STE version, output language)
Ruling R8: ASD-STE100 version string is "ASD-STE100, Issue 9 (2025)". — Why: spec 5.10 requires a version; Issue 9 is the current issue. — Cost if wrong: one string.
Ruling R9: output language outside the app comes from a new `Output language:` line in purpose.md; empty → ask the user. — Why: a fresh agent needs a source of truth; purpose.md is user-written. — Cost if wrong: one template line and two rule sentences.
Task 3: fix round 1 dispatched (resume implementer; fix base 383ba47)
Deferred to sp2 Task 1: CLAUDE.md/schema.md should name `wiki.yaml` `role` as the test for reading vs work wiki (reviewer minor).
Task 3: fix round 1/5 (10 addressed, 0 open; commits 383ba47..6c709f9)
Task 3: minor (deferred): CLAUDE.md rule 3 and schema.md:5 "If it is empty" — say "If that line is empty"
Task 3: minor (deferred): purpose.md top comment says replace each comment, but Output language comment says write after the label; example value may be misread as the value
Task 3: minor (deferred): writing-rules.md "your own notes" uses glossary term Note loosely; ".gitignore" sentence less clear than "outside this repository"; "This repository does not include the standard" uses "repository" in a copied wiki
Task 3: minor (deferred): schema.md ingest gloss says "the AI reads" while glossary Source says "the app reads"; actor words (agent / AI agent / the AI / the app) not pinned
Task 3: minor (deferred): test "glossary Domain agrees with schema.md" checks only the glossary half; items 5 and 9 have no assertion
Task 3: minor (deferred): 40-character Chinese limit (R7) unreviewed by a human — surface to user
Carried into Task 4: hypothesis `mechanism` field format (same-wiki bare slug; cross-wiki `reading:<slug>`) and which lens a hypothesis reads (the lens of `to_domain`)
Task 3: complete (commits 09c7fde..6c709f9, review clean after 1 fix round)
Task 4: dispatched (base 2281319, implementer sonnet)
Ruling R10: accept implementer rules in page-type files not in the spec: hypothesis status starts as draft; source_kind default; section length targets; comparison takes the domain of its main subject. — Why: consistent with spec intent; fills gaps a fresh agent would face. — Cost if wrong: edit one rule file.
Carried to sp5 Task 1: a work-wiki hypothesis `from_domain` may live in the reading wiki's domains.yaml; lint must check both lists.
Task 4: review needs fixes (3 Important: entity rename contradiction, mechanism Parts/Flows rules vs example, examples fail own checklists)
Ruling R11: never rename an existing file during ingest; only the new same-name page gets the `--<segment>` suffix; renames belong to wiki-recut. — Why: ingest writes whole files and cannot rename; avoids broken links. — Cost if wrong: two same-name pages keep asymmetric names until a recut.
Ruling R12: a claim counts as sourced when its section has at least one supporting `[[source-page]]` link. — Why: per-line citation is unrealistic; per-section keeps traceability. — Cost if wrong: weaker citation granularity; tighten later in lint.
Ruling R13: known-instance line form is `- [[<slug>]] (<domain>): <local term>` with ASCII punctuation. — Why: one parseable form for lint. — Cost if wrong: cosmetic in Chinese text.
Task 4: fix round 1 dispatched (resume implementer; fix base f9bd46a)
Ruling R14: the mechanism Known instances section and the one-line summary are exempt from R12 (section-level source link); each instance page carries its own sources. — Why: R13 line form has no room for a citation. — Cost if wrong: mechanism pages cite less; lint can follow instance links.
Task 4: fix round 1/5 (10 addressed, 0 open; commits f9bd46a..43392d0)
Task 4: minor (deferred): mechanism.md example "通道：傳遞訊息" uses 訊息 for 事件 and hints at an exchange in Parts
Task 4: minor (deferred): hypothesis.md "unknown" rule names only parts, not flows/constraints; one-line exemption not repeated in the Do-not rule and checklist
Task 4: minor (deferred): source.md mixes "summary page" and "source page"; `<domain>` in R13 line form undefined (full path); one-line `一句話：` prefix only for Traditional Chinese
Task 4: minor (deferred): purpose.md "Output language: Simplified Chinese" / "简体中文" maps to English headings (headingFor only knows the app value "Chinese") — usability
Task 4: minor (deferred): plan/brief text for sp0 Task 3 still says suffix on both file names (stale vs R11)
Folded into Task 5: align glossary Mechanism entry and schema.md Mechanisms section with heading names Parts / Flows / Constraints and trade-offs / Why it works / Failure conditions
Task 4: complete (commits 2281319..43392d0, review clean after 1 fix round)
Task 5: dispatched (base 43392d0, implementer sonnet)
Ruling R15: each lens Example is a full short mechanism page with frontmatter. — Why: lets the test check source links; spec 5.7 asks for a complete example. — Cost if wrong: longer lens files in prompts.
Carried to sp2 Task 2/3: lens loader must be fence-aware when it extracts `## Fields` (Example fences contain `## ` lines).
Task 5: review needs fixes (4 Important: evidence vs strength incl. stack, "each part" term clash, business Parts by exchange, hardware trade-off without gain)
Ruling R16: `strength` = kind of match (from Strength rules); evidence decides mapping-row "yes" vs "unknown" and status: supported needs all verify rows resolved by evidence from the top two ranks of the to_domain lens; refuted needs one row refuted at the top two ranks; stack has its own three-level definition. — Why: match type and proof level are different questions; mixing them makes grading inconsistent. — Cost if wrong: rewrite one rule block in five files.
Task 5: fix round 1 dispatched (resume implementer; fix base b187c99)
Ruling R16a: a verify row resting only on ranks below the top two stays open (covers four-rank lenses); a mapping row needs a cited page for any value other than unknown. — Why: consistent with 'supported needs the top two ranks'. — Cost if wrong: wording only.
Task 5: fix round 1/5 (9 addressed, 0 open; commits b187c99..9d1ce68)
Task 5: minor (deferred, worth fixing): stack "lower layer / upper layer" not tied to from_domain / to_domain; glossary says "base layer"
Task 5: minor (deferred, worth fixing): glossary "Analogy strength" entry covers analogy only; strength now also has a stack reading
Task 5: minor (deferred): hypothesis.md:26 "Rules has the conditions for the other values" (no draft→testing rule); "field" means a section and a frontmatter field in the same files
Task 5: minor (deferred): lens role-mapping bullet says write "unknown" without "in the output language"; "lower ranks" vs "ranks below the top two"; item-4 test cannot catch a gainless trade-off; ai.md 合併點 line restates its name
Task 5: minor (deferred): "supported" is reachable with zero verify rows (R16 wording)
Task 5: complete (commits 43392d0..9d1ce68, review clean after 1 fix round)
Task 6: dispatched (base 9d1ce68, implementer sonnet)
Task 6: minor (deferred): apply-template test "creates a parent that is also an extraDir only once" does not exercise the overlap; no end-to-end test of the real template through applyTemplate; no runtime guard if the glob returns nothing; half-built project on a mid-way write failure; Rust still creates wiki/synthesis
Carried to sp6 Task 5: import.meta.glob may skip dotfiles; extend the glob for .claude/settings.json and assert it in a test
Task 6: complete (commits 9d1ce68..7ca8da2, review clean)
Task 7: dispatched (base 7ca8da2, implementer sonnet)
Task 7: minor (deferred, decide before sp1): materializeSampleWiki copies the sample README.md into the wiki root
Task 7: minor (deferred): "is deterministic" test compares only the file tree; sample README overstates ("finished wiki"); materialize test does not assert schema.md / AGENTS.md; source listing assertion hard-codes three names; async source "Other properties" is a one-sentence stub; duplicate temp-dir helper (src/test-helpers/fs-temp.ts exists)
Task 7: complete (commits 7ca8da2..66aa7aa, review clean)
Final review (opus): With fixes — 0 Critical, 5 Important (SP4 check vs hypothesis example; when to create a mechanism page; hypothesis domain assumed by SP2/3/5; reading vs work wiki signal; output language not written to purpose.md)
Ruling R17: in a stack hypothesis, from_domain is the base layer and to_domain is the upper layer; use the glossary term "base layer". — Why: mechanism knowledge flows from the base layer up. — Cost if wrong: swap two words in five files.
Ruling R18: draft → testing when at least one verify row links a query page with evidence; supported needs ≥ 1 verify row. — Why: makes status deterministic and lintable. — Cost if wrong: adjust one rule.
Ruling R19: for indexes, lint, and Heptabase, a hypothesis page's domain is its to_domain. — Why: SP2/3/5 need one domain per page. — Cost if wrong: hypotheses grouped under the target domain only.
Ruling R20: fix the final-review findings that touch SP0 files now (template text, small code) in one wave, including several the reviewer scheduled "later", because the next touch of those files would otherwise be a prompt-pasting sub-project. Plan amendments I do myself. — Cost if wrong: a larger fix wave.
Final fix wave: dispatched (fix base 66aa7aa, implementer sonnet)
Final fix wave: commits d466c1f (controller plan amendments) and e84518c..a47cdb8 (fixes A1–A14, B1–B5, C1–C4); 2234 tests pass
Ruling R21: accept the fix agent's two extra edits (lens Status line requires ≥ 1 verify row; removed the hypothesis.md "read the lenses in the lenses field" fallback that contradicted A8). — Why: keeps lenses and hypothesis.md consistent. — Cost if wrong: two sentences.
Carried to sp2 Task 3: language aliases (繁體中文, zh-TW, zh-Hant, 简体中文, zh-CN, zh-Hans) live only in template text; if code reads `Output language:` from purpose.md, add a code mapping next to headingFor.
Final fix: minor (deferred): stale comment "wiki-hepta init" in mechanism-template-contract.test.ts:244; no component test for the dialog's applyTemplate call
Final fix wave: re-review — all 23 findings ADDRESSED, no new Critical/Important. Minor: mechanism.md Parts "通道：負責傳遞" uses an EXCHANGE_WORDS word (folded into sp2 Task 1); A1 wording vs work wiki (folded into sp2 Task 1); hypothesis.md:73 "stays testing" wording; plan sp4 stricter than template (aligned in plan now).
SUB-PROJECT 0: COMPLETE (ecae299..a47cdb8 plus plan alignment). Workspace kept until the end of the run so the final message can list every ruling.
