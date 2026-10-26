/**
 * wiki-lint-skill.test.ts - the wiki-lint skill, the `wiki-tool lint` commands, and the review API must agree.
 *
 * The skill is text for an agent. These tests pin the parts that other code depends on, so a change in one place fails
 * until the others follow: the command lines and the output keys of `wiki-tool lint`, `project_id` in every
 * `llm_wiki_*` call, the review types, the title forms of ruling U12, the option actions of ruling S17, and the rule
 * of ruling U11 (the marker is written only after every finding was filed).
 */
import { readFileSync, rmSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, describe, expect, it, vi } from "vitest"
import { CONFIG_INVALID_CHECK } from "@/lib/mechanism-wiki/lint-structure"
import { isAllowedApiReviewAction } from "@/lib/review-option-actions"
import { LLM_RESOLVED_ACTION, RULE_RESOLVED_ACTION } from "@/lib/review-utils"
import { MECHANISM_SECTIONS } from "@/lib/wiki-config/section-headings"
import { DEFAULT_LINT_THRESHOLDS } from "@/lib/wiki-config/wiki-identity"
import { apiReviewTypes, fillPlaceholders, jsonBlocks, OPTION_PROBLEM, readRepoFile, wikiToolCommands } from "@/test-helpers/skill-contract"
import { findLongSentences } from "@/test-helpers/ste-check"
import { runCli } from "../../../tools/wiki-tool/src/cli"
import { LINT_GROUP } from "../../../tools/wiki-tool/src/lint"
import { DEFAULT_MAX_CHARS } from "../../../tools/wiki-tool/src/lint/batch"
import {
  BUSINESS,
  commit,
  conceptPage,
  hypothesisPage,
  HARDWARE,
  head,
  makeRepo,
  mechanismPage,
  PHYSICS,
  runLint,
  setMarker,
} from "../../../tools/wiki-tool/src/lint/lint-fixture"
import { removeProjects, writeProjectFile } from "../../../tools/wiki-tool/src/test-project"

// Each test starts git processes; a busy machine needs more than the default 5 s.
vi.setConfig({ testTimeout: 30_000 })

afterEach(removeProjects)

const SKILL_FILE = fileURLToPath(new URL("../../../plugins/llm-wiki/skills/wiki-lint/SKILL.md", import.meta.url))
const skill = readFileSync(SKILL_FILE, "utf8")

