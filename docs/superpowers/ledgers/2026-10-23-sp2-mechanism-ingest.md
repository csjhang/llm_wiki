# SDD ledger — plan: docs/superpowers/plans/2026-10-23-sp2-mechanism-ingest.md

Spec: docs/superpowers/specs/2026-10-23-mechanism-wiki-heptabase-design.md (reachable). Branch: design/heptabase-wiki. Depends on SP0 (template, parsers, section headings, sample wiki) and SP1 (git commit per ingest).

## Pre-flight scan

| Pair / task | Produces vs consumes | Finding |
|---|---|---|
| T1 -> T2 | parseWikiYaml, WikiIdentity, page types | consistent |
| T2 -> T3 | MechanismContext, LensDoc.promptText, lensForDomain | consistent |
| T3 -> T4 | T3's buildGenerationAddendum consumes `AnalysisDecisions`, which T4 defines | CONFLICT -> Ruling P1 |
| T3/T4 -> T7 | buildScopedIndexText and listMechanismSlugs are stubbed until T7 | consistent (plan says so) |
| T4 -> T5 | enforceMechanismRules consumes AnalysisDecisions | consistent |
| T5 -> T8 | new ReviewItem types added in T5, actions in T8 | consistent |
| T6 self | early return must give a written path, but Fingerprint stores only the raw sourcePath | gap -> Ruling P2 |
| T6 <-> SP1 | a skipped duplicate writes nothing; commitIngest returns null | consistent |
| T8 self | `mech:replace-source` overwrites a raw source, while CLAUDE.md says do not edit raw/ | design -> Ruling P3 |
| T9 self | consumes everything | consistent |
| ingest.ts | modified by T3, T4, T5, T6, T7, T9 in sequence | consistent (sequential) |
| carried SP0 item | language aliases in code: no code reads `Output language:` from purpose.md; prompts use the app OutputLanguage | not needed |
| Rubric conflicts | none | none |

