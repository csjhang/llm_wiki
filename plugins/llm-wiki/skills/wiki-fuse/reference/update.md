# Update mode

Use these steps for `/wiki-fuse --update <hypothesis>`.
The new evidence is in the query pages of `wiki/queries/`. The goal is to re-evaluate each row under "What to verify" and to update the page.
`SKILL.md` has the rules and the command lines. Read it first.

## Steps

1. Find the hypothesis page. `<hypothesis>` is a slug, a title, or a path. Search `wiki/hypotheses/`. If more than one page matches, ask the user.
2. Read `CLAUDE.md` of the wiki. Read the page. Note `status`, `strength`, `updated`, and the rows under "What to verify".
3. Read the lens of `to_domain`. Its Evidence standard ranks the evidence. Read the Do list of `schema/page-types/hypothesis.md` for the rules of `status`.
4. Find the query pages that matter. A query page matters in these cases:
   - The hypothesis page links it.
   - It links the hypothesis page.
   - Its `updated` date, or its `created` date, is later than `updated` of the hypothesis page.
5. Use `grep -l '\[\[<slug>\]\]' wiki/queries/*.md` to find the query pages that link the hypothesis. Read the dates in the frontmatter. Do not use the date of the file.
6. If no query page matters, tell the user. Stop. Offer to run Step 9 of `directed.md` for rows that have no review item.
7. Read each query page that matters. Note which row it speaks to, what it found, and which sources it cites.
8. Rank the evidence of each query page with the Evidence standard of the lens. Read the sources that it cites.
9. Re-evaluate each row under "What to verify". Use one of these results:
   - Open: no evidence, or evidence from lower ranks only.
   - Resolved: evidence from the top two ranks supports the claim.
   - Refuted: evidence from the top two ranks disproves the claim.
10. Update the table. Link the query page in the "Evidence needed" cell of the row. Write the result after the link in one sentence. Keep the "How to refute" cell.
11. Update the mapping rows that the new evidence changes. A "Fits?" value changes only when a cited page supports the new value. Update "Gaps and impact" to match.
12. Add a new row under "What to verify" for each new claim that has no page. Keep the "How to refute" cell filled.
13. Set `status` by the Do list of `schema/page-types/hypothesis.md`. Use the results of step 9 and the ranks of step 8.
14. `fuse check` follows the rule file. `refuted` needs one row that links an evidence page, and the other rows can have no link. `supported` needs a link in every row. If a row of a `supported` page has no page, do not link an unrelated page to pass the check. Keep the status `testing`. Tell the user which row blocks the status.
15. Do not change `strength` because of evidence. Change it only when the role mapping itself changed. Then follow the Strength rules again, as Step 6 of `directed.md` says.
16. Set `updated` to today.
17. Run `fuse check` until the page passes.
18. Run `fuse commit` with the title `update <title>`. Give `--file` for the hypothesis page. The subject is `fuse: update <title> (1 pages)`.
19. Run the Down steps of `wiki-sync` for the page, as Step 8 of `directed.md` says. Run the actions that the plan gives for the page. Normally this is one `update` action.
20. Update the review items, if the app runs. For each row that is now resolved or refuted, find its open `Verify:` item with `llm_wiki_reviews` (type `suggestion`). The page is in `affectedPages`. Resolve the item with `llm_wiki_resolve_review`.

```json
{ "project_id": "<project folder>", "id": "<review id>", "action": "Verified" }
```

21. For each row that is still open and has no review item, add one as Step 9 of `directed.md` says. Adding an item that exists is safe.
22. Report as `SKILL.md` says. Name the rows that changed, the old `status`, and the new `status`.
