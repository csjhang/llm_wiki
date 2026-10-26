/**
 * wiki-fuse-skill.test.ts - the wiki-fuse skill, the app, and the review API must agree.
 *
 * The skill is text for an agent. These tests pin the parts that other code depends on, so a change in one place fails
 * until the others follow: the title prefix of a verify item (ruling S16), the `CANDIDATE:` line and `affectedPages[0]`
 * (S9), `project_id` in every `llm_wiki_*` call (S3), the lookup of an item by `id` and by `title_prefix` (S18), the
 * resolve action, and the option actions that the review API accepts (S17).
 */
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { readCandidateLines } from "@/lib/mechanism-wiki/fusion-candidates"
import { isAllowedApiReviewAction } from "@/lib/review-option-actions"
import { jsonBlocks } from "@/test-helpers/skill-contract"
import { findLongSentences } from "@/test-helpers/ste-check"

const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url))
const SKILLS_DIR = join(REPO_ROOT, "plugins/llm-wiki/skills")
const FUSE_DIR = join(SKILLS_DIR, "wiki-fuse")

const skill = readFileSync(join(FUSE_DIR, "SKILL.md"), "utf8")
const directed = readFileSync(join(FUSE_DIR, "reference/directed.md"), "utf8")
const explore = readFileSync(join(FUSE_DIR, "reference/explore.md"), "utf8")
const update = readFileSync(join(FUSE_DIR, "reference/update.md"), "utf8")
const hypothesisRules = readFileSync(join(REPO_ROOT, "templates/mechanism-wiki/schema/page-types/hypothesis.md"), "utf8")

function markdownFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) return markdownFiles(path)
    return entry.name.endsWith(".md") ? [path] : []
  })
}

const fuseBlocks = [
  ...jsonBlocks(directed, "directed.md"),
  ...jsonBlocks(explore, "explore.md"),
  ...jsonBlocks(update, "update.md"),
]
const llmWikiBlocks = fuseBlocks.filter((block) => block.tool?.startsWith("llm_wiki_"))

describe("wiki-fuse skill: calls to the llm_wiki MCP", () => {
  it("passes project_id, the project folder, in every llm_wiki_* call", () => {
    const tools = new Set(llmWikiBlocks.map((block) => block.tool))
    // The guard fails when the scan stops finding the blocks, so it cannot pass with nothing to check.
    expect([...tools].sort()).toEqual(["llm_wiki_add_review", "llm_wiki_resolve_review", "llm_wiki_reviews", "llm_wiki_search"])
    expect(llmWikiBlocks.length).toBeGreaterThanOrEqual(7)
    for (const block of llmWikiBlocks) {
      expect(block.json.project_id, `${block.source}: ${block.tool}`).toBe("<project folder>")
    }
    expect(skill).toContain("Pass `project_id` to every `llm_wiki_*` project tool.")
  })

  it("resolves a candidate item with the action fused, and a verify item with Evaluated", () => {
    const resolves = llmWikiBlocks.filter((block) => block.tool === "llm_wiki_resolve_review")
    expect(resolves.map((block) => block.json.action).sort()).toEqual(["Evaluated", "fused"])
    const fused = resolves.find((block) => block.json.action === "fused")
    expect(fused?.json).toEqual({ project_id: "<project folder>", id: "<review id>", action: "fused" })
    expect(explore).toContain('"action": "fused"')
  })
})

describe("wiki-fuse skill: the lookup of a review item (ruling S18)", () => {
  const candidateSection = explore.slice(explore.indexOf("## Start from a candidate"))

  it("--candidate finds its item by id, with the type, and never searches a list", () => {
    const lookup = jsonBlocks(candidateSection, "explore.md").find((block) => block.tool === "llm_wiki_reviews")
    expect(lookup?.json).toEqual({
      project_id: "<project folder>",
      id: "<review id>",
      type: "fusion-candidate",
      status: "all",
    })
    expect(candidateSection).toContain("Never list the items and search for the `ID`.")
    expect(candidateSection).not.toContain('"limit"')
    expect(candidateSection).not.toContain('as in "Explore" step 1')
  })

  it("explore mode lists the candidates, and raises the limit to 1000 when Count equals the limit", () => {
    const exploreSection = explore.slice(explore.indexOf("## Explore"), explore.indexOf("## Start from a candidate"))
    const list = jsonBlocks(exploreSection, "explore.md").find((block) => block.tool === "llm_wiki_reviews")
    expect(list?.json).toMatchObject({ type: "fusion-candidate", status: "unresolved", limit: 50 })
    expect(exploreSection).toContain("If `Count` in the answer equals `limit`")
    expect(exploreSection).toContain('Call again with `"limit": 1000`')
    expect(exploreSection).toContain("some candidates may be missing")
  })

  it("update mode finds the verify items by title_prefix", () => {
    const lookup = jsonBlocks(update, "update.md").find((block) => block.tool === "llm_wiki_reviews")
    expect(lookup?.json).toEqual({
      project_id: "<project folder>",
      type: "suggestion",
      status: "unresolved",
      title_prefix: "Verify (<hypothesis slug>): ",
    })
    expect(update).toContain("The prefix ends in a space. Keep the space.")
  })

  it("SKILL.md tells the agent to use id or title_prefix, and not to search the list", () => {
    expect(skill).toContain("lists the oldest item first and stops at `limit`")
    expect(skill).toContain("pass `id` or `title_prefix`")
    expect(skill).toContain("Never list the items and search the list for one item.")
  })
})

