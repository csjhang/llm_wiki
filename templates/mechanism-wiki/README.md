# Mechanism wiki

This folder is a mechanism wiki. The AI keeps the pages under `wiki/`. The app opens these pages read-only.
To change a page, write a thought card in Heptabase. The next sync brings the change into the wiki.
The AI reads `CLAUDE.md` first. It lists the files to read and the rules to follow.

## Set up Claude Code

The skill panel of the LLM Wiki app runs Claude Code skills in this folder. Do these steps once.

1. Install the `llm-wiki` plugin and the Heptabase plugin in Claude Code. The README of the `llm-wiki` plugin has the commands.
2. Add the LLM Wiki MCP server to Claude Code. Name the server `llm-wiki`. The file `mcp-server/README.md` in the LLM Wiki repository shows how.
3. Check the names of the Heptabase tools. Run `/mcp` in Claude Code and open the Heptabase server. A plugin tool has the name `mcp__plugin_<plugin>_<server>__<tool>`.
4. Compare that prefix with the first rule in `.claude/settings.json`. The rule is `mcp__plugin_heptabase_heptabase__*`. If the prefix is not the same, change the rule.
5. Run `claude` in this folder. Accept the trust prompt. Do this before the first background run.

## Why step 5 matters

A background run cannot ask for permission. Claude Code denies each tool that is not on the allow list.
It applies the allow list of `.claude/settings.json` only after you trust this folder once.
Without the trust, a background run of `wiki-sync` or `wiki-lint` cannot use the tools that it needs.

## What `.claude/settings.json` allows

- The Heptabase tools and the `llm-wiki` tools.
- The `wiki-tool` script of the plugin and the `undo.mjs` script of `wiki-undo`.
- The `git` command.
- The `mkdir` and `cp` commands, only for the `.llm-wiki/hepta` folder.
- Edits in the `.llm-wiki` folder.

The list allows nothing else. Add a rule only when a skill needs it.
