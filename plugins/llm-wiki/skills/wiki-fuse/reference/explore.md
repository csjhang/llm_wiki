# Explore mode and candidate mode

Use this file for `/wiki-fuse --explore` and for `/wiki-fuse --candidate <review id>`.
A fusion candidate is a pair of one mechanism and one target domain. The app proposes candidates after an ingest writes a new mechanism page.
Each candidate is a `fusion-candidate` review item. Its description has one line for each candidate:

```
CANDIDATE: <domain> | <strength> | <reason>
```

- The first entry of `affectedPages` is the mechanism page.
- `<strength>` is a hint from the app. Do not copy it. Set `strength` as Step 6 of `directed.md` says.
- The candidate modes have no whiteboard. The hypothesis goes into the wiki of the mechanism page. It has no `heptabase_whiteboard`.
- Only a reading wiki holds mechanism pages. Run these modes in a reading wiki. If `wiki.yaml` says `role: work`, tell the user to run the mode in the reading wiki. Stop.
- Both modes need the app. If `llm_wiki_status` fails, tell the user to open the app. Stop.

## Explore

Use these steps for `/wiki-fuse --explore`.

1. Call `llm_wiki_reviews` for the open candidates. Save the result as `llm_wiki_reviews-fusion-candidate.json`.

```json
{ "project_id": "<project folder>", "type": "fusion-candidate", "status": "unresolved", "limit": 50 }
```

2. Read each item: its `ID`, its title, its `Affected pages`, and its `CANDIDATE:` lines. Each line is one candidate.
3. Read `.llm-wiki/fusion-dismissed.json` if it exists. It is a JSON list of `{ "mechanism", "targetDomain" }` pairs. `mechanism` is the path of the mechanism page. Never show a candidate that has a pair in the list.
4. Add up to two new candidates:
   1. List `wiki/mechanisms/`. Sort the pages by `created` in the frontmatter, newest first. Read up to five pages.
   2. Read `domains.yaml` and the lens of each domain.
   3. For each mechanism, find a domain whose lens can take the parts of the mechanism, and that has no instance of it. The instances are the lines under "Known instances" of the mechanism page.
   4. The domain index `wiki/indexes/<domain>.md` must exist and list at least one page. Replace each `/` in the domain with `--` in the file name.
   5. Skip a pair that is in the dismissed list, a pair that is an open candidate already, and a pair that has a hypothesis page. A hypothesis page has the same `mechanism` and `to_domain`.
   6. Write one sentence of reason for each new candidate. It says which part of the mechanism the domain could take.
5. Find the domains that the user worked on last. Read `heptabase-map.json` in the project folder. Take the five `sources` with the newest `card_updated_at`. Read `domain` in the frontmatter of each file at `raw_path`. Skip this step if the map does not exist.
6. Rank all candidates. Put a candidate first when its target domain is one of the domains from step 5. Keep the order of the list for the rest.
7. Show at most five candidates as a numbered table. Use the columns `#`, mechanism, target domain, strength hint, reason, and origin. The origin is the review `ID`, or "new" for a candidate from step 4.
8. If there is no candidate, tell the user. Stop.
9. Ask the user to pick one. Wait for the answer.
10. Run the section "Start from a candidate" for the picked pair.

## Start from a candidate

Use these steps after step 10 of "Explore", and for `/wiki-fuse --candidate <review id>`.

Steps 1 to 3 are for `--candidate` only. After "Explore", you have the mechanism page and the domain already. Go to step 4.

1. Call `llm_wiki_reviews` as in "Explore" step 1, with `"status": "all"`. Find the item with the `ID` that the user gave.
2. If the item does not exist, tell the user. Stop. If the item is resolved, tell the user and ask if the fusion should still run.
3. If the item has more than one `CANDIDATE:` line, ask the user which domain to fuse. Wait for the answer.
4. The mechanism page is the first entry of `affectedPages` of the item. A candidate marked "new" has no item. Its mechanism page is the page that you read in "Explore" step 4. Read `CLAUDE.md` of the project, as Rule 1 of `SKILL.md` says. Read the mechanism page. If the page does not exist, tell the user. Stop.
5. The target domain is the domain of the candidate. It must be in `domains.yaml`. If it is not, tell the user. Stop.
6. Find `from_domain`. Read the instance lines under "Known instances". If all instances are in one domain, use it. If there are several, propose the domain whose instance page explains the parts best. Ask the user to confirm it.
7. Read the index of the target domain. If the file does not exist or lists no page, there is nothing to fuse with. Tell the user to ingest sources about the target domain first. Stop.
8. Run Steps 4 to 7 of `directed.md`. Step 5 reads the target pages from the index. Leave `heptabase_whiteboard` out of the page.
9. Run Step 8 of `directed.md`. The plan has no `place` action for the page, because the page names no whiteboard. Tell the user to place the card by hand.
10. Run Step 9 of `directed.md`.
11. If the fusion came from a review item, resolve the item after the commit. Skip this when the fusion stopped before the commit. Save the result as `llm_wiki_resolve_review-<id>.json`.

```json
{ "project_id": "<project folder>", "id": "<review id>", "action": "fused" }
```

12. Resolving the item closes its other candidates too. Tell the user.
13. If the call fails, tell the user. The page and the commit stay as they are.