describe("wiki-fuse skill: the verify item title prefix (ruling S16)", () => {
  const add = jsonBlocks(directed, "directed.md").find((block) => block.tool === "llm_wiki_add_review" && block.json.type === "suggestion")
  const PREFIX = "Verify (<hypothesis slug>): "

  it("directed mode titles each item with the prefix, the type suggestion, and the page in affectedPages", () => {
    expect(add?.json.title).toBe(`${PREFIX}<claim, short>`)
    expect(add?.json.affectedPages).toEqual(["wiki/hypotheses/<slug>.md"])
    expect(add?.json.options).toBeUndefined()
  })

  it("update mode matches with the same prefix, up to the claim", () => {
    const lookup = jsonBlocks(update, "update.md").find((block) => block.tool === "llm_wiki_reviews")
    expect(lookup?.json.title_prefix).toBe(PREFIX)
    expect(String(add?.json.title).startsWith(String(lookup?.json.title_prefix))).toBe(true)
    expect(update).toContain("The title of the item of a row is `Verify (<hypothesis slug>): ` and the start of the claim of the row.")
  })

  it("says why the slug is in the title", () => {
    expect(directed).toContain("The id of the item comes from the type and the title.")
  })
})

describe("wiki-fuse skill: the candidate item that the app writes (ruling S9)", () => {
  it("names the CANDIDATE line format that the app writes and reads", () => {
    expect(explore).toContain("CANDIDATE: <domain> | <strength> | <reason>")
    const line = "CANDIDATE: business/inventory | structural | The detector fits the stock alert."
    expect(readCandidateLines(`Domains where X may also work:\n${line}`)).toEqual([
      { domain: "business/inventory", strength: "structural", reason: "The detector fits the stock alert." },
    ])
  })

  it("says that the mechanism page is the first entry of affectedPages", () => {
    expect(explore).toContain("The first entry of `affectedPages` is the mechanism page.")
    expect(explore).toContain("The mechanism page is the first entry of `affectedPages` of the item.")
  })

  it("copies the command that the app copies, and the app writes no project path", () => {
    expect(skill).toContain("`/wiki-fuse --candidate <review id>`")
    expect(readFileSync(join(REPO_ROOT, "src/lib/mechanism-wiki/review-actions.ts"), "utf8")).toContain(
      "`/wiki-fuse --candidate ${item.id}`",
    )
  })
})

describe("wiki-fuse skill: option actions of review items (ruling S17)", () => {
  /** Every option of every json block in every skill file. */
  const options = markdownFiles(SKILLS_DIR).flatMap((file) =>
    jsonBlocks(readFileSync(file, "utf8"), file).flatMap((block) => {
      const list = block.json.options
      return Array.isArray(list) ? list.map((option) => ({ file, option: option as { label: string; action: string } })) : []
    }),
  )

  it("finds the options that the skill sends", () => {
    const actions = options.map(({ option }) => option.action)
    expect(actions).toContain("mech:propose-mechanism")
    expect(actions).toContain("Skip")
    expect(options.length).toBeGreaterThanOrEqual(3)
  })

  it("sends only actions that the review API accepts", () => {
    for (const { file, option } of options) {
      expect(isAllowedApiReviewAction(option.action), `${file}: ${option.action}`).toBe(true)
    }
  })

  it("keeps wiki-sync mirror-edited items and verify items on the default Dismiss button", () => {
    const steps = readFileSync(join(SKILLS_DIR, "wiki-sync/reference/mcp-steps.md"), "utf8")
    const mirror = jsonBlocks(steps, "mcp-steps.md").find((block) => block.json.type === "mirror-edited")
    expect(mirror, "mirror-edited call").toBeDefined()
    expect(mirror?.json.options).toBeUndefined()
  })

  it("sends a new-mechanism item to the reading wiki only from a work wiki", () => {
    const step3 = directed.slice(directed.indexOf("## Step 3"), directed.indexOf("## Step 4"))
    expect(step3).toContain("In a work wiki, tell the user that the mechanism needs approval first.")
    expect(step3).toContain("In a reading wiki, tell the user that the mechanism page can be written in this wiki directly.")
    expect(step3).toContain("This reading wiki can hold the mechanism page itself. Write the page here directly.")
    const readingOptions = jsonBlocks(step3, "directed.md").find((block) => block.json.type === undefined && block.json.options !== undefined)
    expect(readingOptions?.json.options).toEqual([{ label: "Skip", action: "Skip" }])
    // The note that mech:propose-mechanism writes fits a work wiki only.
    expect(readFileSync(join(REPO_ROOT, "src/lib/mechanism-wiki/review-actions.ts"), "utf8")).toContain("Instances: 1 in work wiki")
  })
})