/** The text of the skill from one heading to the next heading of the same level or a higher one. */
function section(heading: string): string {
  const start = skill.indexOf(heading)
  expect(start, heading).toBeGreaterThan(-1)
  const level = heading.match(/^#+/)?.[0].length ?? 1
  const rest = skill.slice(start + heading.length)
  const next = rest.search(new RegExp(`^#{1,${level}} `, "m"))
  return next === -1 ? skill.slice(start) : skill.slice(start, start + heading.length + next)
}

/** A wiki with a marker: one ingest before it, one after it. The pages of the second ingest are in BUSINESS. */
function markedProject(): { project: string; marker: string } {
  const project = makeRepo()
  const marker = commit(project, "ingest: first (2 pages)", {
    "wiki/concepts/a.md": conceptPage(HARDWARE),
    "wiki/mechanisms/m.md": mechanismPage(),
  })
  setMarker(project, marker)
  commit(project, "ingest: second (1 pages)", { "wiki/concepts/b.md": conceptPage(BUSINESS) })
  return { project, marker }
}

describe("wiki-lint skill: the command lines", () => {
  const commands = wikiToolCommands(skill)

  it("names every command of the lint group, and only those", () => {
    expect(commands.map((command) => command.command).sort()).toEqual(["batch", "changed-domains", "mark", "structure"])
    expect(Object.keys(LINT_GROUP.commands).sort()).toEqual(["batch", "changed-domains", "mark", "structure"])
    for (const command of commands) expect(command.group, command.line).toBe("lint")
    expect(skill).toContain("`<command>` is `structure`, `changed-domains`, `batch`, or `mark`.")
  })

  it("gives each command only options that it takes", async () => {
    const { project } = markedProject()
    for (const command of commands) {
      const args = command.args.map((word) => fillPlaceholders(word, { "<project>": project, "<domain>": HARDWARE, "<noted commit>": head(project) }))
      const result = await runCli([command.group, command.command, ...args])
      expect(JSON.stringify(result.output), command.line).not.toMatch(OPTION_PROBLEM)
    }
  })

  it("names --max-chars, and the command takes it", async () => {
    expect(skill).toContain("`--max-chars <number>`")
    const { project } = markedProject()
    const result = await runLint("batch", project, "--domain", HARDWARE, "--max-chars", "60000")
    expect(result.exitCode).toBe(0)
    // The skill names the default of the tool, not a number of its own.
    expect(skill).toContain(`It holds at most ${DEFAULT_MAX_CHARS} characters.`)
    expect(DEFAULT_MAX_CHARS).toBe(60_000)
  })

  it("calls no other group of wiki-tool and no Heptabase tool", () => {
    expect(new Set(commands.map((command) => command.group))).toEqual(new Set(["lint"]))
    expect(skill).toContain("Call no Heptabase tool.")
    expect(skill).not.toMatch(/\b(read_whiteboard|list_cards|read_object|create_object|edit_object_content)\b/)
  })
})

describe("wiki-lint skill: the output keys that it names", () => {
  const named = (key: string): void => expect(skill, key).toContain(`\`${key}\``)

  it("structure gives findings with check, page, message, and domains", async () => {
    const project = makeRepo({ "wiki/concepts/a.md": conceptPage("not/a-domain") })
    const result = await runLint<{ findings: Array<Record<string, unknown>> }>("structure", project)
    expect(result.exitCode).toBe(0)
    expect(result.output.findings.length).toBeGreaterThan(0)
    for (const key of ["findings", "check", "page", "message", "domains"]) named(key)
    const keys = new Set(result.output.findings.flatMap((finding) => Object.keys(finding)))
    for (const key of ["check", "page", "message"]) expect(keys.has(key), key).toBe(true)
    // A finding about a domain has `page: null` and `domains`.
    const tooSmall = result.output.findings.find((finding) => finding.page === null)
    expect(tooSmall?.domains).toBeDefined()
  })

  it("structure shows config-invalid when a config file is broken, and changed-domains and batch exit 2", async () => {
    const project = makeRepo({ "domains.yaml": "version: 1\ndomains: [not, a, map]\n" })
    const structure = await runLint<{ findings: Array<{ check: string }> }>("structure", project)
    expect(structure.exitCode).toBe(0)
    expect(structure.output.findings.map((finding) => finding.check)).toContain("config-invalid")
    expect(CONFIG_INVALID_CHECK).toBe("config-invalid")
    expect(structure.output.findings.map((finding) => finding.check)).toContain(CONFIG_INVALID_CHECK)
    named(CONFIG_INVALID_CHECK)
    expect((await runLint("changed-domains", project)).exitCode).toBe(2)
    expect((await runLint("batch", project, "--domain", HARDWARE)).exitCode).toBe(2)
    expect(skill).toContain("`changed-domains` and `batch` exit with 2 when a config file is not valid")
    expect(skill).toContain("`structure` then shows `config-invalid` findings")
  })

  it("structure exits 2 for a folder that is not a mechanism wiki", async () => {
    const project = makeRepo()
    rmSync(join(project, "domains.yaml"))
    const result = await runLint("structure", project)
    expect(result.exitCode).toBe(2)
    expect(skill).toContain("A project without `domains.yaml` is not a mechanism wiki.")
  })

  it("changed-domains gives since, domains, mechanismsChanged, and ingestsSince", async () => {
    const { project, marker } = markedProject()
    const result = await runLint<Record<string, unknown>>("changed-domains", project)
    expect(result.exitCode).toBe(0)
    expect(result.output).toMatchObject({ since: marker, domains: [BUSINESS], mechanismsChanged: false, ingestsSince: 1 })
    for (const key of ["since", "domains", "mechanismsChanged", "ingestsSince"]) named(key)
  })

  it("changed-domains lists every domain when there is no marker, and mechanismsChanged is true with a mechanism page", async () => {
    const project = makeRepo()
    commit(project, "ingest: first (2 pages)", { "wiki/concepts/a.md": conceptPage(HARDWARE), "wiki/mechanisms/m.md": mechanismPage() })
    const result = await runLint<{ since: unknown; domains: string[]; mechanismsChanged: boolean }>("changed-domains", project)
    expect(result.output.since).toBeNull()
    expect(result.output.domains).toHaveLength(3)
    expect(result.output.mechanismsChanged).toBe(true)
    expect(skill).toContain("It is `null` when there is no usable marker. Then `domains` lists every domain of `domains.yaml`")
    expect(skill).toContain("`mechanismsChanged` is true when the wiki has a mechanism page")
  })

  it("changed-domains gives note when the marker cannot be used", async () => {
    const { project } = markedProject()
    writeProjectFile(project, ".llm-wiki/semantic-lint.json", "not json")
    const result = await runLint<{ since: unknown; note?: string }>("changed-domains", project)
    expect(result.output.since).toBeNull()
    expect(typeof result.output.note).toBe("string")
    named("note")
  })

  it("changed-domains counts committed changes only", async () => {
    const { project } = markedProject()
    writeProjectFile(project, "wiki/concepts/c.md", conceptPage(PHYSICS))
    const result = await runLint<{ domains: string[] }>("changed-domains", project)
    expect(result.output.domains).toEqual([BUSINESS])
    expect(skill).toContain("`changed-domains` counts commits only. Changes that are not committed do not count.")
  })

  it("batch gives batches of one type, leaves out also-only pages and mechanism pages, and notes a page above the limit", async () => {
    const project = makeRepo({
      "wiki/concepts/a.md": conceptPage(HARDWARE),
      "wiki/concepts/own-domain-b.md": conceptPage(BUSINESS, { also: [HARDWARE] }),
      "wiki/mechanisms/m.md": mechanismPage(),
      "wiki/hypotheses/h.md": hypothesisPage(PHYSICS, HARDWARE),
    })
    const result = await runLint<{ batches: string[][]; notes?: string[] }>("batch", project, "--domain", HARDWARE)
    expect(result.output.batches).toEqual([["wiki/concepts/a.md"], ["wiki/hypotheses/h.md"]])
    const small = await runLint<{ batches: string[][]; notes?: string[] }>("batch", project, "--domain", HARDWARE, "--max-chars", "5")
    expect(small.output.notes?.length).toBeGreaterThan(0)
    for (const key of ["batches", "notes"]) named(key)
    expect(skill).toContain("A page that names the domain only in `also` is not one. A mechanism page is not one.")
    expect(skill).toContain("A batch holds pages of one type.")
    expect(skill).toContain("A page above the limit is a batch alone, and `notes` names it.")
  })

  it("mark gives commit and at, and writes the marker file that the skill names", async () => {
    const { project } = markedProject()
    const result = await runLint<{ commit: string; at: string }>("mark", project)
    expect(result.exitCode).toBe(0)
    expect(Object.keys(result.output).sort()).toEqual(["at", "commit", "ok"])
    for (const key of ["commit", "at"]) named(key)
    expect(skill).toContain("`.llm-wiki/semantic-lint.json`")
    const marked = await runLint<{ since: string }>("changed-domains", project)
    expect(marked.output.since).toBe(result.output.commit)
  })

  // Final review, M5.
  it("mark --commit marks the commit that the skill noted, also after a commit came in during the lint", async () => {
    const { project } = markedProject()
    const noted = head(project)
    const arrived = commit(project, "ingest: third (1 pages)", { "wiki/concepts/c.md": conceptPage(PHYSICS) })
    const result = await runLint<{ commit: string }>("mark", project, "--commit", noted)
    expect(result.exitCode).toBe(0)
    expect(result.output.commit).toBe(noted)
    // The pages of the commit that came in are changes at the next lint.
    const next = await runLint<{ since: string; domains: string[] }>("changed-domains", project)
    expect(next.output.since).toBe(noted)
    expect(next.output.domains).toEqual([PHYSICS])
    expect(head(project)).toBe(arrived)
    expect(skill).toContain("With `--commit <sha>`, it marks that commit.")
    expect(skill).toContain("The commit must be `HEAD` or one of its ancestors. If it is not, `mark` exits with 2 and writes nothing.")
  })

  it("the reminder uses the key and the default that wiki.yaml has", () => {
    expect(DEFAULT_LINT_THRESHOLDS.semantic_reminder_ingests).toBe(10)
    expect(skill).toContain("`lint.semantic_reminder_ingests`")
    expect(skill).toContain("If the key is missing, the value is 10.")
    expect(readRepoFile("templates/mechanism-wiki/wiki.yaml")).toContain("semantic_reminder_ingests: 10")
  })
})

describe("wiki-lint skill: the order of the steps (ruling U11)", () => {
  const steps = skill.slice(skill.indexOf("## Steps"))

  it("runs structure, changed-domains, batch, and mark in that order, and mark after the filing rules", () => {
    const at = (needle: string): number => {
      const found = steps.indexOf(needle)
      expect(found, needle).toBeGreaterThan(-1)
      return found
    }
    expect(at("### Step 1")).toBeLessThan(at("### Step 2"))
    expect(at("### Step 2")).toBeLessThan(at("### Step 3"))
    expect(at("### Step 3")).toBeLessThan(at("### Step 4"))
    expect(at("### Step 4")).toBeLessThan(at("### Step 5"))
    expect(section("### Step 1")).toContain("Run `lint structure`.")
    expect(section("### Step 2")).toContain("Run `lint changed-domains`.")
    expect(section("### Step 3")).toContain("Run `lint batch` for the domain.")
    expect(section("### Step 5")).toContain("Run `lint mark --commit \"<noted commit>\"` only as Rule 8 allows.")
    expect(skill.indexOf("## Filing a finding")).toBeLessThan(skill.indexOf("## Steps"))
    // Only Step 5 runs the command.
    expect(section("### Step 1")).not.toContain("lint mark")
    expect(section("### Step 3")).not.toContain("lint mark")
    expect(section("### Step 4")).not.toContain("lint mark")
  })

  it("states the rule of the marker once, in Rule 8, and points to it", () => {
    const rules = section("## Rules")
    const rule = rules.split("\n").find((line) => line.startsWith("8. ")) ?? ""
    expect(rule).toContain("Run `lint mark` only when the lint reached Step 5, the app ran, and every finding was filed.")
    expect(rule).toContain("An item that exists already counts as filed.")
    // Zero findings: nothing is left to file with the app up; with the app down no marker is written, also for zero findings.
    expect(rule).toContain("With no finding, nothing is left to file, so `lint mark` runs.")
    expect(rule).toContain("If the app does not run, run no `lint mark`, also when there is no finding.")
    expect(rule).toContain("print every finding that was not filed")
    expect(rule).toContain("Exit code 2 is one cause of a stop.")
    expect(rule).toContain("Tell the user to run the skill again with the app open.")
    // The other places point to Rule 8 and do not state the rule again.
    for (const text of [section("## Command lines"), section("### Step 1"), section("### Step 2"), section("## Requirements")]) {
      expect(text).toContain("Rule 8")
    }
    expect(section("## Command lines")).toContain("Then stop the lint as Rule 8 says.")
    expect(skill.match(/A marker after findings that were not filed/g)).toHaveLength(1)
    expect(skill.match(/Do not run `lint mark`/g)).toBeNull()
  })

  it("marks the commit that was noted in Step 2, not a newer HEAD (Rule 9)", () => {
    const rules = section("## Rules")
    const rule = rules.split("\n").find((line) => line.startsWith("9. ")) ?? ""
    expect(rule).toContain("Mark the commit that you noted in Step 2, with `--commit`. Never mark a newer `HEAD`.")
    expect(rule).toContain("The next lint reads its changes.")
    expect(section("### Step 2")).toContain("Run `git -C \"<project>\" rev-parse HEAD`. Note the commit as the noted commit.")
    const step5 = section("### Step 5")
    expect(step5).toContain("Print each finding that was not filed.")
    expect(step5).toContain("If `lint mark` exits with 2, show the problems. Say that no marker was written.")
    // The old stop for a moved HEAD is gone: Step 5 does not read HEAD again.
    expect(step5).not.toContain("rev-parse")
    expect(skill).not.toContain("HEAD moved")
  })

  it("makes no more llm_wiki calls after one fails, shows the text of the call, and keeps the findings for the report", () => {
    const filing = section("## Filing a finding")
    expect(filing).toContain("If `llm_wiki_status` fails, or any `llm_wiki_*` call fails, make no more `llm_wiki_*` calls.")
    expect(filing).toContain("Show the text of the failed call to the user.")
    expect(filing).toContain("Keep every finding that is not filed in a list")
    expect(section("## Report")).toContain("The findings that were not filed, in full")
  })

  it("reads the mechanism pages only when they changed or there is no marker", () => {
    expect(section("### Step 4")).toContain("Do this step when `mechanismsChanged` is true, or when `since` is `null`.")
    expect(section("### Step 4")).toContain("Read every mechanism page in full.")
    expect(section("### Step 4")).toContain("read the first section of each page in its `instances` list")
  })

  it("reads every page of a batch in full, and never edits a page", () => {
    expect(section("### Step 3")).toContain("Read every page of every batch in full.")
    expect(section("## Rules")).toContain("Never edit, create, move, or delete a file of the wiki. Only `lint mark` writes a file.")
    expect(section("## Rules")).toContain("Run no git command that changes the repository.")
    expect(section("## Rules")).toContain("Ask the user no question.")
    expect(skill).toContain("This skill never edits a page.")
  })

  it("tells the user to delete the marker to lint every domain, and never deletes it itself", () => {
    expect(section("### Step 2")).toContain("tell the user to delete `.llm-wiki/semantic-lint.json` and run the skill again")
    expect(section("### Step 2")).toContain("Never delete the file yourself.")
  })

  it("reminds the user when ingestsSince reaches the threshold", () => {
    expect(section("### Step 2")).toContain("If it is at least `lint.semantic_reminder_ingests`, say that this lint is overdue.")
  })
})

describe("wiki-lint skill: calls to the llm_wiki MCP and the review items", () => {
  const blocks = jsonBlocks(skill)
  const adds = blocks.filter((block) => block.tool === "llm_wiki_add_review")
  const lookups = blocks.filter((block) => block.tool === "llm_wiki_reviews")

  it("passes project_id, the project folder, in every llm_wiki_* call", () => {
    expect(adds).toHaveLength(2)
    expect(lookups).toHaveLength(1)
    expect(blocks.every((block) => block.tool !== null)).toBe(true)
    for (const block of blocks) expect(block.json.project_id, String(block.tool)).toBe("<project folder>")
    expect(skill).toContain("Pass `project_id` to every `llm_wiki_*` project tool.")
  })

  it("titles a layer 2 item with the domain, and a layer 3 item with mechanisms (ruling U12)", () => {
    const [layer2, layer3] = adds
    expect(layer2.json.title).toBe("Lint (<domain>): <short finding>")
    expect(layer3.json.title).toBe("Lint (mechanisms): <short finding>")
    expect(skill).toContain("A title of layer 2 is `Lint (<domain>): <short finding>`.")
    expect(skill).toContain("A title of layer 3 is `Lint (mechanisms): <short finding>`.")
    expect(skill).toContain("The id of an item comes from its type and its title.")
  })

  it("gives affectedPages to every item, and sends no options (ruling S17)", () => {
    for (const block of adds) {
      expect(Array.isArray(block.json.affectedPages) && block.json.affectedPages.length > 0, String(block.json.title)).toBe(true)
      expect(block.json.options).toBeUndefined()
    }
    expect(skill).toContain("Send no `options`. The app then adds one Dismiss button.")
    // The rule holds for any option a block would send.
    for (const block of blocks) {
      const options = Array.isArray(block.json.options) ? (block.json.options as Array<{ action: string }>) : []
      for (const option of options) expect(isAllowedApiReviewAction(option.action), option.action).toBe(true)
    }
  })

  it("maps each finding to a review type that the app accepts", () => {
    const table = section("## Filing a finding")
      .split("\n")
      .filter((line) => line.startsWith("| ") && !line.startsWith("| Finding") && !line.startsWith("|---"))
      .map((line) => line.split("|").map((cell) => cell.trim()).filter((cell) => cell !== ""))
    expect(table.map(([finding, type]) => [finding.replace(/ where .*$/, ""), type])).toEqual([
      ["Two pages contradict each other", "`contradiction`"],
      ["A newer source or a newer page replaces a claim", "`suggestion`"],
      ["Two pages describe the same thing", "`duplicate`"],
      ["A mechanism problem", "`suggestion`"],
      ["A mechanism problem", "`confirm`"],
    ])
    const accepted = apiReviewTypes()
    for (const [, type] of table) expect(accepted, type).toContain(type.split("`").join(""))
    for (const block of adds) expect(accepted).toContain(block.json.type)
  })

  it("looks for items that exist by title_prefix, before it files", () => {
    const [layer2] = adds
    const lookup = lookups[0].json
    expect(lookup).toEqual({ project_id: "<project folder>", status: "all", title_prefix: "Lint (<domain>): ", limit: 1000 })
    expect(String(layer2.json.title).startsWith(String(lookup.title_prefix))).toBe(true)
    const filing = section("## Filing a finding")
    expect(filing).toContain("The prefix ends in a space. Keep the space.")
    expect(filing).toContain("For layer 3, the prefix is `Lint (mechanisms): `.")
    expect(filing).toContain("Skip a finding when an item states it already")
    expect(skill).toContain("Never list the items and search the list for one item.")
    expect(filing.indexOf("title_prefix")).toBeLessThan(filing.indexOf("If `llm_wiki_status` fails"))
  })

  it("writes the items in the output language of the wiki, and in English when the wiki gives none, without a question", () => {
    const rule = section("## Rules").split("\n").find((line) => line.startsWith("7. ")) ?? ""
    expect(rule).toContain("in the output language of the wiki. Read it from the line `Output language:` in `purpose.md`.")
    expect(rule).toContain("If the line is missing or empty, write in English. Do not ask.")
  })

  it("names LLM_WIKI_API_TOKEN, which llm_wiki_add_review always needs", () => {
    expect(section("## Requirements")).toContain("`LLM_WIKI_API_TOKEN` in the environment of the `llm_wiki` MCP.")
    expect(section("## Requirements")).toContain("Adding a review item always needs it.")
    // The MCP tool says the same, so the skill and the tool agree on the name.
    expect(readRepoFile("mcp-server/src/review-tools.ts")).toContain("Adding a review item needs LLM_WIKI_API_TOKEN")
  })

  // Final review, M6: the sweep of the app closes some items by itself. The skill must not read those as decisions.
  it("skips a finding only for an open item or an item that the user resolved, not for one that the app closed", () => {
    const filing = section("## Filing a finding")
    expect(LLM_RESOLVED_ACTION).toBe("llm-judged")
    expect(RULE_RESOLVED_ACTION).toBe("auto-resolved")
    expect(filing).toContain("Skip a finding when an item states it already and the user decides about it.")
    expect(filing).toContain("`Resolved action`")
    expect(filing).toContain(`The app closes some items by itself, with the action \`${LLM_RESOLVED_ACTION}\` or \`${RULE_RESOLVED_ACTION}\`.`)
    expect(filing).toContain("Such an item does not state the finding.")
    // The same title would merge into the closed item, so the finding gets a new title.
    expect(filing).toContain("File that finding with a new title.")
    expect(filing).toContain("The old title would merge into the closed item, and the finding would stay closed.")
  })
})

describe("wiki-lint skill: the checks of layer 2 and layer 3", () => {
  it("names the three problems of layer 2", () => {
    const step3 = section("### Step 3")
    for (const text of ["Contradiction:", "Superseded claim:", "Duplicate pages:"]) expect(step3, text).toContain(text)
  })

  it("names the four problems of layer 3, and the mechanism rule file that defines them", () => {
    const step4 = section("### Step 4")
    for (const text of ["Domain detail in a mechanism:", "Two mechanisms that are the same:", "An instance that does not fit:", "A missing failure condition:"]) {
      expect(step4, text).toContain(text)
    }
    expect(step4).toContain("Use `confirm` for two mechanisms that may be the same. Use `suggestion` for the others.")
    const rules = readRepoFile("templates/mechanism-wiki/schema/page-types/mechanism.md")
    expect(rules).toContain("Write at least one failure condition.")
    expect(rules).toContain("Write an industry name, a vendor name, a product name, or a number that belongs to one domain.")
    expect(step4).toContain("Read `schema/page-types/mechanism.md`.")
  })

  it("ties each check of layer 3 to mechanism.md: the failure section by its key and its three headings, the parts and the flows", () => {
    const step4 = section("### Step 4")
    const rules = readRepoFile("templates/mechanism-wiki/schema/page-types/mechanism.md")
    const failure = MECHANISM_SECTIONS.find((candidate) => candidate.key === "failure")
    expect(failure).toBeDefined()
    expect(step4).toContain("the Failure conditions section (key `failure`)")
    for (const heading of [failure?.en, failure?.zhHant, failure?.zhHans]) {
      expect(step4, String(heading)).toContain(`\`${heading}\``)
      expect(rules, String(heading)).toContain(`| \`failure\` |`)
      expect(rules, String(heading)).toContain(String(heading))
    }
    // A condition that one instance has is no condition of the mechanism: mechanism.md says so in its Do not list.
    expect(rules).toContain("Write a failure condition that only one instance has.")
    expect(step4).toContain("holds only a condition that one instance has")
    // The parts and the flows are sections of mechanism.md, and the check of two mechanisms compares them.
    for (const key of ["parts", "flows"]) {
      const section = MECHANISM_SECTIONS.find((candidate) => candidate.key === key)
      expect(rules, key).toContain(`| \`${key}\` | ${section?.en} |`)
    }
    expect(step4).toContain("compare the one-line statement, the parts, and the flows of each mechanism")
    expect(rules).toContain("Write the title, then one line that states the mechanism.")
  })

  it("is a file with a name, a description, and short sentences", () => {
    expect(skill).toMatch(/^---\nname: wiki-lint\ndescription: Use this skill to .+\n---\n/)
    // The description is what makes an agent pick the skill: it says "lint", as the name and the user do.
    expect(skill).toMatch(/^description: .*\blint\b/m)
    expect(findLongSentences("SKILL.md", skill)).toEqual([])
  })
})
