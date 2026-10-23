# Wiki schema

This file is the routing rule for every ingest. Follow it when you create or update a page.
Write page text in the output language.

## Page types

| Type | Directory | Purpose |
|---|---|---|
| source | `wiki/sources/` | Summary of one file in `raw/sources/`. Set `source_kind` to `article` or `note`. |
| entity | `wiki/entities/` | A named thing: a person, organization, tool, product, or dataset. |
| concept | `wiki/concepts/` | An idea, technique, or phenomenon that belongs to one domain. |
| comparison | `wiki/comparisons/` | A side-by-side analysis of related entities or concepts. |
| query | `wiki/queries/` | An open question under investigation. It also tracks contradictions. |
| mechanism | `wiki/mechanisms/` | A structure that repeats across domains. Only a reading wiki has this directory. |
| hypothesis | `wiki/hypotheses/` | A mechanism applied to another domain. Fusion writes it. Ingest does not. |

Each type also has a rule file at `schema/page-types/<type>.md`. An agent that can read files must read it before it writes a page of that type.

## File names

- Use kebab-case for Latin-script titles, for example `event-driven-computing.md`.
- Keep CJK titles as CJK. Do not romanize or translate them.
- Keep proper nouns and code identifiers in their usual form.
- Two domains can have a page with the same name. Add the suffix `--<last-domain-segment>` to both file names.
- Example: the domains `ai` and `cognition` give `attention--ai.md` and `attention--cognition.md`.
- Put a note at the top of each of the two pages that links to the other page.

## Frontmatter

Every page starts with YAML frontmatter. The app requires these fields: `type`, `title`, `tags`, `related`, `sources`, `created`, and `updated`.
This wiki adds the fields in the table below.
Each page-type file holds the full field list for its type.

| Field | Page types | Required | Meaning |
|---|---|---|---|
| `domain` | source, entity, concept, comparison, query | yes | One path from `domains.yaml`. |
| `also` | source, entity, concept, comparison, query | no | Other domains that the page relates to. |
| `source_kind` | source | yes | `article` (written by an outside author) or `note` (written by the user). |
| `lenses` | mechanism | yes | The lenses that the mechanism uses. |
| `instances` | mechanism | yes | Slugs of the instance pages. |
| `mechanism` | hypothesis | yes | The mechanism page. Across wikis, write `reading:<slug>`. |
| `from_domain`, `to_domain` | hypothesis | yes | The domain that gives the mechanism, and the domain that receives it. |
| `relation` | hypothesis | yes | `analogy` or `stack`. |
| `strength` | hypothesis | yes | `surface`, `structural`, or `mathematical`. |
| `status` | hypothesis | yes | `draft`, `testing`, `supported`, or `refuted`. |
| `heptabase_whiteboard` | hypothesis | no | The ID of the whiteboard that the hypothesis came from. |

A mechanism page and a hypothesis page have no `domain` field.
When `source_kind` is `note`, write the content as the user's view. Do not write it as a fact.

## Domains

- Choose the `domain` of a page only from `domains.yaml`.
- Do not invent a domain name. Do not use a synonym of a listed domain.
- If no listed domain fits, propose a new domain as a `new-domain` review item. Wait for the user to approve it.
- One page has one `domain`. Use `also` for related domains.
- Only a mechanism page crosses domains.
- When two domains share a concept name, write two pages.

## Mechanisms

A mechanism is a structure that repeats across domains. The mechanism page states the structure. It states no domain detail.
Full rules are in `schema/page-types/mechanism.md`.

- A mechanism page has these parts: components, flow, constraints and trade-offs, why it works, failure conditions, and known instances.
- The lens of a domain says what each part means in that domain.
- List each instance as a link, with its domain and its local term. Put instance detail on the instance page.
- A reading wiki writes mechanism pages. A work wiki does not.
- A work wiki sends a `new-mechanism` review item instead.
- Before you write a mechanism page, check the mechanism index `wiki/indexes/_mechanisms.md` for the same mechanism. If it exists, add a line to its known instances.

## Index and log

- The app generates `wiki/index.md`, `wiki/indexes/`, and `wiki/overview.md`. Do not write them.
- Add one entry to `wiki/log.md` for each ingest.
- Start the entry with `## [YYYY-MM-DD] <action> | <title>`.

## Cross-references

- Use `[[slug]]` links in the page body only.
- In frontmatter, write bare slugs, for example `related: [foo, bar-baz]`.
- Do not put `[[ ]]`, `wiki/`, or `.md` in frontmatter.
- Link each page to the sources and concepts that it uses.

## Contradictions

When two sources disagree:

1. Record the contradiction in the page that holds the claim.
2. Open or update a query page for the contradiction.
3. Link both sources from the query page.
