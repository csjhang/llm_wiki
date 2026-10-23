---
name: wiki
description: Use this skill to see all LLM Wiki skills and to choose one. It lists each skill with its description, asks which skill to run, and then runs that skill.
---

# wiki

Use this skill as the menu for all LLM Wiki skills.

## Steps

1. Find the `skills` folder that contains this skill.
2. Read the frontmatter of each `*/SKILL.md` file in that folder.
3. Show a table with two columns: `name` and `description`.
4. Ask the user which skill to run.
5. Run the skill that the user selects.

## Rules

- Do not hard-code the skill list. Read it from the `skills` folder each time.
- Do not run a skill before the user selects it.
- If the `skills` folder has no other skill, tell the user that no other skill is installed.
