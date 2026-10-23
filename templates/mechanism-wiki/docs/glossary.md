# Glossary

Each term has one meaning. Use the term exactly as written here.

## Wiki

A wiki is one folder. It holds `raw/`, `wiki/`, and the config files. One wiki is one project in the app. The term is used most in `CLAUDE.md`.

## Reading wiki

A reading wiki stores the daily reading and interests of the user. It holds the mechanism library. The mechanism library is the set of mechanism pages in `wiki/mechanisms/`. The term is used most in `schema.md`.

## Work wiki

A work wiki stores work material. It has no mechanism library. It points to the mechanism library of a reading wiki. The term is used most in `heptabase.example.yaml`.

## Source

A source is one file in `raw/sources/`. The app reads a source and writes wiki pages from it. A source is an article or a note. The term is used most in `schema.md`.

## Article

An article is a source that an outside author wrote. It is evidence. Its `source_kind` is `article`. The term is used most in `schema/page-types/source.md`.

## Note

A note is a source that the user wrote. It is the view of the user, not evidence. Write it as a view, never as a fact. Its `source_kind` is `note`. The term is used most in `schema/writing-rules.md`.

## Domain

A domain is one path in `domains.yaml`, for example `hardware/async-circuits`. Each page, except a mechanism page or a hypothesis page, belongs to one domain. Choose a domain only from the list. The term is used most in `domains.yaml`.

## Lens

A lens is one file in `lenses/`. It says what each part of a mechanism means in one domain. It also sets the evidence standard of that domain. The term is used most in the files in `lenses/`.

## Mechanism

A mechanism is a structure that repeats across domains. A mechanism page states parts, flows, constraints and trade-offs, why it works, and failure conditions. It states no domain detail. The term is used most in `schema/page-types/mechanism.md`.

## Instance

An instance is a concrete thing in one domain that fits a mechanism. A mechanism page links to its instances. Each instance has its own page. The term is used most in `schema/page-types/mechanism.md`.

## Fusion

Fusion applies one mechanism to another domain. The result is a hypothesis page. The term is used most in `schema/page-types/hypothesis.md`.

## Hypothesis page

A hypothesis page is the result of a fusion. It says which parts of the mechanism fit the target domain and which parts do not. It also lists what to verify. The term is used most in `schema/page-types/hypothesis.md`.

## Relation

A relation links two domains. A relation is an analogy or a stack. A hypothesis page records it in the `relation` field. The term is used most in `schema/page-types/hypothesis.md`.

## Analogy

An analogy borrows a mechanism from one domain for another domain. The two domains stay separate. Its `relation` value is `analogy`. The term is used most in `schema/page-types/hypothesis.md`.

## Stack

A stack is a relation in which one domain is the base layer of another domain. Its `relation` value is `stack`. The term is used most in `schema/page-types/hypothesis.md`.

## Analogy strength

Analogy strength has three levels. `surface` means the words look alike. `structural` means the structures correspond. `mathematical` means both sides have the same mathematical form. The term is used most in `schema/page-types/hypothesis.md`.

## Mirror card

A mirror card is a Heptabase card that the AI creates from a wiki page. It has the `#wiki` tag. The user must not edit it. The term is used most in `heptabase.example.yaml`.

## Card map

The card map is the file `heptabase-map.json`. It records which card belongs to which page, and the sync state. A tool writes it. Do not edit it by hand. The term is used most in the `SKILL.md` file of the `wiki-sync` skill.

## Review queue

The review queue is the review feature of the app. The AI sends an item there when the user must decide, for example about a new domain. The user approves or skips each item. The term is used most in `schema.md`.