Ruling P1: T3 creates `src/lib/mechanism-wiki/types.ts` with `MechanismDecision` and `AnalysisDecisions` (exact shapes from T4's Interfaces) and an `emptyDecisions(domain: string | null)` helper. T3's ingest hook passes `emptyDecisions(hintDomain)` to buildGenerationAddendum; T4 replaces it with the parsed decisions. — Why: T3 needs the type before T4 exists. — Cost if wrong: one moved type.
Ruling P2: `Fingerprint` adds `summaryPath: string | null`, recorded after a successful ingest from the written `wiki/sources/` path. On a duplicate hit, return `[summaryPath]`; when it is null, compute the summary path with the same helper the ingest uses for `sourceSummaryPath`. Never return a raw/ path as written. — Why: written files feed cancel cleanup and git commits. — Cost if wrong: one extra field.
Ruling P3: `mech:replace-source` stays (a user-approved app action, not an agent edit); the old text remains in git history (SP1). — Why: the user chose the newer copy. — Cost if wrong: one review option to drop.

## Tasks
Task 1: dispatched (base dee60a0, implementer sonnet)
Task 1: implementer agent a0ac0d7797158f3c3
Task 1: implementer DONE_WITH_CONCERNS, commit 927373e (vitest 2411 pass, typecheck ok)
Ruling P4: GENERATION_WIKI_TYPES now lists mechanism and hypothesis for every project (the ingest generation prompt reads it). Task 3 (which adds the mechanism context to ingest.ts) filters those two out of the prompt's known-types list when the project is not a mechanism wiki. — Why: global constraint "every new code path is guarded by domains.yaml"; Task 1 has no project context. — Cost if wrong: until Task 3, plain wikis see two extra type names in the prompt.
Ruling P5: accept the concept.md "In a work wiki, send a new-mechanism review item instead." addition and the Parts line "通道：連接各個部分的路徑。". — Why: concept.md has the same sentence; the contract test covers it. — Cost if wrong: one sentence.
Task 1: review dispatched (sonnet)
Task 1: review Approved (0 Critical, 0 Important). Controller fixed Minor 1 (concept.md rule lacked the work-wiki exception) and Minor 2 (role sentence placement and STE split) in a follow-up docs commit.
Task 1: minor (deferred): wiki-identity test title overstates coverage; contract "wiki identity" tests partly overlap the generic guard; nothing reads wiki.yaml until Task 2; a work wiki gets role: work only by hand edit (template ships role: reading) — note for SP6/README.
Task 1: complete (commits dee60a0..2c580d4, review clean)
Task 2: dispatched (base 2c580d4, implementer sonnet)
Task 2: implementer agent ac7cdf64237490538
Task 2: implementer DONE, commit 1f00738 (vitest 2438 pass)
Task 2: review dispatched (sonnet)
Ruling P6: MechanismContext gains `identityStatus: "ok" | "missing" | "invalid"`, and context.ts exports `canWriteMechanismPages(ctx): boolean` = `identity.role === "reading" && identityStatus !== "invalid"`. Tasks 3–5 use it, not `identity.role`, to decide between writing wiki/mechanisms/ files and sending new-mechanism review items. A missing wiki.yaml (wikis made before this sub-project) still counts as a reading wiki. — Why: an invalid work-wiki wiki.yaml would otherwise fall back to reading and write mechanism pages into the work wiki (spec: mechanism pages live only in the reading wiki). — Cost if wrong: a reading wiki with a broken wiki.yaml sends review items until the file is fixed.
Ruling P7: accept the `extractLensPromptText` export, `<file>:<key>` issue paths, a fence-aware splitter local to context.ts, and the empty-lens issue. — Why: small, tested. — Cost if wrong: none.
Task 2: review needs fixes (1 Important: unreadable domains.yaml returns null; plus P6)
Task 2: fix round 1 dispatched (resume implementer; fix base 1f00738)
Task 2: fix round 1/5 implementer DONE (commit cbccf85, vitest 2446); scoped re-review dispatched (sonnet)
Task 2: fix round 1/5 (4 addressed, 0 open; commits 1f00738..cbccf85)
Task 2: minor (deferred): a throwing fileExists counts as absent (domains.yaml → plain wiki); path resolver and section splitter could move to shared utils later; a stray `# ` heading after Strength rules joins promptText
Task 2: complete (commits 2c580d4..cbccf85, review clean after 1 fix round)
Task 3: dispatched (base cbccf85, implementer sonnet)
Task 3: implementer agent aae5841a4cc3c76a0 (carries P1, P4, P6)
Task 3: implementer DONE_WITH_CONCERNS, commit aa1def5 (vitest 2497 pass, typecheck ok)
Ruling P8: Task 4's parser reads the last heading named "Decisions" at level 2 or 3 (`## Decisions` or `### Decisions`); the section ends at the next heading of the same or a higher level. — Why: the chunked long-source path returns decisions as a `### Decisions` subsection of the final digest, and its two-section format cannot hold a top-level `## Decisions`. — Cost if wrong: a stray `### Decisions` inside a quoted source could be read (mitigated: last one wins).
Ruling P9: section headings use the same `getOutputLanguage(sourceContent)` value as the upstream language directive. — Why: headings must match the prose language of the page; a user who wants Traditional Chinese sets it in project settings. — Cost if wrong: with "auto", headings follow the detected language (may be Simplified for some sources).
Ruling P10: accept domainHintFromSource(sourceContent, ctx), the hook placed after the cache-hit return, BASE_GENERATION_WIKI_TYPES, the sync scoped-index stub (Task 7 adds an await), and the extractLensFieldsText export. — Why: each follows from the code. — Cost if wrong: small.
Task 3: review dispatched (sonnet)
Task 3: review needs fixes (1 Important: chunk Decisions at digest tail are truncated first)
Task 3: minor (deferred): the long-source checkpoint is not keyed on the mechanism addendum (a resumed digest can carry DOMAIN lines from an old domain list); the existing-mechanism instruction asks for a FILE block for a page the model has not seen (Task 5 merge must reduce it to one Known-instances line); parseReviewBlocks coerces unknown REVIEW types to confirm (Task 5 must add new-mechanism); stableContextLength uses index.length, not promptIndex (over-reserves after Task 7)
Task 3: fix round 1 dispatched (resume implementer; fix base aa1def5)
Task 3: fix round 1/5 implementer DONE_WITH_CONCERNS (commit 398aa9d, vitest 2502)
Ruling P11: in Task 4, `decisions.mechanisms` holds only valid parsed lines and `problems` describes dropped lines. buildGenerationAddendum then always lists the valid mechanisms; when problems is non-empty it adds "Some analysis decision lines were invalid and were dropped. Write or update mechanism pages only for the lines listed here." instead of blocking all mechanism writes (Task 3 fix round 1 blocks them). — Why: one bad NEW-DOMAIN line must not discard every good MECHANISM line. — Cost if wrong: a bad parse could still write the valid mechanisms it found.
Task 3: scoped re-review dispatched (sonnet)
Task 3: fix round 1/5 (6 addressed, 0 open; commits aa1def5..398aa9d)
Task 3: complete (commits cbccf85..398aa9d, review clean after 1 fix round)
Task 4: dispatched (base 398aa9d, implementer sonnet; carries P8, P11)
Task 4: implementer agent ab2c3ce00bb4862d2; existing-mechanism set passed as a 4th param loaded by an async stub (Task 7 replaces)
Task 4: implementer DONE_WITH_CONCERNS, commit 56bf536 (vitest 2557 pass)
Ruling P12: accept — the stub lives in decisions.ts; an unlisted DOMAIN proposal gets description "Part of <ancestor>: <ancestor description>"; a `new:` slug that already exists stays `new:` (upstream page-merge merges it into the existing page); on the chunked path the last Decisions heading may come from a per-chunk analysis (the chunk prompt forbids it). — Why: each follows the brief or upstream behavior. — Cost if wrong: an odd default description the user edits on approval.
Ruling P13: an existing mechanism page that the generation rewrites goes through upstream `mergePageContent` (LLM merge, old content kept), not a deterministic one-line append. — Why: upstream already merges every existing page; a separate merge path doubles the code. — Cost if wrong: a merge may reorganize a mechanism page; git history (SP1) keeps the old version and wiki-undo can revert.
Task 4: review dispatched (sonnet)
Task 4: review Approved (0 Critical, 0 Important). Controller fixed Minor 1 (warn noise) in 80dffbe.
Task 4: minor (deferred): slug has no length cap and allows Windows-reserved names (con, nul) — carried to Task 5 writer guard; P11 sentence also shows for gap-type problems (no Decisions section) where nothing was dropped; reservedChars ignores per-mechanism lines (12k instruction reserve absorbs a few); the .md-stem stub duplicates context.ts listMarkdownFiles (Task 7 removes it)
Task 4: complete (commits 398aa9d..80dffbe, review clean)
Ruling P14: enforceMechanismRules also converts REVIEW blocks of type new-mechanism in the generation text: it removes each from the text and returns a new-mechanism review (same options as rule 3, body as description). Rule 3 tests `!canWriteMechanismPages(ctx)` (P6), not role === "work". Upstream parseReviewBlocks stays unchanged. — Why: parseReviewBlocks coerces unknown types to confirm with Approve/Skip, which would lose the mech:propose-mechanism action. — Cost if wrong: one extra pass over the text.
Task 5: dispatched (base 80dffbe, implementer sonnet; carries P6, P14)
Task 5: implementer agent a907ac69b59e03b91
Controller: regenerated briefs from the plan; task-6 and task-7 briefs now carry the SP1 carry-over text (stale-fingerprint check + summaryPath; index writes tracked + wiki/indexes/ aggregate path). Briefs 1–5, 8, 9 unchanged.
Task 5: implementer DONE_WITH_CONCERNS, commit f06f61c (vitest 2597 pass)
Ruling P15: hypothesis pages (`wiki/hypotheses/` or `type: hypothesis`) never get a `domain` from rule 2 (ruling R19: they carry from_domain/to_domain). Fix in Task 5 fix round 1. — Why: spec R19. — Cost if wrong: none.
Ruling P16: accept — an existing but unlisted `domain` is replaced by the decided one; a mechanism page under a proposed-only domain gets the proposal's lens; enforcement also runs on the truncation-repair output and drops an unfinished wiki/mechanisms/ block where mechanism writes are not allowed. — Why: each closes a bypass or follows the rule's intent. — Cost if wrong: a page's odd domain is overwritten (the review shows the decided domain).
Task 5: review dispatched (sonnet)
Task 5: review Approved (0 Critical, 0 Important); controller fix round 1 for P15 + routing-by-type bypass + one new-domain review + trace for a dropped truncated block
Task 5: minor (deferred): CRLF generation with one edited block emits mixed line endings (writeFileBlocks re-normalizes); garbage-in frontmatter edge cases (unterminated frontmatter, quoted keys, `--- # comment` fence)
Task 5: fix round 1 dispatched (resume implementer; fix base f06f61c)
Task 5: fix round 1/5 implementer DONE (commit d447163, vitest 2608); scoped re-review dispatched (sonnet)
Task 5: fix round 1/5 (4 addressed, 0 open; commits f06f61c..d447163)
Task 5: minor (deferred): index.md/log.md/overview.md with `type: mechanism` would be classed as a mechanism page (harmless in practice)
Carried to Task 8: `(incomplete)` new-mechanism reviews reach mech:propose-mechanism with partial content — the handler marks the proposal `incomplete: true` in frontmatter and keeps the "(incomplete)" title.
Task 5: complete (commits 80dffbe..d447163, review clean after 1 fix round)
Ruling P17: the duplicate-source review has description lines `EXISTING: <older raw source path>` and `NEWER: <newer raw source path>` (plus a one-line human summary), affectedPages [existing summaryPath], options [{label:"Use the newer text", action:"mech:replace-source"}, {label:"Skip", action:"Skip"}]. On a hit the new path's fingerprint is recorded pointing at the existing summaryPath. Fingerprint file writes are serialized per project (module-level promise chain). — Why: Task 8's handler needs both paths; parallel ingests (history off) would race on the JSON file. — Cost if wrong: a field format Task 8 must match.
Task 6: dispatched (base d447163, implementer sonnet; carries P2, P17, stale-fingerprint rule)
Task 6: implementer agent ad1e23b9b786b4af3
Task 6: implementer DONE_WITH_CONCERNS, commit 229a4d7 (vitest 2650 pass)
Ruling P18: a text hit is Jaccard ≥ 0.85 OR (the shorter sample has ≥ 1,000 normalized characters AND ≥ 0.9 of its shingles appear in the longer sample). — Why: with Jaccard alone a copy that is ≥ 20% longer can never score ≥ 0.85 inside the 4,000-character sample, so spec 6.3 step 4 (newer, more complete version → duplicate-source review) would fire only on URL matches; Heptabase cards have no URL. — Cost if wrong: a long article that contains a whole shorter note is skipped as its duplicate (the review lets the user pick the newer text).
Ruling P19: spec 6.3 step 3 ("在既有的來源頁記下另一個入口") — the brief dropped it. On a hit, add the new raw source path to the existing summary page's frontmatter list `also_from` (line-level edit, no duplicates, other bytes kept); the ingest returns that summary path as written so git history commits it. — Why: the spec is binding. — Cost if wrong: one extra frontmatter key on source pages.
Ruling P20: accept — recordFingerprint 4th arg, summaryPathForSource and checkDuplicateSource exports, skip a fingerprint whose summary page is the source's own page. — Why: needed by Task 8 replace-source. — Cost if wrong: none.
Task 6: review dispatched (sonnet); P18 and P19 go into fix round 1 with the review findings
Task 6: review Approved with one controller decision (Important: body-derived URL alone causes false duplicate skips, plan-mandated)
Ruling P21: a URL alone is a duplicate only when it comes from frontmatter `url`/`source`; a body-derived URL match also needs text score ≥ 0.5. — Why: clipped pages often start with a site link; a silent skip loses a different article. — Cost if wrong: a body-URL-only copy with rewritten text is ingested twice (lint later flags the duplicate).
Task 6: minor (deferred): lookUp re-shingles every stored sample per ingest (fine for hundreds of sources); a revision changed only past the 4,000-character sample and < 20% longer is skipped silently (spec-forced); the fingerprint file write is not atomic (no rename helper in @/commands/fs)
Task 6: fix round 1 dispatched (resume implementer; fix base 229a4d7; P18, P19, P21 + minors 1, 2, 4, 5)
Task 6: fix round 1/5 implementer DONE (commit c409151, vitest 2678); accepted stricter P21 reading (mixed frontmatter/body URL pair needs text ≥ 0.5); scoped re-review dispatched (sonnet)
Task 6: fix round 1/5 (7 addressed, 0 open; commits 229a4d7..c409151)
Task 6: minor (deferred): `also_from: [a,]` (hand-written trailing comma) becomes invalid YAML on append; the fingerprint JSON write is outside the run's tracked paths (benign, .llm-wiki/ is never committed); a full rewrite of the first source's summary page may drop also_from unless the merge unions it
Task 6: complete (commits d447163..c409151, review clean after 1 fix round)
Task 7: dispatched (base c409151, implementer sonnet)
Task 7: implementer agent a25bfaccefdb7c2eb (also replaces Task 3 scoped-index stub and Task 4 slug stub)
Task 7: container restart stopped the implementer mid-task (uncommitted work intact); resumed the same agent
Task 7: implementer DONE_WITH_CONCERNS, commit 37fc24f (vitest 2723 pass)
Ruling P22: accept — `wiki/indexes/` in the shared isAppManagedAggregatePath (a plain wiki rarely writes there; the brief mandates it); two page scans per ingest; optional onFileWritten 3rd param on rebuildDomainIndex; overview "Recently Updated" and embeddings skip wiki/indexes/; "1 pages" literal. — Why: brief-mandated or safer. — Cost if wrong: a plain wiki page under wiki/indexes/ is treated as app-managed.
Task 7: review dispatched (sonnet)
Task 7: review needs fixes (1 Important: review-suggestion stage still reads the raw wiki/index.md)
Task 7: minor (deferred): chat and deep-research prompts read wiki/index.md, which in a mechanism wiki is now the root domain tree only (later sub-project or final review); a work wiki's root index says "Mechanisms — 0 pages" while its mechanisms live in the reading wiki
Task 7: fix round 1 dispatched (resume implementer; fix base 37fc24f)
Task 7: fix round 1/5 implementer DONE (commit 80c71bb, vitest 2733); scoped re-review dispatched (sonnet)
Task 7: fix round 1/5 (5 addressed, 0 open; commits 37fc24f..80c71bb)
Task 7: minor (deferred): the mechanism index in prompts is unbounded (boundWikiIndexForPrompt still caps downstream)
Task 7: complete (commits c409151..80c71bb, review clean after 1 fix round)
Ruling P23: Task 8 handler details — `mech:propose-mechanism` derives the file slug from the review title with the decisions SLUG rules (kebab-case or CJK, ≤ 80 characters, no path separators; fallback `proposal-<short hash>`), never overwrites an existing proposal (adds `-2`, `-3`), and for an `(incomplete)` title adds frontmatter `incomplete: true`; a null or missing library path → throw a clear error the view shows. `mech:replace-source` reads the `EXISTING:` and `NEWER:` lines (P17), both must resolve inside `raw/sources/` of this project, copies the newer text over the older file, and keeps the newer file. — Why: path safety and P17's encoding. — Cost if wrong: an odd proposal file name.
Task 8: dispatched (base 80c71bb, implementer sonnet; carries P3, P17, P23)
Task 8: implementer agent a4c8e24bae6e30267
Task 8: implementer DONE_WITH_CONCERNS, commit b72d2f9 (vitest 2780 pass)
Ruling P24: accept — optional `reingest` in ReviewActionContext (the watcher ignores app writes, so replace-source queues the re-ingest itself); replace-source byte-copies and requires the same extension; propose-mechanism writes only the body under its own frontmatter and throws when wiki.yaml is invalid; saveResearchPage and SLUG exports. — Why: each is safer than the brief's wording. — Cost if wrong: one optional field.
Task 8: review dispatched (sonnet); controller adds to the fix round: an accepted research page must be indexed for search the same way deep-research does for a direct write
Task 8: review needs fixes (1 Important: an unclosed-frontmatter proposal can carry the work wiki's sources path into the reading library)
Task 8: minor (deferred): research panel keeps savedPath at the staging file after accept ("Open" fails silently); a staged file is orphaned if the project closes in the tiny window before the card is added; no test of the review-view wiring
Task 8: fix round 1 dispatched (resume implementer; fix base b72d2f9)
Task 8: fix round 1/5 implementer DONE_WITH_CONCERNS (commit e82112e, vitest 2794); accepted: lines mentioning raw/sources/ are dropped from proposals even in prose; scoped re-review dispatched (sonnet)
Task 8: fix round 1/5 (6 addressed, 0 open; commits b72d2f9..e82112e)
Task 8: minor (deferred): the deep-research call site of indexResearchPage has no direct test (executeResearch is not exported); warn label says [DeepResearch] for accept-research; the unclosed-frontmatter strip stops at an interior blank line or comment (raw/sources/ line rule covers the realistic case)
Task 8: complete (commits 80c71bb..e82112e, review clean after 1 fix round)
Task 9: dispatched (base e82112e, implementer sonnet)
Task 9: implementer agent afa452991c6b336d9
Task 9: implementer DONE, commit 2910bd7 (vitest 2802 pass; E2E found no integration gap; mutation check fails as expected)
Ruling P25: accept the same root-schema fix in executeIngestWrites. Park the design gap "interactive chat ingest (startIngest → executeIngestWrites) has no mechanism behavior (no domain/mechanism prompts, enforcement, duplicate check, domain index, fingerprints)" for the final review and the user. — Why: whether the guided chat ingest should carry the mechanism pipeline is a product decision; the main ingest path (queue/autoIngest) has it. — Cost if wrong: pages written through chat ingest in a mechanism wiki lack domains until lint (SP5) flags them.
Task 9: review dispatched (sonnet)
Task 9: review Approved (0 Critical, 0 Important)
Task 9: minor (deferred → final fix wave): page-merge UNION_FIELDS lacks instances/lenses/also_from, so a second domain's update of a mechanism page depends on the LLM merge to keep instances; the E2E canned merge already lists both instances, so it cannot catch a lossy merge; unused `subject`/MERGED_MECHANISM_PAGE_SLUG in the E2E; autoIngest reads root-only schema.md/purpose.md while chat ingest now falls back to wiki/
Task 9: complete (commits e82112e..2910bd7, review clean)
All SP2 tasks complete. Final whole-branch review: range dee60a0..2910bd7
Final review: dispatched (opus, package review-dee60a0..2910bd7.diff)
Final review: STOPPED by the controller at the user's request (token budget) before it reported. On resume: re-dispatch the final review (opus) with the same package review-dee60a0..2910bd7.diff and the same prompt, then ONE fix wave (include the Task 9 deferred UNION_FIELDS item), one scoped re-review, then start SP3 Task 1.
PAUSED 2026-10-24 at the user's request. Branch pushed through 5cdfbed.
RESUMED 2026-10-24T04:34Z (scheduled). Final review: resumed the stopped opus agent with its context (cheaper than a fresh dispatch)
Final review (opus): With fixes — 0 Critical, 6 Important (1 merge drops instances/lenses/also_from; 2 generation lacks the decided domain's index when the source has no domain hint; 3 spec 5.5 same slug across domains merges into one page; 4 privacy: proposals carry work instances/wikilinks; 5 work-wiki chat ingest can write mechanism pages; 6 longer copy past the 4,000-char sample skipped silently), 7 Minor.
Ruling T15 (SP2 final): fix Important 1–6 plus Minor 1 (new-domain REVIEW blocks) and the Windows-reserved/length slug check in ONE wave (final-fix-findings.md). — Why: data loss, privacy, and a G1 regression; all small. — Cost if wrong: one more dispatch.
Ruling T16: defer Minor 2 (spec 6.6 "use an existing domain" option for new-domain reviews) to SP6 (review UI); Minor 3 (work-wiki scans the whole library) and Minor 4 (prompt growth from mechanism.md and lens Fields) to the end-of-branch review; Minor 5 (second proposal with the same title overwrites the pending one) and Minor 6 (upstream review create-page/save paths ignore mechanism rules) to SP5 lint, which flags pages without domain. Accept Minor 7 (chat ingest reads root schema.md/purpose.md in plain wikis too) as an intended plain-wiki change matching the Rust agent. — Why: none loses data. — Cost if wrong: small UX gaps until then.
Final fix wave: dispatched (fix base 837997e, implementer sonnet — well-specified items; opus reserved for the re-review only if needed)
Final fix wave: commits 60dbd2d, 0a78997, f16137d, fc24301 (vitest 2854 pass, typecheck ok)
Ruling T17: accept fix-wave choices — full-path suffix uses `--` per `/` (spec 5.5 form); wiki/sources/ pages are never renamed (fixed summary path); any different non-null domain counts as a collision; a new-domain block for an already listed or proposed domain is dropped; the merge fallback keeps both instances in frontmatter while the body keeps only the incoming Known-instances lines (upstream fallback contract; SP5 lint can compare frontmatter instances with the section); reading-wiki chat ingest unchanged (P25). — Why: spec forms and upstream contracts. — Cost if wrong: a mechanism page body can miss an instance line after a failed LLM merge until lint flags it.
Final fix wave: scoped re-review dispatched (sonnet)
Final fix wave: scoped re-review clean (8 addressed; Minor (deferred): a suffixed target held by a no-domain page counts as free and the full-path fallback is not map-checked; stableContextLength still uses the hint index when the decided domain differs (bounded by the stable reserve); an `existing:` slug over 80 chars on a hand-named library page is rejected)
Ruling T18: park `src/lib/dedup.ts` FIELDS_TO_UNION (sources, tags, related) for SP5 — a user-confirmed duplicate merge of two mechanism or source pages would drop instances/lenses/also_from; SP5's wiki-lint files duplicates and recut merges, so it adds the three fields there with a test. — Why: dedup is a separate user-triggered path. — Cost if wrong: until SP5, merging two mechanism pages through the duplicate review loses one page's instance list (git keeps it).
SUB-PROJECT 2: COMPLETE (commits dee60a0..fc24301)
