# LLM Wiki (Mechanism) plugin

This plugin adds Claude Code skills for the LLM Wiki mechanism wiki.
A mechanism wiki stores sources, concepts, and mechanisms. A mechanism is a structure that repeats across domains.
The LLM Wiki app ingests sources. The skills in this plugin work on the wiki after that.

## Jobs of the skills

- Sync the wiki with Heptabase.
- Fuse a mechanism into a hypothesis about another domain.
- Lint the wiki.
- Recut the domains of the wiki.
- Undo a change to the wiki.

Every skill name starts with `wiki`.
Run the `wiki` skill to see the skills that are installed and to choose one.

## Install

Run these commands in Claude Code:

```
/plugin marketplace add csjhang/llm_wiki
/plugin install llm-wiki@llm-wiki-mechanism
```

## Requirements

The skills `wiki-sync` and `wiki-fuse` also need the Heptabase plugin.
Install the Heptabase plugin before you use these two skills.
