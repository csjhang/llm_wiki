/**
 * wiki-sync-skill.test.ts - the wiki-sync skill and the wiki-tool commands it runs must agree.
 *
 * The skill is text for an agent. These tests keep it in step with the tool: every action the plan can give has a
 * section, every record event the skill names is one the tool takes, and the rules that must be said once are said once.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterAll, describe, expect, it } from "vitest"
import { runCli } from "../../../tools/wiki-tool/src/cli"
import { isAllowedApiReviewAction } from "@/lib/review-option-actions"
import { PANEL_ENTRIES } from "@/lib/skill-panel/panel-config"
import { findLongSentences } from "@/test-helpers/ste-check"

const SKILL_DIR = fileURLToPath(new URL("../../../plugins/llm-wiki/skills/wiki-sync/", import.meta.url))
const skill = readFileSync(join(SKILL_DIR, "SKILL.md"), "utf8")
const steps = readFileSync(join(SKILL_DIR, "reference/mcp-steps.md"), "utf8")

const scratch = mkdtempSync(join(tmpdir(), "wiki-sync-skill-"))
afterAll(() => rmSync(scratch, { recursive: true, force: true }))

describe("wiki-sync skill", () => {
  it("has a section for every action of plan-down and plan-up", () => {
    for (const op of ["create", "setup", "update", "relink", "retire", "skip-edited", "place", "snapshot", "ask", "download-pdf"]) {
      const named = op === "update" || op === "relink" ? "update and relink" : op
      expect(skill, op).toMatch(new RegExp(`^### ${named}$`, "m"))
    }
  })

  // Final review, I2(b): a retired card that the user deleted is dropped from the map. The skill makes no MCP call for it.
  it("records a forgotten event for a forget action, with no MCP call", () => {
    const down = skill.slice(skill.indexOf("## Down (wiki to Heptabase)"), skill.indexOf("### Record events"))
    expect(down).toContain("`forget`")
    expect(down).toContain("A `forget` action has no MCP call. Run `record` with a `forgotten` event for it.")
    expect(skill).toContain('{"type":"forgotten","page":"<page>"}')
  })

  it("names only record events that the tool takes", async () => {
    const types = [...new Set([...skill.matchAll(/"type":"([a-z-]+)"/g)].map((match) => match[1]))]
    expect(types.sort()).toEqual(["created", "feedback", "forgotten", "placed", "relinked", "retired", "setup-done", "up-decision", "updated"])
    for (const type of types) {
      const result = await runCli(["hepta", "record", "--project", scratch, "--event", JSON.stringify({ type })])
      expect(JSON.stringify(result.output), type).not.toContain("unknown event type")
    }
  })

  it("creates a card as record created with setup false, then setup, then record setup-done", () => {
    const create = skill.slice(skill.indexOf("### create"), skill.indexOf("### setup"))
    const order = ["create_object", "record", "update_database_card_membership", "edit_card_properties", "list_cards", "setup-done"]
    let at = -1
    for (const word of order) {
      const next = create.indexOf(word, at + 1)
      expect(next, word).toBeGreaterThan(at)
      at = next
    }
    expect(create).toContain('"setup": false')
    expect(create).toContain("lowercase UUID")
    expect(create).toContain("heptabase-map.json")
    expect(create).toContain("must equal the `title` of the action")
    expect(skill).toContain('"setup":false')
  })

  it("states the rule for a failed call once, and points to it", () => {
    expect(skill.match(/"runOn": \{"type": "server"\}/g)).toHaveLength(1)
    expect(steps).not.toContain("runOn")
    expect(skill).toMatch(/^## When a call fails$/m)
    const rule = skill.slice(skill.indexOf("## When a call fails"), skill.indexOf("## Before you start"))
    expect(rule).toContain("Never call `create_object` again, and never call `place_whiteboard_objects` again")
    expect(rule).toContain("A card that failed in this run is not tried again in this run.")
    expect(skill.match(/When a call fails/g)?.length).toBeGreaterThan(3)
    expect(steps).toContain("When a call fails")
  })

  it("checks the card right before it writes", () => {
    expect(skill).toMatch(/^### Check the card before a write$/m)
    for (const section of ["update and relink", "retire", "place"]) {
      const body = skill.slice(skill.indexOf(`### ${section}`)).split(/\n### |\n## /)[0]
      expect(body, section).toContain("Check the card before a write")
    }
  })

  it("sends the body file and gives the feedback command its --content files", () => {
    expect(skill).toContain("bodyFile")
    expect(skill).not.toMatch(/node -e/)
    const feedback = skill.slice(skill.indexOf("### skip-edited"), skill.indexOf("### place"))
    expect(feedback).toContain("--content")
    expect(feedback).not.toContain('"content"')
    expect(feedback).toContain("`note`")
  })

  it("adds a mirror-edited review item after the feedback note, and only when the app runs", () => {
    const feedback = skill.slice(skill.indexOf("### skip-edited"), skill.indexOf("### place"))
    expect(feedback.indexOf("--content")).toBeGreaterThan(-1)
    expect(feedback.indexOf("llm_wiki_add_review")).toBeGreaterThan(feedback.indexOf("--content"))
    expect(feedback).toContain("`mirror-edited`")
    expect(feedback).toContain("`project_id` set to the project folder")
    expect(feedback).toContain("`llm_wiki_status` said that the app runs")
    expect(feedback).toContain("If the app does not run, or the call fails, skip step 7")
    expect(feedback).toContain("The note is the record.")
    expect(skill).toMatch(/Say if a review item was added, or why it was not\./)
    const call = steps.slice(steps.indexOf("## llm_wiki_add_review"))
    expect(call).toContain('"type": "mirror-edited"')
    expect(call).toContain('"title": "Mirror card edited: <page path> (<note file name>)"')
    expect(call).toContain("`<note file name>` is the base name of `<note path>`, for example `feedback-<card id>-<stamp>.md`.")
    expect(call).toMatch(/Each edit has its own note, so each edit adds its own item\./)
    expect(call).not.toContain("adds no second item")
    expect(feedback).toContain("Each edit adds its own item.")
    expect(feedback).not.toContain("does not add a second item")
    expect(call).toContain('"affectedPages": ["<page path>"]')
    expect(call).toContain("The changes are in <note path>.")
    expect(call).toContain("`<note path>` is the `note` of the `record` result.")
  })

  it("gives the mirror-edited item the two options of spec 6.6, and each action is one the app allows", () => {
    const call = steps.slice(steps.indexOf("## llm_wiki_add_review"))
    expect(call).toContain(
      '"options": [{ "label": "Keep as feedback", "action": "dismiss" }, { "label": "Discard the edit", "action": "mech:discard-mirror-edit" }]',
    )
    expect(call).toContain("`Keep as feedback` only closes the item. The note is a source already.")
    expect(call).toContain("`Discard the edit` makes the next sync write the text of the wiki over the card. It covers this edit only.")
    // The actions are in the list of ruling S17, so the app takes the item.
    const actions = [...call.matchAll(/"action": "([^"]+)"/g)].map((match) => match[1])
    expect(actions).toEqual(["dismiss", "mech:discard-mirror-edit"])
    for (const action of actions) expect(isAllowedApiReviewAction(action), action).toBe(true)
  })

  it("says that a discarded edit comes as a normal update, with nothing else to do", () => {
    const update = skill.slice(skill.indexOf("### update and relink"), skill.indexOf("### retire"))
    expect(update).toContain("Discard the edit")
    expect(update).toContain("The `updated` event takes the page out of the list.")
    // Ruling W13: the choice covers the edit the user saw, so a newer edit is still a skip-edited action.
    expect(update).toContain("A newer edit still gets a `skip-edited` action.")
  })

  it("passes project_id, the project folder, in every call to a project tool of the llm_wiki MCP", () => {
    const names = ["llm_wiki_rescan_sources", "llm_wiki_add_review", "llm_wiki_resolve_review"]
    const sections = steps.split(/^## /m).filter((section) => names.some((name) => section.startsWith(`${name}\n`)))
    expect(sections.length).toBeGreaterThanOrEqual(2)
    for (const section of sections) {
      expect(section, section.split("\n")[0]).toContain('"project_id": "<project folder>"')
    }
  })

  it("lists whiteboards with depth 10, and rescans after the snapshots", () => {
    expect(steps).toMatch(/"offset": 0, "depth": 10/)
    expect(skill).toContain("`depth` 10")
    expect(skill).toContain("llm_wiki_rescan_sources")
    expect(steps).toMatch(/^## llm_wiki_rescan_sources$/m)
    expect(skill).toContain("source watch")
  })

  it("checks the whiteboard before every place", () => {
    const place = skill.slice(skill.indexOf("### place"), skill.indexOf("## Rules"))
    expect(place.indexOf("read_whiteboard")).toBeGreaterThan(-1)
    expect(place.indexOf("read_whiteboard")).toBeLessThan(place.indexOf("place_whiteboard_objects"))
  })

  it("asks the two-wikis and no-root questions with the answers this-wiki and skip", () => {
    const ask = skill.slice(skill.indexOf("### ask"), skill.indexOf("### snapshot"))
    for (const word of ["two-wikis", "no-root", "this-wiki", "skip"]) expect(ask, word).toContain(word)
    expect(skill).not.toContain("two-roots")
  })

  it("says to never discard or revert the card map", () => {
    expect(skill).toMatch(/Never discard, revert, or reset `heptabase-map.json`/)
    expect(skill).toMatch(/maps wiki pages to Heptabase cards/)
  })

  it("plans a mass retire again with --allow-mass-retire only after the user says yes", () => {
    const down = skill.slice(skill.indexOf("## Down (wiki to Heptabase)"), skill.indexOf("### Record events"))
    const step = down.slice(down.indexOf("\n8. "), down.indexOf("\n9. "))
    expect(step).toContain("`refusing to retire`")
    expect(step).toContain("--allow-mass-retire")
    expect(step).toMatch(/Show the user the count/)
    expect(step).toMatch(/Ask the user/)
    expect(step).toMatch(/Only after a yes/)
    expect(step).toContain("Do not retire a card by hand.")
    // The flag is for the plan that the user approved. A later plan that refuses again asks again.
    expect(step).toMatch(/this plan only/)
    expect(step).toMatch(/refuses again, ask the user again/)
    expect(step).not.toMatch(/every later plan/)
    // The first plan never carries the flag.
    expect(down.slice(down.indexOf("4. Run the plan:"), down.indexOf("\n5. "))).not.toContain("--allow-mass-retire")
    expect(down).toMatch(/`notes`/)
  })

  // Ruling W1: the panel runs `/wiki-sync --yes` in the background. Nobody can answer a question there.
  describe("run without questions", () => {
    const start = skill.indexOf("## Run without questions")
    const section = start === -1 ? "" : skill.slice(start).split(/\n## /)[0]

    it("is a section, and the panel runs the skill with the argument that the section names", () => {
      expect(skill).toMatch(/^## Run without questions$/m)
      const entry = PANEL_ENTRIES.find((candidate) => candidate.skill === "wiki-sync")
      expect(entry?.mode).toBe("background")
      expect(entry?.args).toBe("--yes")
      expect(section).toContain("`/wiki-sync --yes`")
    })

    it("is found from Before you start, which asks questions", () => {
      const before = skill.slice(skill.indexOf("## Before you start"), skill.indexOf("## Set up Heptabase"))
      expect(before).toContain("Run without questions")
      // The pointer comes first, so the agent reads it before step 1.
      expect(before.indexOf("Run without questions")).toBeLessThan(before.indexOf("\n1. "))
    })

    it("takes the press of the button as the yes for the plan, and runs Up, then Down", () => {
      expect(section).toMatch(/press of the button is the yes/)
      expect(section).toMatch(/Run Up, then Down\./)
      expect(section).toMatch(/Do not ask which direction/)
    })

    it("never asks the user a question", () => {
      expect(section).toMatch(/Never ask the user a question\./)
      expect(section).toMatch(/Do not wait for an answer\./)
    })

    it("never passes --allow-mass-retire, and retires no card when the plan refuses", () => {
      expect(section).toContain("`refusing to retire`")
      expect(section).toMatch(/Never pass `--allow-mass-retire`/)
      expect(section).toMatch(/Retire no card\./)
      // The flag is named to forbid it, and for no other reason.
      for (const sentence of section.split(/(?<=\.)\s/).filter((part) => part.includes("--allow-mass-retire"))) {
        expect(sentence).toMatch(/Never pass/)
      }
    })

    it("leaves out each step that needs a choice, and lists it in the report", () => {
      for (const word of ["`ask`", "`two-wikis`", "`no-root`", "select option", "`refusing to retire`", "`create_object`", "`clientTaskFailed`", "`place_whiteboard_objects`"]) {
        expect(section, word).toContain(word)
      }
      expect(section).toMatch(/Do not run `record` for it\./)
      expect(section).toMatch(/Leave out/)
      expect(section).toMatch(/Put .* in the report\./)
      // The report names the left-out steps.
      const report = skill.slice(skill.indexOf("## Report"))
      expect(report).toContain("Run without questions")
    })

    it("does not call a failed create or place again, and does not ask about it", () => {
      expect(section).toMatch(/Never call `create_object` again/)
      expect(section).toMatch(/Do not ask the user before a new try/)
      expect(section).toContain("When a call fails")
    })

    // Final review, M3: a denied tool in a background run is not a reason to look for another way in.
    it("does not look for another route when Claude Code denies a tool, and names the tool in the report", () => {
      expect(section).toContain("If Claude Code denies a tool, do not try another way. Leave out the step and name the tool in the report.")
      // It is one of the numbered steps, so a run reads it with the other rules of the section.
      expect(section).toMatch(/^\d+\. If Claude Code denies a tool, do not try another way\./m)
    })

    it("stops when heptabase.yaml is missing and says to run /wiki-sync once in a conversation", () => {
      expect(section).toContain("`heptabase.yaml`")
      expect(section).toMatch(/Do not do the section "Set up Heptabase"/)
      expect(section).toMatch(/run `\/wiki-sync` once in a conversation/)
    })

    it("points to the sections of the skill and does not copy their commands", () => {
      for (const name of ["Before you start", "Up (Heptabase to wiki)", "Down (wiki to Heptabase)", "When a call fails", "ask"]) {
        expect(section, name).toContain(name)
      }
      expect(section).not.toContain("wiki-tool.mjs")
      expect(section).not.toContain("--project")
      expect(section).not.toContain('"runOn"')
    })

    it("does not clash with the Rules: the rule to ask about every ask action has the exception", () => {
      const rules = skill.slice(skill.indexOf("## Rules"), skill.indexOf("## Report"))
      expect(rules).toContain("Ask the user about every `ask` action, except in a run without questions.")
      expect(rules).not.toMatch(/Ask the user about every `ask` action\. /)
      // No other rule or step tells a run without questions to ask: each one is covered by this section.
      expect(section).toContain("Never ask the user a question.")
    })

    it("keeps its sentences short", () => {
      expect(section).not.toBe("")
      expect(findLongSentences("SKILL.md", section)).toEqual([])
    })
  })

  // Ruling W15: two Down runs at once can plan the same new page. The tool has no lock, so the skill says to run one at a time.
  describe("one Down at a time", () => {
    const down = skill.slice(skill.indexOf("## Down (wiki to Heptabase)"), skill.indexOf("### Record events"))
    const beforeFirstStep = down.slice(0, down.indexOf("\n1. "))

    it("says in the Down section, before step 1, to run one Down at a time", () => {
      expect(beforeFirstStep).toContain("Run one Down at a time in a project.")
    })

    it("says why: two runs can plan the same new page and make two cards", () => {
      expect(beforeFirstStep).toMatch(/Two Down runs at the same time can plan the same new page and create two cards\./)
      expect(beforeFirstStep).toMatch(/The tool has no lock against this\./)
    })

    it("tells what to do when another run is going, without asking in a run without questions", () => {
      expect(beforeFirstStep).toContain("another run of `wiki-sync` or `wiki-fuse` is still going")
      expect(beforeFirstStep).toMatch(/do not start Down/)
      expect(beforeFirstStep).toMatch(/run it again after the other run ends/)
    })

    it("is read by wiki-fuse too: its Down step points to this section", () => {
      const directed = readFileSync(join(SKILL_DIR, "../wiki-fuse/reference/directed.md"), "utf8")
      expect(directed).toContain('Read the section "Down" of `<base>/../wiki-sync/SKILL.md`.')
    })

    it("keeps its sentences short", () => {
      expect(beforeFirstStep).not.toBe("")
      expect(findLongSentences("SKILL.md", beforeFirstStep)).toEqual([])
    })
  })

  it("keeps sentences short", () => {
    expect(findLongSentences("SKILL.md", skill)).toEqual([])
    expect(findLongSentences("mcp-steps.md", steps)).toEqual([])
  })
})
