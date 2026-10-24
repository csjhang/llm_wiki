/**
 * cmd-record.test.ts - tests for `wiki-tool hepta record`.
 *
 * The tests run the command through runCli. Ids are placeholders and titles are generic.
 */
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { parseFrontmatter } from "@/lib/frontmatter"
import { contentHash, loadCardMap } from "./card-map"
import { runCli } from "./cli"
import type { CommandResult } from "./io"
import { id, makeProject, pageText, removeProjects } from "./test-project"

afterEach(removeProjects)

const NOW = "2026-10-24T08:15:30.000Z"
const PAGE = "wiki/mechanisms/event-driven.md"
const HASH_A = "a".repeat(64)
const HASH_B = "b".repeat(64)

async function record(project: string, event: unknown): Promise<{ exitCode: number; output: CommandResult }> {
  const text = typeof event === "string" ? event : JSON.stringify(event)
  return runCli(["hepta", "record", "--project", project, "--now", NOW, "--event", text])
}

function mechanism(title = "Event Driven", body = "Body text."): string {
  return pageText({ type: "mechanism", title, sources: ["a.md"] }, body)
}

/** A project whose page is recorded as created. */
async function createdProject(extra: Record<string, string> = {}): Promise<string> {
  const project = makeProject({ [PAGE]: mechanism(), ...extra })
  const result = await record(project, { type: "created", page: PAGE, cardId: id(21), cardUpdatedAt: "2026-10-24T08:15:35.000Z", contentHash: HASH_A })
  expect(result.exitCode).toBe(0)
  return project
}

