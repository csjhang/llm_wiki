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
- The `node` command with the script `wiki-tool.mjs` or the script `undo.mjs` of `wiki-undo`. A rule covers the path in double quotes. Another rule covers the path with no quotes.
- These rules match the end of the path only. They do not check which folder holds the script.
- One git command: `git -C <folder> rev-parse HEAD`. The skill `wiki-lint` runs it. It only reads.
- The `mkdir` and `cp` commands, only for the `.llm-wiki/hepta` folder.
- Edits in the `.llm-wiki/hepta` folder only. The skills `wiki-sync` and `wiki-fuse` save Heptabase results there.

Other git commands are not on the list. For example, `wiki-undo` runs `git show`. Claude Code asks you in a conversation.
The skill `wiki-recut` writes `.llm-wiki/recut-plan.json`. It runs in a conversation, so Claude Code asks you first.

## What `.claude/settings.json` denies

A deny rule wins over an allow rule. The file denies:

- `git push`, `git reset`, `git clean`, `git checkout`, `git restore`, `git rebase`, `git stash`, `git branch -D`, and `rm`.
- The forms that make `node` run text: `node -e`, `node --eval`, `node -p`, `node --print`, `node --import`, `node -r`, and `node --require`. A `-e` after another option is also denied.
- The forms that make git run a program: `git -c` and `--exec-path`.
- A `.mjs` script that is run from the `.llm-wiki` folder. A background run can write there, so it must not run a script from there.

No skill needs these commands. The undo script runs its own git commands.
A deny rule stops the usual form of a command only. For example, it does not stop `git -C . push`.
A deny rule can also stop a safe command. The rule matches the whole text of the command. A card title with the text ` -e ` in it makes `node * -e *` match. Rename the card, or remove that rule.
Add a rule only when a skill needs it.

## What these lists do not do

The allow list lowers the number of prompts. It is not a sandbox.
A background run has the rights of your user account. It can read the files that you can read.
A Bash rule matches the text of a command. A `*` matches any text, including spaces. A command can be written in a form that the rule does not match.
The AI reads Heptabase cards and wiki pages. A web page that you clipped can hide text in them, and the AI can follow that text.
Run a background skill only on a wiki whose sources you trust.
For a stronger guard, use the sandbox of Claude Code. Read https://code.claude.com/docs/en/sandboxing.md and https://code.claude.com/docs/en/permissions.md.
