# Mechanism wiki

This folder is a wiki that stores sources, concepts, and mechanisms that repeat across domains.

## Read order

Read these files in this order before you write or change a page.

1. `docs/glossary.md`: the meaning of each term.
2. `purpose.md`: why this wiki exists, and the `Output language:` line.
3. `schema.md`: the page types, file names, and routing rules.
4. `domains.yaml`: the list of allowed domains.
5. `schema/writing-rules.md`: the rules for the text of every wiki page you write.
6. `schema/page-types/<type>.md`: `<type>` is the `type:` value of the page. Read the file for each page type you write.
7. `lenses/<lens>.md`: `<lens>` is the `lens:` value of the page domain in `domains.yaml`. For a mechanism page, read each lens in its `lenses:` field. For a hypothesis page, read the lens of `to_domain` and the lens of `from_domain`, as `schema/page-types/hypothesis.md` says.
8. `heptabase.yaml` (optional): read it only when the task uses Heptabase.

## Rules

- Do not edit files in `raw/`. Only the `wiki-sync` skill writes snapshot files in `raw/sources/heptabase/`.
- Do not invent domains. Use only the domains in `domains.yaml`.
- Write wiki pages in the output language. The app prompt names it. Otherwise read `Output language:` in `purpose.md`. If that line is empty, ask the user. Read the language by its meaning: `繁體中文`, `zh-TW`, `zh-Hant`, and `Traditional Chinese` mean Traditional Chinese. `简体中文`, `zh-CN`, `zh-Hans`, `Simplified Chinese`, and the app value `Chinese` mean Simplified Chinese.
- Follow the page-type file for the page you write.
- Ask the user when a rule does not cover a case.
