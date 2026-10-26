/**
 * wiki-recut-skill.test.ts - the wiki-recut skill, the `wiki-tool recut` commands, and the review API must agree.
 *
 * The skill is text for an agent. These tests pin the parts that other code depends on, so a change in one place fails
 * until the others follow: the command lines and the output keys of `wiki-tool recut`, the plan files, the problems
 * of `recut apply` that the skill explains, `project_id` in the `llm_wiki_*` call, the title form of ruling U12, and
 * the option actions of ruling S17.
 */
import { readFileSync, symlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { isAllowedApiReviewAction } from "@/lib/review-option-actions"
import { apiReviewTypes, fillPlaceholders, jsonBlocks, OPTION_PROBLEM, readRepoFile, wikiToolCommands } from "@/test-helpers/skill-contract"
import { findLongSentences } from "@/test-helpers/ste-check"
import { runCli } from "../../../tools/wiki-tool/src/cli"
import { missingOptionMessage } from "../../../tools/wiki-tool/src/cmd-plan-down"
import { GIT_LOCK_BUSY_MESSAGE } from "../../../tools/wiki-tool/src/git-lock"
import { commit } from "../../../tools/wiki-tool/src/lint/lint-fixture"
import { RECUT_GROUP } from "../../../tools/wiki-tool/src/recut"
import { staleProblem } from "../../../tools/wiki-tool/src/recut/apply"
import { parseRecutPlan } from "../../../tools/wiki-tool/src/recut/plan"
import {
  ALPHA,
  applyPlan,
  BETA,
  lastSubject,
  makeRecutRepo,
  ONE,
  runRecut,
  status,
} from "../../../tools/wiki-tool/src/recut/recut-fixture"
import { makeProject, removeProjects, writeProjectFile } from "../../../tools/wiki-tool/src/test-project"

// Each test starts git processes; a busy machine needs more than the default 5 s.
vi.setConfig({ testTimeout: 30_000 })

afterEach(removeProjects)

const skill = readRepoFile("plugins/llm-wiki/skills/wiki-recut/SKILL.md")

/** The text of the skill from one heading to the next heading of the same level or a higher one. */
function section(heading: string): string {
  const start = skill.indexOf(heading)
  expect(start, heading).toBeGreaterThan(-1)
  const level = heading.match(/^#+/)?.[0].length ?? 1
  const rest = skill.slice(start + heading.length)
  const next = rest.search(new RegExp(`^#{1,${level}} `, "m"))
  return next === -1 ? skill.slice(start) : skill.slice(start, start + heading.length + next)
}

const OMEGA = "example/omega"
const GAMMA = "example/gamma"
const PLAN_FILE = ".llm-wiki/recut-plan.json"

const blocks = jsonBlocks(skill)
const planBlocks = blocks.filter((block) => block.tool === null)

/** The plan block of one operation, as the skill writes it. */
function planBlock(op: string): Record<string, unknown> {
  const found = planBlocks.find((block) => block.json.op === op)
  expect(found, op).toBeDefined()
  return found?.json as Record<string, unknown>
}

describe("wiki-recut skill: the command lines", () => {
  const commands = wikiToolCommands(skill)

  it("names every command of the recut group, and only those", () => {
    expect(commands.map((command) => command.command).sort()).toEqual(["apply", "pages"])
    expect(Object.keys(RECUT_GROUP.commands).sort()).toEqual(["apply", "pages"])
    for (const command of commands) expect(command.group, command.line).toBe("recut")
    expect(skill).toContain("`<command>` is `pages` or `apply`.")
  })

  it("gives each command only options that it takes", async () => {
    const project = makeRecutRepo()
    for (const command of commands) {
      const args = command.args.map((word) => fillPlaceholders(word, { "<project>": project, "<domain>": ALPHA }))
      const result = await runCli([command.group, command.command, ...args])
      expect(JSON.stringify(result.output), command.line).not.toMatch(OPTION_PROBLEM)
    }
  })

  it("runs the apply line as written, on the plan file that the skill names", async () => {
    const apply = commands.find((command) => command.command === "apply")
    expect(apply?.line).toContain(`--plan "<project>/${PLAN_FILE}"`)
    expect(section("## Apply")).toContain("Write the plan to `<project>/.llm-wiki/recut-plan.json`")
    const project = makeRecutRepo()
    // The plan file is in `.llm-wiki/`, which does not make the working tree dirty.
    writeProjectFile(project, PLAN_FILE, JSON.stringify({ op: "rename", from: ALPHA, to: OMEGA }))
    const args = (apply?.args ?? []).map((word) => fillPlaceholders(word, { "<project>": project }))
    const result = await runCli([apply?.group ?? "", apply?.command ?? "", ...args])
    expect(result.exitCode).toBe(0)
    expect(lastSubject(project)).toMatch(/^recut: rename example\/alpha → example\/omega \(\d+ pages\)$/)
    expect(skill).toContain("The subject is `recut: <operation> <from> → <to> (<N> pages)`.")
  })

  it("calls no other group of wiki-tool and no Heptabase tool", () => {
    expect(new Set(commands.map((command) => command.group))).toEqual(new Set(["recut"]))
    expect(skill).toContain("Call no Heptabase tool.")
    expect(skill).not.toMatch(/\b(read_whiteboard|list_cards|read_object|create_object|edit_card_properties)\b/)
  })
})

describe("wiki-recut skill: the output keys that it names", () => {
  const named = (key: string): void => expect(skill, key).toContain(`\`${key}\``)

  it("pages gives path, title, type, key, and excerpt, and lists a page that names the domain only in also", async () => {
    const into = ["---", "type: hypothesis", "title: Into", `from_domain: ${BETA}`, `to_domain: ${ALPHA}`, "---", "", "# Into", ""].join("\n")
    const project = makeRecutRepo({ "wiki/hypotheses/into.md": into })
    const result = await runRecut<{ pages: Array<Record<string, string>> }>("pages", project, "--domain", ALPHA)
    expect(result.exitCode).toBe(0)
    for (const entry of result.output.pages) expect(Object.keys(entry).sort()).toEqual(["excerpt", "key", "path", "title", "type"])
    for (const key of ["pages", "path", "title", "type", "key", "excerpt"]) named(key)
    const keys = new Set(result.output.pages.map((entry) => entry.key))
    expect(keys).toEqual(new Set(["domain", "to_domain", "from_domain", "also"]))
    for (const key of keys) expect(skill, key).toContain(`\`${key}\``)
    expect(skill).toContain("The new domain replaces the old domain in its `also` list.")
  })

  it("pages gives a page that names the domain in two keys two entries, and the excerpt is 300 characters", async () => {
    const both = ["---", "type: hypothesis", "title: Both", `from_domain: ${ALPHA}`, `to_domain: ${ALPHA}`, "---", "", "x".repeat(400), ""].join("\n")
    const project = makeRecutRepo({ "wiki/hypotheses/both.md": both })
    const result = await runRecut<{ pages: Array<{ path: string; key: string; excerpt: string }> }>("pages", project, "--domain", ALPHA)
    const entries = result.output.pages.filter((entry) => entry.path === "wiki/hypotheses/both.md")
    expect(entries.map((entry) => entry.key)).toEqual(["to_domain", "from_domain"])
    expect(entries[0].excerpt).toHaveLength(300)
    expect(skill).toContain("A page that names the domain in two keys has two entries.")
    expect(skill).toContain("`excerpt` is the first 300 characters of the body.")
  })

  it("apply gives sha, pages, mergeCandidates for a merge, and notes", async () => {
    const same = (type: string, domain: string): string => ["---", `type: ${type}`, "title: Shared", `domain: ${domain}`, "---", "", "# Shared", ""].join("\n")
    const project = makeRecutRepo({ "wiki/concepts/shared.md": same("concept", ALPHA), "wiki/entities/shared.md": same("entity", BETA) })
    const merge = await applyPlan(project, { op: "merge", from: [ALPHA, BETA], into: { domain: GAMMA, lens: "ai", description: "About gamma" } })
    expect(merge.exitCode).toBe(0)
    expect(merge.output.sha).toMatch(/^[0-9a-f]{40}$/)
    expect(merge.output.pages?.length).toBeGreaterThan(0)
    expect(merge.output.mergeCandidates).toEqual([{ a: "wiki/concepts/shared.md", b: "wiki/entities/shared.md" }])
    expect(merge.output.notes?.length).toBeGreaterThan(0)
    for (const key of ["sha", "pages", "mergeCandidates", "notes", "a", "b"]) named(key)
    expect(skill).toContain("It gives `mergeCandidates` for a merge.")
    expect(skill).toContain("Each entry is a pair `a` and `b` of pages with the same name")
  })

  it("apply gives no mergeCandidates for a rename", async () => {
    const result = await applyPlan(makeRecutRepo(), { op: "rename", from: ALPHA, to: OMEGA })
    expect(result.output.mergeCandidates).toBeUndefined()
  })
})

describe("wiki-recut skill: the plan files", () => {
  it("has one plan block for each operation, and the tool reads each as written", () => {
    expect(planBlocks.map((block) => block.json.op)).toEqual(["rename", "split", "merge"])
    for (const block of planBlocks) {
      const parsed = parseRecutPlan(JSON.stringify(block.json))
      expect(parsed, String(block.json.op)).toMatchObject({ ok: true })
    }
    for (const op of ["rename", "move", "split", "merge"]) expect(skill, op).toContain(`\`${op}\``)
    // `move` is the same plan as `rename`, with `op` set to `move`.
    expect(parseRecutPlan(JSON.stringify({ ...planBlock("rename"), op: "move" }))).toMatchObject({ ok: true })
  })

  it("a rename block runs on a wiki when its placeholders have values", async () => {
    const project = makeRecutRepo()
    const plan = { ...planBlock("rename"), from: ALPHA, to: OMEGA }
    const result = await applyPlan(project, plan)
    expect(result.exitCode).toBe(0)
    expect(readFileSync(join(project, "domains.yaml"), "utf8")).toContain(OMEGA)
  })

  it("a split block runs on a wiki when each page that recut pages lists has an assignment", async () => {
    const project = makeRecutRepo()
    const listed = await runRecut<{ pages: Array<{ path: string }> }>("pages", project, "--domain", ALPHA)
    const block = planBlock("split") as { into: Array<Record<string, string>> }
    expect(Object.keys(block.into[0]).sort()).toEqual(["description", "domain", "lens"])
    const into = block.into.map((entry, index) => ({ ...entry, domain: `example/alpha-${index + 1}`, lens: "hardware" }))
    const assignments = Object.fromEntries(listed.output.pages.map((entry) => [entry.path, into[0].domain]))
    const result = await applyPlan(project, { ...block, op: "split", from: ALPHA, into, assignments })
    expect(result.exitCode).toBe(0)
    expect(lastSubject(project)).toBe(`recut: split ${ALPHA} → example/alpha-1+example/alpha-2 (${result.output.pages?.length} pages)`)
    // Every domain key of the pages follows the assignment.
    expect(readFileSync(join(project, "wiki/concepts/one.md"), "utf8")).toContain("domain: example/alpha-1")
  })

  it("a merge block runs on a wiki when its placeholders have values", async () => {
    const project = makeRecutRepo()
    const block = planBlock("merge") as { into: Record<string, string> }
    const result = await applyPlan(project, { ...block, from: [ALPHA, BETA], into: { ...block.into, domain: GAMMA, lens: "ai" } })
    expect(result.exitCode).toBe(0)
    expect(result.output.mergeCandidates).toEqual([])
  })

  it("tells the agent to write the plan file as the first step of Apply, and to give a split an assignment for every listed page", () => {
    const planFile = section("## The plan file")
    expect(planFile).toContain("The first step of \"Apply\" writes it to a file, after the user says yes.")
    expect(planFile).not.toContain("Write it to")
    const apply = section("## Apply")
    const first = apply.split("\n").find((line) => line.startsWith("1. ")) ?? ""
    expect(first).toContain("Write the plan to `<project>/.llm-wiki/recut-plan.json` with the file tool.")
    expect(first).toContain("Never commit it.")
    expect(apply.indexOf("Write the plan to")).toBeLessThan(apply.indexOf("Run `recut apply`"))
    expect(planFile).toContain("`assignments` has one entry for every path that `recut pages` gave")
    expect(section("## Plan a split")).toContain("A path can have two entries. Give it one new domain.")
  })
})

describe("wiki-recut skill: pages that fit no new domain (Review Focus 2)", () => {
  it("recut apply refuses a split that leaves a page without a new domain, and the skill asks the user", async () => {
    const project = makeRecutRepo()
    const into = [{ domain: "example/alpha-1", lens: "hardware", description: "One" }]
    const result = await applyPlan(project, { op: "split", from: ALPHA, into, assignments: {} })
    expect(result.exitCode).toBe(2)
    expect(JSON.stringify(result.output.problems)).toContain("without a new domain")
    const split = section("## Plan a split")
    expect(split).toContain("Ask the user about each page that fits no new domain, and about each page that mixes two of them.")
    expect(split).toContain("`recut apply` refuses a plan with a page that has no new domain.")
    expect(section("## Rules")).toContain("Never leave a page without one.")
    expect(split).toContain("Give one reason for each page, in one short sentence.")
  })
})

describe("wiki-recut skill: the confirmation and the order of the steps", () => {
  it("shows the full plan and waits for a yes before it writes the plan or runs apply", () => {
    const at = (needle: string): number => {
      const found = skill.indexOf(needle)
      expect(found, needle).toBeGreaterThan(-1)
      return found
    }
    expect(at("## Before you start")).toBeLessThan(at("## Plan a rename or a move"))
    expect(at("## Plan a merge")).toBeLessThan(at("## The plan file"))
    expect(at("## The plan file")).toBeLessThan(at("## Confirm the plan"))
    expect(at("## Confirm the plan")).toBeLessThan(at("## Heptabase options"))
    expect(at("## Heptabase options")).toBeLessThan(at("## Apply"))
    expect(at("## Apply")).toBeLessThan(at("## Problems of apply"))
    expect(at("## Problems of apply")).toBeLessThan(at("## After the recut"))
    expect(at("## After the recut")).toBeLessThan(at("## Report"))
    const confirm = section("## Confirm the plan")
    expect(confirm).toContain("Show the full plan. Never cut the list.")
    expect(confirm).toContain("Ask: \"Run this plan?\" Wait for the answer.")
    expect(confirm).toContain("A yes starts the next section. Any other answer ends it.")
    expect(section("## Rules")).toContain("Never run `recut apply` before the user says yes to the full plan.")
    expect(section("## Apply")).toContain("Run `recut apply` with the plan file.")
  })

  it("builds the plan in the notes first, and goes to the confirmation, before it writes the file", () => {
    for (const heading of ["## Plan a rename or a move", "## Plan a split", "## Plan a merge"]) {
      const plan = section(heading)
      expect(plan, heading).toContain("Keep it in your notes. Do not write the file yet. Go to \"Confirm the plan\".")
    }
    expect(section("## Confirm the plan")).toContain("If the user changes the plan, go back to the section of the operation.")
  })

  it("asks which operation to run when the user names none", () => {
    expect(section("## Before you start")).toContain("If the user did not name an operation, ask which one to run: `rename`, `move`, `split`, or `merge`.")
    const ops = new Set(planBlocks.map((block) => block.json.op))
    expect(ops).toEqual(new Set(["rename", "split", "merge"]))
  })

  it("shows the effects of a split that do not carry over", () => {
    const split = section("## Plan a split")
    expect(split).toContain("The whiteboard hints of the old domain in `domains.yaml` are dropped.")
    expect(split).toContain("The child domains of the old domain stay where they are.")
    expect(split).toContain("A Known instances line of a mechanism page takes the new domain of the instance page.")
    expect(section("## Plan a merge")).toContain("The child domains of a merged domain stay where they are.")
  })
})

describe("wiki-recut skill: the Heptabase options", () => {
  it("tells the user which options to add to the domain property of the mirror tag, before the next wiki-sync", () => {
    const options = section("## Heptabase options")
    expect(options).toContain("Do this after the yes and before `recut apply`.")
    expect(options).toContain("Tell the user to add these options to the `domain` property of the mirror tag in Heptabase before the next `wiki-sync`:")
    expect(options).toContain("- Rename and move: the new name of each moved domain.")
    expect(options).toContain("- Split: each new domain of `into`.")
    expect(options).toContain("- Merge: the target domain, if no option has its name.")
    expect(options).toContain("Tell the user that the old options stay. The user can remove them by hand after the sync.")
    expect(section("## After the recut")).toContain("Tell the user the select options again")
    expect(section("## MCP rules")).toContain("Call no Heptabase tool. The MCP cannot add a select option. The user adds it.")
  })

  it("a missing option stops the card at the next sync, as wiki-sync says", () => {
    const sync = readRepoFile("plugins/llm-wiki/skills/wiki-sync/SKILL.md")
    expect(sync).toContain("If a select option is missing, stop that card. Tell the user which option to add in which property.")
    // The sync tool says it as the skill says it: the option and the property.
    expect(missingOptionMessage("example/omega", "domain")).toBe('add the option "example/omega" to the "domain" property in Heptabase')
  })
})

describe("wiki-recut skill: the problems of recut apply", () => {
  const table = section("## Problems of apply")

  it("a dirty tree is refused, and the skill tells the user to commit or discard, but not the map", async () => {
    const project = makeRecutRepo()
    writeFileSync(join(project, "wiki/concepts/one.md"), `${ONE}\nAn edit.\n`)
    const result = await applyPlan(project, { op: "rename", from: ALPHA, to: OMEGA })
    expect(result.exitCode).toBe(2)
    expect(JSON.stringify(result.output.problems)).toContain("uncommitted changes")
    expect(table).toContain("| The working tree has uncommitted changes |")
    // The rules are stated once, in Rule 4 and Rule 10. The table points to them.
    expect(table).toContain("Follow Rule 4 and Rule 10.")
    expect(section("## Rules")).toContain("4. Never commit, stash, or discard the changes of the user. Tell the user to commit or discard them.")
    expect(section("## Rules")).toContain("Rule 10 names one file that the user must not discard.")
    expect(section("## Before you start")).toContain("The card map `heptabase-map.json` and the folder `.llm-wiki/` do not count.")
  })

  it("the card map and .llm-wiki do not make the tree dirty", async () => {
    const project = makeRecutRepo()
    writeProjectFile(project, "heptabase-map.json", "{}")
    writeProjectFile(project, ".llm-wiki/semantic-lint.json", "{}")
    const result = await applyPlan(project, { op: "rename", from: ALPHA, to: OMEGA })
    expect(result.exitCode).toBe(0)
    expect(status(project)).toContain("heptabase-map.json")
  })

  it("a page behind a link is refused, and the skill says the path must be a plain file or folder", async () => {
    const outside = makeProject({ "linked/page.md": ["---", "type: concept", "title: Outside", `domain: ${ALPHA}`, "---", "", "# Outside", ""].join("\n") }, { noHeptabaseYaml: true })
    const project = makeRecutRepo()
    symlinkSync(join(outside, "linked"), join(project, "wiki/linked"), "dir")
    commit(project, "link a folder")
    const result = await applyPlan(project, { op: "rename", from: ALPHA, to: OMEGA })
    expect(result.exitCode).toBe(2)
    expect(JSON.stringify(result.output.problems)).toContain("outside the project")
    expect(table).toContain("| A file is a link, a folder in its path is a link, or a file is outside the project |")
    expect(table).toContain("the recut cannot run until the path is a plain file or folder inside the project")
    const own = makeRecutRepo()
    symlinkSync(join(own, "wiki/concepts/one.md"), join(own, "wiki/concepts/linked.md"))
    commit(own, "link a page")
    const linked = await applyPlan(own, { op: "rename", from: ALPHA, to: OMEGA })
    expect(JSON.stringify(linked.output.problems)).toContain("the file is a link")
  })

  it("a page whose keys the tool cannot edit is named, and the skill tells the user to put the keys in the first column", async () => {
    const odd = `---\n  type: concept\n  title: Odd\n  domain: ${ALPHA}\n---\n\n# Odd\n`
    const project = makeRecutRepo({ "wiki/concepts/odd.md": odd })
    const result = await applyPlan(project, { op: "rename", from: ALPHA, to: OMEGA })
    expect(result.exitCode).toBe(2)
    const problems = JSON.stringify(result.output.problems)
    expect(problems).toContain("wiki/concepts/odd.md: domain still names")
    expect(problems).toContain("keys in the first column")
    expect(table).toContain("| A page names a key that the tool cannot edit |")
    expect(table).toContain("write the frontmatter of that page with its keys in the first column")
    // A page that the tool refuses is not changed by the skill.
    expect(section("## Rules")).toContain("Never edit a page, `domains.yaml`, or an index file by hand. The tool does it.")
  })

  it("a page that changed during the run, and a busy git lock, are handled with a new run", () => {
    expect(staleProblem("wiki/concepts/one.md")).toBe("wiki/concepts/one.md changed while the recut ran, so nothing was written. Run the recut again.")
    expect(table).toContain("| A page changed while the recut ran | Run `recut apply` again. |")
    expect(GIT_LOCK_BUSY_MESSAGE).toBe("another wiki tool is using git")
    expect(table).toContain("| Another wiki tool is using git | Wait. Run `recut apply` again. Never delete a lock file. |")
  })

  it("a recut that exits with 2 has written nothing", async () => {
    const project = makeRecutRepo()
    const result = await applyPlan(project, { op: "rename", from: "example/none", to: OMEGA })
    expect(result.exitCode).toBe(2)
    expect(status(project)).toBe("")
    expect(table).toContain("A recut that exits with 2 has written nothing.")
  })

  it("never discards the card map, and says so once", () => {
    const rule = section("## Rules").split("\n").find((line) => line.startsWith("10. ")) ?? ""
    expect(rule).toContain("Never edit `heptabase-map.json` or `heptabase.yaml`.")
    expect(rule).toContain("Never discard, revert, or reset `heptabase-map.json`, and never tell the user to do it.")
    expect(rule).toContain("It maps wiki pages to Heptabase cards, and nothing can rebuild it.")
    expect(skill.match(/nothing can rebuild it/g)).toHaveLength(1)
    expect(skill.match(/never to discard/g)).toBeNull()
  })

  it("ends the table with a row that shows any other problem and stops", () => {
    const rows = table.split("\n").filter((line) => line.startsWith("| ") && !line.startsWith("| The problem says") && !line.startsWith("|---"))
    expect(rows[rows.length - 1]).toBe("| Anything else | Show the problem as it is. Stop. Do not try another way to make the change. |")
  })

  it("a stack hypothesis that a merge would give one domain is refused, and the skill sends the user back to the plan", async () => {
    const stack = ["---", "type: hypothesis", "relation: stack", "title: Layers", `from_domain: ${ALPHA}`, `to_domain: ${BETA}`, "---", "", "# Layers", ""].join("\n")
    const project = makeRecutRepo({ "wiki/hypotheses/idea.md": stack })
    const result = await applyPlan(project, { op: "merge", from: [ALPHA, BETA], into: { domain: GAMMA, lens: "ai", description: "About gamma" } })
    expect(result.exitCode).toBe(2)
    expect(result.output.problems).toEqual([expect.stringContaining("relation stack needs two domains")])
    expect(status(project)).toBe("")
    expect(table).toContain("| A hypothesis with `relation: stack` would get one domain |")
    expect(table).toContain("Change the plan so that the two domains of the page stay two domains.")
    const merge = section("## Plan a merge")
    expect(merge).toContain("`recut apply` refuses the plan, because a stack needs two domains.")
    expect(merge).toContain("For another relation, `recut apply` gives a note.")
  })
})

describe("wiki-recut skill: calls to the llm_wiki MCP and the merge candidates", () => {
  const adds = blocks.filter((block) => block.tool === "llm_wiki_add_review")

  it("files each merge candidate as a duplicate item with the domain and the slug in the title (ruling U12)", () => {
    expect(adds).toHaveLength(1)
    const [add] = adds
    expect(add.json.project_id).toBe("<project folder>")
    expect(add.json.type).toBe("duplicate")
    expect(add.json.title).toBe("Recut merge (<target domain>): <slug>")
    expect(Array.isArray(add.json.affectedPages) && add.json.affectedPages.length === 2).toBe(true)
    expect(apiReviewTypes()).toContain(add.json.type)
    expect(skill).toContain("Pass `project_id` to every `llm_wiki_*` project tool.")
    expect(blocks.every((block) => block.tool === null || block.tool === "llm_wiki_add_review")).toBe(true)
  })

  it("sends no options (ruling S17), and any option it would send is allowed", () => {
    for (const block of blocks) {
      expect(block.json.options).toBeUndefined()
      const options = Array.isArray(block.json.options) ? (block.json.options as Array<{ action: string }>) : []
      for (const option of options) expect(isAllowedApiReviewAction(option.action), option.action).toBe(true)
    }
  })

  // Final review, I1 (ruling U20): the app never writes two pages of one name in one folder. The second page gets the
  // suffix `--<domain>`, so the pairs of a merge are pairs of `attention` and `attention--beta`.
  it("files one item for each group of pages with one name, because two groups with one slug would have one title", async () => {
    const after = section("## After the recut")
    expect(after).toContain("The app gives the second page of a name the suffix `--<domain>`, so `attention` and `attention--beta` have the same name.")
    expect(after).toContain("Group the pairs. Pages that are in one pair, or in pairs that share a page, are one group.")
    expect(after).toContain("The slug of a group is its shortest file name, without the folder and without `.md`.")
    expect(after).toContain("For each group, call `llm_wiki_add_review` once, with the arguments below.")
    expect(after).toContain("`affectedPages` holds every page of the group.")
    expect(after).toContain("The id of an item comes from the type and the title.")
    // The tool really gives such pairs, and the shortest name of the group is the plain name.
    const attention = (domain: string) => ["---", "type: concept", "title: Attention", `domain: ${domain}`, "---", "", "# Attention", ""].join("\n")
    const project = makeRecutRepo({
      "wiki/concepts/attention.md": attention(ALPHA),
      "wiki/concepts/attention--beta.md": attention(BETA),
    })
    const merge = await applyPlan(project, { op: "merge", from: [ALPHA, BETA], into: { domain: GAMMA, lens: "ai", description: "About gamma" } })
    expect(merge.output.mergeCandidates).toEqual([{ a: "wiki/concepts/attention--beta.md", b: "wiki/concepts/attention.md" }])
  })

  it("makes no more calls when the app does not run, shows the text of the failed call, and prints the groups", () => {
    const after = section("## After the recut")
    expect(after).toContain("If the app does not run, or a call fails, make no more calls. Show the text of the failed call to the user. Print the groups that have no item.")
    expect(section("## Before you start")).toContain("For a merge, the app must run, or the merge cannot file its review items.")
    expect(section("## Requirements")).toContain("`LLM_WIKI_API_TOKEN` in the environment of the `llm_wiki` MCP.")
  })

  // Final review, I3 (ruling U21).
  it("tells the user that a work wiki keeps the old names after the recut of a reading wiki", async () => {
    const result = await applyPlan(makeRecutRepo(), { op: "rename", from: ALPHA, to: OMEGA })
    expect(result.output.notes?.[0]).toContain("A work wiki whose mechanism_library is this wiki keeps the old names in the from_domain and to_domain of its hypothesis pages.")
    const after = section("## After the recut")
    expect(after).toContain("If `notes` says that this is a reading wiki, tell the user this.")
    expect(after).toContain("A work wiki whose `mechanism_library` is this wiki keeps the old names in the `from_domain` and `to_domain` of its hypothesis pages.")
    expect(after).toContain("Those pages need the new names from the note.")
    expect(after).toContain("`fuse check` and the lint of the work wiki report them")
    expect(section("## Report")).toContain("For a reading wiki, the names that a work wiki must change.")
  })

  // Final review, M7.
  it("tells the user to run the lint to see the new domain sizes", () => {
    const after = section("## After the recut")
    expect(after).toContain("Tell the user to run Lint in the app, or `wiki-tool lint structure`, to see the new domain sizes.")
    expect(after).toContain("The lint view shows the old items until then.")
  })

  it("tells the user that wiki-undo reverts the commit, and that the property is not in git", () => {
    const after = section("## After the recut")
    expect(after).toContain("`wiki-undo` reverts the commit of the recut.")
    expect(after).toContain("The `domain` property of a card is not in git.")
    expect(readRepoFile("plugins/llm-wiki/skills/wiki-undo/SKILL.md")).toContain("`recut:`")
  })
})

describe("wiki-recut skill: the file", () => {
  it("states the advice about the undo, the card map, and the options once, and points to them", () => {
    expect(skill.match(/`wiki-undo` reverts the commit/g)).toHaveLength(1)
    expect(skill.match(/nothing can rebuild it/g)).toHaveLength(1)
    // The options are explained in their own section; the other places name the section.
    expect(skill.match(/Tell the user to add these options to the `domain` property/g)).toHaveLength(1)
    expect(section("## Purpose")).toContain('("Heptabase options")')
    expect(section("## Before you start")).toContain("Rule 4 and Rule 10 say what to tell the user about the other changes.")
  })

  it("has no \"should\"", () => {
    expect(skill).not.toMatch(/\bshould\b/i)
  })

  it("has a name, a description, and short sentences", () => {
    expect(skill).toMatch(/^---\nname: wiki-recut\ndescription: Use this skill to .+\n---\n/)
    expect(findLongSentences("SKILL.md", skill)).toEqual([])
  })
})
