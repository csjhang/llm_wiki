# Mechanism wiki

This folder is a mechanism wiki. The AI keeps the pages under `wiki/`. The app opens these pages read-only.
To change a page, write a thought card in Heptabase. The next sync brings the change into the wiki.
The AI reads `CLAUDE.md` first. It lists the files to read and the rules to follow.

## Set up Claude Code

The skill panel of the LLM Wiki app runs Claude Code skills in this folder. Do these steps once.

1. Install the `llm-wiki` plugin and the Heptabase plugin in Claude Code. The README of the `llm-wiki` plugin has the commands.
2. Add the LLM Wiki MCP server to Claude Code. Name the server `llm-wiki`. The file `mcp-server/README.md` in the LLM Wiki repository shows how.
3. Check the names of the Heptabase tools. Run `/mcp` in Claude Code and open the Heptabase server. A plugin tool has the name `mcp__plugin_<plugin>_<server>__<tool>`.
4. Compare that prefix with the Heptabase rules in `.claude/settings.json`. The file has one rule for each tool, with two prefixes. A Heptabase plugin gives `mcp__plugin_heptabase_heptabase__`. The Heptabase connector of claude.ai gives `mcp__Heptabase__`. If your tools have another prefix, change the prefix in each rule.
5. Run `claude` in this folder. Accept the trust prompt. Do this before the first background run.

## Why step 5 matters

A background run cannot ask for permission. Claude Code denies each tool that is not on the allow list.
It applies the allow list of `.claude/settings.json` only after you trust this folder once.
Without the trust, a background run of `wiki-sync` or `wiki-lint` cannot use the tools that it needs.

## What `.claude/settings.json` allows

- The Heptabase tools that the skills call. The file names each tool one by one, so a new Heptabase tool needs a new rule.
- All tools of the `llm-wiki` server.
- The `wiki-tool` script of the plugin and the `undo.mjs` script of `wiki-undo`.
- The `git` command, but see the deny list below.
- The `mkdir` and `cp` commands, only for the `.llm-wiki/hepta` folder.
- Edits in the `.llm-wiki` folder.

## What `.claude/settings.json` denies

A deny rule wins over an allow rule. The file denies `git push`, `git reset`, `git clean`, `git checkout`, `git restore`, `git rebase`, `git stash`, `git branch -D`, and `rm`.
No skill needs these commands. The undo script runs its own git commands.
A deny rule stops the usual form of a command only. For example, it does not stop `git -C . push`.
Add a rule only when a skill needs it.
