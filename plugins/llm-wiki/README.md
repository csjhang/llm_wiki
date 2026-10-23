# LLM Wiki (Mechanism) plugin

This plugin adds Claude Code skills for the LLM Wiki mechanism wiki.
A mechanism wiki stores sources, concepts, and the cause-and-effect mechanisms between them.

Every skill name starts with `wiki`.
Run the `wiki` skill to see all skills and to choose one.

## Install

Run these commands in Claude Code:

```
/plugin marketplace add csjhang/llm_wiki
/plugin install llm-wiki@llm-wiki-mechanism
```

## Requirements

The skills `wiki-sync` and `wiki-fuse` also need the Heptabase plugin.
Install the Heptabase plugin before you use these two skills.