describe("wiki-fuse skill: reading order and links", () => {
  it("reads CLAUDE.md of the target wiki before any page, in explore and update mode", () => {
    const beforeExploreSteps = explore.slice(0, explore.indexOf("## Explore"))
    expect(beforeExploreSteps).toContain("Read its `CLAUDE.md` first, before you read any page.")
    const beforeUpdateSteps = update.slice(0, update.indexOf("## Steps"))
    expect(beforeUpdateSteps).toContain("Read `CLAUDE.md` of the wiki before you read any page.")
    expect(update).not.toMatch(/^2\. Read `CLAUDE\.md`/m)
  })

  it("Rule 1 has no branch for a target wiki that is not the project folder", () => {
    const rule = skill.split("\n").find((line) => line.startsWith("1. Read `CLAUDE.md`")) ?? ""
    expect(rule).toBe("1. Read `CLAUDE.md` of the target wiki before you read or write a page of it. Follow its read order.")
    expect(skill).not.toContain("read the `CLAUDE.md` of both")
  })

  it("leaves out target cards of another wiki, and names them in the report", () => {
    const step2 = directed.slice(directed.indexOf("## Step 2"), directed.indexOf("## Step 3"))
    expect(step2).toContain("Leave out each target card whose `wiki` is not the target wiki.")
    expect(step2).toContain("Add the card to the cards that you left out. The report names them.")
    expect(skill).toContain("The cards of the whiteboard that were left out, and why.")
  })

  it("tells the agent about check warnings and about the work wiki link rule", () => {
    expect(skill).toContain("`check` adds a list `warnings`")
    expect(skill).toContain("A warning does not fail the page.")
    expect(skill).toContain("In a work wiki, `check` fails on a link to the mechanism page of the reading wiki")
    expect(directed).toContain("`fuse check` fails on a link to it.")
    expect(skill).toContain("A relative path in an option starts at the folder of `--project`")
  })

  it("explore mode sends a never-again answer to the Skip button, and drops candidates that have an instance now", () => {
    expect(explore).toContain("tell the user to press Skip on the card of that candidate in the app")
    expect(explore).toContain("Only Skip records the pair in `fusion-dismissed.json`")
    expect(explore).toContain("Drop an open candidate when its target domain has an instance of the mechanism now.")
  })
})

describe("wiki-fuse skill: the status rules are in the rule file only (ruling S15)", () => {
  it("update mode points to the Do list instead of restating the rules", () => {
    expect(update).toContain("`fuse check` follows the status rules in the Do list of `schema/page-types/hypothesis.md`.")
    expect(update).not.toContain("`refuted` needs one row that links an evidence page")
    expect(update).not.toContain("`supported` needs a link in every row")
  })

  it("the checklist of the rule file points to the Do list instead of restating the rules", () => {
    const checklist = hypothesisRules.slice(hypothesisRules.indexOf("## Checklist"))
    expect(checklist).toContain("Does `status` follow the status rules in the Do list of the Rules section?")
    expect(checklist).not.toContain("needs a linked evidence page")
    // The rules themselves are still in the Do list.
    expect(hypothesisRules).toContain("Set `status: supported` only when evidence from the top two ranks resolves every row")
    expect(hypothesisRules).toContain("Set `status: refuted` only when evidence from the top two ranks refutes one row")
  })
})

describe("wiki-fuse skill: short sentences", () => {
  it("keeps every sentence short", () => {
    expect(findLongSentences("SKILL.md", skill)).toEqual([])
    expect(findLongSentences("directed.md", directed)).toEqual([])
    expect(findLongSentences("explore.md", explore)).toEqual([])
    expect(findLongSentences("update.md", update)).toEqual([])
    expect(findLongSentences("hypothesis.md", hypothesisRules)).toEqual([])
  })
})