describe("hepta record", () => {
  describe("created", () => {
    it("adds the page to the map", async () => {
      const project = makeProject({ [PAGE]: mechanism() })
      const result = await record(project, {
        type: "created",
        page: PAGE,
        cardId: id(21),
        cardUpdatedAt: "2026-10-24T08:15:35.000Z",
        contentHash: HASH_A,
      })
      expect(result.exitCode).toBe(0)
      const entry = {
        card_id: id(21),
        content_hash: HASH_A,
        last_synced_at: NOW,
        card_updated_at: "2026-10-24T08:15:35.000Z",
        placements: [],
        status: "active",
      }
      expect(result.output).toEqual({ ok: true, event: "created", page: PAGE, entry })
      expect(loadCardMap(project).pages).toEqual({ [PAGE]: entry })
    })

    it("computes the content hash when the event has none", async () => {
      const project = makeProject({ [PAGE]: mechanism() })
      const planned = await runCli(["hepta", "plan-down", "--project", project, "--now", NOW])
      const [action] = planned.output.actions as { contentHash: string; body: string }[]
      expect(action.contentHash).toBe(contentHash(action.body))

      await record(project, { type: "created", page: PAGE, cardId: id(21), cardUpdatedAt: NOW })
      expect(loadCardMap(project).pages[PAGE].content_hash).toBe(action.contentHash)
      // The page is in sync, so the next plan has nothing to do.
      const next = await runCli(["hepta", "plan-down", "--project", project, "--now", NOW])
      expect(next.output.actions).toEqual([])
    })

    it("reads the clock when --now is not given", async () => {
      const project = makeProject({ [PAGE]: mechanism() })
      const before = Date.now()
      await runCli(["hepta", "record", "--project", project, "--event", JSON.stringify({ type: "created", page: PAGE, cardId: id(21), cardUpdatedAt: NOW, contentHash: HASH_A })])
      const synced = Date.parse(loadCardMap(project).pages[PAGE].last_synced_at)
      expect(synced).toBeGreaterThanOrEqual(before)
      expect(synced).toBeLessThanOrEqual(Date.now())
    })

    it("can be recorded again for the same card without losing placements", async () => {
      const project = await createdProject()
      await record(project, { type: "placed", page: PAGE, whiteboardId: id(31) })
      const again = await record(project, { type: "created", page: PAGE, cardId: id(21), cardUpdatedAt: NOW, contentHash: HASH_B })
      expect(again.exitCode).toBe(0)
      const entry = loadCardMap(project).pages[PAGE]
      expect(entry.content_hash).toBe(HASH_B)
      expect(entry.placements).toEqual([id(31)])
    })

    it("refuses to replace the card of a page", async () => {
      const project = await createdProject()
      const result = await record(project, { type: "created", page: PAGE, cardId: id(22), cardUpdatedAt: NOW, contentHash: HASH_B })
      expect(result.exitCode).toBe(2)
      expect(result.output.problems).toEqual([expect.stringContaining(id(21))])
      expect(loadCardMap(project).pages[PAGE].card_id).toBe(id(21))
    })

    it("rejects fields that are missing or wrong", async () => {
      const project = makeProject({ [PAGE]: mechanism() })
      const bad = async (event: Record<string, unknown>, problem: string): Promise<void> => {
        const result = await record(project, { type: "created", page: PAGE, cardId: id(21), cardUpdatedAt: NOW, contentHash: HASH_A, ...event })
        expect(result.exitCode).toBe(2)
        expect(result.output.problems).toEqual([expect.stringContaining(problem)])
      }
      await bad({ cardId: "not-an-id" }, "cardId")
      await bad({ cardId: undefined }, "cardId")
      await bad({ cardUpdatedAt: undefined }, "cardUpdatedAt")
      await bad({ cardUpdatedAt: "yesterday" }, "cardUpdatedAt")
      await bad({ contentHash: "abc" }, "contentHash")
      await bad({ page: undefined }, "page")
      await bad({ page: "notes/page.md" }, "page")
      await bad({ page: "wiki/../../outside.md" }, "page")
      await bad({ page: "wiki/mechanisms/other.md", contentHash: undefined }, "wiki/mechanisms/other.md")
      expect(existsSync(join(project, "heptabase-map.json"))).toBe(false)
    })
  })

  describe("updated", () => {
    it("sets the hash and the times", async () => {
      const project = await createdProject()
      await record(project, { type: "placed", page: PAGE, whiteboardId: id(31) })
      const result = await record(project, { type: "updated", page: PAGE, cardUpdatedAt: "2026-10-24T08:15:40.000Z", contentHash: HASH_B })
      expect(result.exitCode).toBe(0)
      expect(loadCardMap(project).pages[PAGE]).toEqual({
        card_id: id(21),
        content_hash: HASH_B,
        last_synced_at: NOW,
        card_updated_at: "2026-10-24T08:15:40.000Z",
        placements: [id(31)],
        status: "active",
      })
    })

    it("computes the hash of the page as it is now when the event has none", async () => {
      const project = await createdProject()
      await runCli(["hepta", "record", "--project", project, "--now", NOW, "--event", JSON.stringify({ type: "updated", page: PAGE, cardUpdatedAt: NOW })])
      const next = await runCli(["hepta", "plan-down", "--project", project, "--now", NOW])
      expect(next.output.actions).toEqual([])
    })

    it("makes a retired page active again", async () => {
      const project = await createdProject()
      await record(project, { type: "retired", page: PAGE })
      await record(project, { type: "updated", page: PAGE, cardUpdatedAt: NOW, contentHash: HASH_B })
      expect(loadCardMap(project).pages[PAGE].status).toBe("active")
    })

    it("needs a page that is in the map", async () => {
      const project = makeProject({ [PAGE]: mechanism() })
      const result = await record(project, { type: "updated", page: PAGE, cardUpdatedAt: NOW, contentHash: HASH_B })
      expect(result.exitCode).toBe(2)
      expect(result.output.problems).toEqual([expect.stringContaining("not in the card map")])
    })
  })

  describe("placed", () => {
    it("adds the whiteboard once", async () => {
      const project = await createdProject()
      const first = await record(project, { type: "placed", page: PAGE, whiteboardId: id(31) })
      expect(first.exitCode).toBe(0)
      await record(project, { type: "placed", page: PAGE, whiteboardId: id(31) })
      await record(project, { type: "placed", page: PAGE, whiteboardId: id(32) })
      const entry = loadCardMap(project).pages[PAGE]
      expect(entry.placements).toEqual([id(31), id(32)])
      // Only the placements changed.
      expect(entry).toMatchObject({ content_hash: HASH_A, last_synced_at: NOW, status: "active" })
    })

    it("rejects a whiteboard that is not an id and a page that is not in the map", async () => {
      const project = await createdProject()
      expect((await record(project, { type: "placed", page: PAGE, whiteboardId: "Board" })).output.problems).toEqual([
        expect.stringContaining("whiteboardId"),
      ])
      expect((await record(project, { type: "placed", page: "wiki/other.md", whiteboardId: id(31) })).exitCode).toBe(2)
    })
  })

  describe("retired", () => {
    it("marks the page retired", async () => {
      const project = await createdProject()
      const result = await record(project, { type: "retired", page: PAGE })
      expect(result.exitCode).toBe(0)
      expect(loadCardMap(project).pages[PAGE]).toEqual({
        card_id: id(21),
        content_hash: contentHash("此頁已從 wiki 移除。"),
        last_synced_at: NOW,
        card_updated_at: "2026-10-24T08:15:35.000Z",
        placements: [],
        status: "retired",
      })
    })

    it("takes the card time of the event when there is one", async () => {
      const project = await createdProject()
      await record(project, { type: "retired", page: PAGE, cardUpdatedAt: "2026-10-24T08:20:00.000Z" })
      expect(loadCardMap(project).pages[PAGE].card_updated_at).toBe("2026-10-24T08:20:00.000Z")
    })

    it("stops the next plan from retiring the page again", async () => {
      const project = await createdProject()
      rmSync(join(project, PAGE))
      const planned = await runCli(["hepta", "plan-down", "--project", project, "--now", NOW])
      expect((planned.output.actions as { op: string }[]).map((action) => action.op)).toEqual(["retire"])
      await record(project, { type: "retired", page: PAGE })
      const next = await runCli(["hepta", "plan-down", "--project", project, "--now", NOW])
      expect(next.output.actions).toEqual([])
    })
  })

  describe("feedback", () => {
    it("writes a note snapshot", async () => {
      const project = await createdProject()
      const content = "# Event Driven\n\nA line the user added.\n\nSecond paragraph with: colons and --- dashes.\n"
      const result = await record(project, { type: "feedback", page: PAGE, cardId: id(21), content })
      expect(result.exitCode).toBe(0)
      const relative = `raw/sources/heptabase/feedback-${id(21)}-202610240815.md`
      expect(result.output).toEqual({ ok: true, event: "feedback", page: PAGE, written: relative })

      const parsed = parseFrontmatter(readFileSync(join(project, relative), "utf8"))
      expect(parsed.frontmatter).toEqual({
        title: "Feedback on Event Driven",
        heptabase_card_id: id(21),
        source_kind: "note",
      })
      expect(parsed.body.trim()).toBe(content.trim())
    })

    it("leaves the map as it is", async () => {
      const project = await createdProject()
      const before = readFileSync(join(project, "heptabase-map.json"), "utf8")
      await record(project, { type: "feedback", page: PAGE, cardId: id(21), content: "Edited." })
      expect(readFileSync(join(project, "heptabase-map.json"), "utf8")).toBe(before)
    })

    it("titles the note by the file name when the page is gone", async () => {
      const project = await createdProject()
      rmSync(join(project, PAGE))
      const result = await record(project, { type: "feedback", page: PAGE, cardId: id(21), content: "Edited." })
      const parsed = parseFrontmatter(readFileSync(join(project, result.output.written as string), "utf8"))
      expect(parsed.frontmatter?.title).toBe("Feedback on event-driven")
    })

    it("keeps a title that needs quoting", async () => {
      const project = await createdProject({ [PAGE]: mechanism('Quote: "x" # y') })
      const result = await record(project, { type: "feedback", page: PAGE, cardId: id(21), content: "Edited." })
      const parsed = parseFrontmatter(readFileSync(join(project, result.output.written as string), "utf8"))
      expect(parsed.frontmatter?.title).toBe('Feedback on Quote: "x" # y')
    })

    it("needs the card of the page and a safe card id", async () => {
      const project = await createdProject()
      const wrongCard = await record(project, { type: "feedback", page: PAGE, cardId: id(22), content: "Edited." })
      expect(wrongCard.exitCode).toBe(2)
      expect(wrongCard.output.problems).toEqual([expect.stringContaining(id(21))])

      const traversal = await record(project, { type: "feedback", page: PAGE, cardId: "../../escape", content: "Edited." })
      expect(traversal.exitCode).toBe(2)
      expect(existsSync(join(project, "raw"))).toBe(false)

      const unmapped = await record(project, { type: "feedback", page: "wiki/other.md", cardId: id(21), content: "Edited." })
      expect(unmapped.exitCode).toBe(2)
      const empty = await record(project, { type: "feedback", page: PAGE, cardId: id(21), content: "  \n" })
      expect(empty.exitCode).toBe(2)
      expect(empty.output.problems).toEqual([expect.stringContaining("content")])
    })
  })

  describe("the command line", () => {
    it("saves the map after every event, without leftover files", async () => {
      const project = await createdProject()
      const sizes: number[] = []
      for (const event of [
        { type: "placed", page: PAGE, whiteboardId: id(31) },
        { type: "updated", page: PAGE, cardUpdatedAt: NOW, contentHash: HASH_B },
        { type: "retired", page: PAGE },
      ]) {
        await record(project, event)
        sizes.push(readFileSync(join(project, "heptabase-map.json"), "utf8").length)
      }
      expect(new Set(sizes).size).toBeGreaterThan(1)
      expect(readdirSync(project).filter((name) => name.endsWith(".tmp"))).toEqual([])
      expect(readFileSync(join(project, "heptabase-map.json"), "utf8").endsWith("}\n")).toBe(true)
    })

    it("rejects an event it does not know", async () => {
      const project = makeProject()
      const result = await record(project, { type: "deleted", page: PAGE })
      expect(result.exitCode).toBe(2)
      expect(result.output).toEqual({ ok: false, problems: ['unknown event type: "deleted"'] })
    })

    it("rejects an event that is not JSON or not an object", async () => {
      const project = makeProject()
      expect((await record(project, "{ nope")).output.problems).toEqual([expect.stringContaining("--event is not valid JSON")])
      expect((await record(project, "[1]")).output.problems).toEqual([expect.stringContaining("--event must be a JSON object")])
      expect((await record(project, {})).output.problems).toEqual([expect.stringContaining('"type"')])
    })

    it("requires --project and --event", async () => {
      const result = await runCli(["hepta", "record"])
      expect(result.exitCode).toBe(2)
      expect(result.output).toEqual({ ok: false, problems: ["missing option: --project", "missing option: --event"] })
    })

    it("reports a bad clock, a missing project folder, and a map it cannot read", async () => {
      const project = makeProject()
      const event = { type: "placed", page: PAGE, whiteboardId: id(31) }
      const badClock = await runCli(["hepta", "record", "--project", project, "--now", "later", "--event", JSON.stringify(event)])
      expect(badClock.exitCode).toBe(2)
      expect(badClock.output.problems).toEqual([expect.stringContaining("--now")])
      const missing = await runCli(["hepta", "record", "--project", join(project, "nope"), "--event", JSON.stringify(event)])
      expect(missing.output.problems).toEqual([expect.stringContaining("project folder not found")])
      writeFileSync(join(project, "heptabase-map.json"), "{ not json")
      const broken = await record(project, event)
      expect(broken.exitCode).toBe(2)
      expect(broken.output.problems).toEqual([expect.stringContaining("heptabase-map.json")])
    })
  })
})
