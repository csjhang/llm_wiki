/**
 * cmd-record.test.ts - tests for `wiki-tool hepta record`.
 *
 * The tests run the command through runCli. Ids are placeholders and titles are generic.
 */
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { parseFrontmatter } from "@/lib/frontmatter"
import { contentHash, loadCardMap, saveCardMap } from "./card-map"
import { runCli } from "./cli"
import type { CommandResult } from "./io"
import { cardFile, id, makeProject, pageText, quietMirrorArgs, removeProjects, writeProjectFile } from "./test-project"

afterEach(removeProjects)

const NOW = "2026-10-24T08:15:30.000Z"
const PAGE = "wiki/mechanisms/event-driven.md"
const HASH_A = "a".repeat(64)
const HASH_B = "b".repeat(64)
const EDITED = "2026-10-24T09:00:00.000Z"

async function record(project: string, event: unknown, contentFiles: string[] = []): Promise<{ exitCode: number; output: CommandResult }> {
  const text = typeof event === "string" ? event : JSON.stringify(event)
  const content = contentFiles.flatMap((file) => ["--content", file])
  return runCli(["hepta", "record", "--project", project, "--now", NOW, "--event", text, ...content])
}

const outboxPath = (page: string): string => `.llm-wiki/hepta/outbox/${contentHash(page)}.md`
const sentPath = (cardId: string): string => `.llm-wiki/hepta/sent/${cardId}.md`

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
      const planned = await runCli(["hepta", "plan-down", "--project", project, "--now", NOW, ...quietMirrorArgs(project)])
      const [action] = planned.output.actions as { contentHash: string; body: string }[]
      expect(action.contentHash).toMatch(/^[0-9a-f]{64}$/)

      await record(project, { type: "created", page: PAGE, cardId: id(21), cardUpdatedAt: NOW })
      expect(loadCardMap(project).pages[PAGE].content_hash).toBe(action.contentHash)
      // The page is in sync, so the next plan has nothing to do.
      const next = await runCli(["hepta", "plan-down", "--project", project, "--now", NOW, ...quietMirrorArgs(project)])
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

    it("refuses a card that another page or a source already holds", async () => {
      const project = await createdProject({ "wiki/mechanisms/other.md": mechanism("Other") })
      const other = await record(project, { type: "created", page: "wiki/mechanisms/other.md", cardId: id(21), cardUpdatedAt: NOW, contentHash: HASH_B })
      expect(other.exitCode).toBe(2)
      expect(other.output.problems).toEqual([expect.stringContaining(PAGE)])

      const map = loadCardMap(project)
      map.sources[id(70)] = { raw_path: `raw/sources/heptabase/${id(70)}.md`, card_updated_at: NOW, ingest_commit: null }
      saveCardMap(project, map)
      const source = await record(project, { type: "created", page: "wiki/mechanisms/other.md", cardId: id(70), cardUpdatedAt: NOW, contentHash: HASH_B })
      expect(source.exitCode).toBe(2)
      expect(source.output.problems).toEqual([expect.stringContaining("source")])
      expect(Object.keys(loadCardMap(project).pages)).toEqual([PAGE])
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

  describe("created with setup false", () => {
    it("keeps the card as waiting for setup", async () => {
      const project = makeProject({ [PAGE]: mechanism() })
      const result = await record(project, {
        type: "created",
        page: PAGE,
        cardId: id(21),
        setup: false,
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
        setup_pending: true,
      }
      expect(result.output).toEqual({ ok: true, event: "created", page: PAGE, entry })
      expect(loadCardMap(project).pages).toEqual({ [PAGE]: entry })
    })

    it("takes the time of the command as the card time when the event has none", async () => {
      const project = makeProject({ [PAGE]: mechanism() })
      const result = await record(project, { type: "created", page: PAGE, cardId: id(21), setup: false, contentHash: HASH_A })
      expect(result.exitCode).toBe(0)
      expect(loadCardMap(project).pages[PAGE]).toMatchObject({ card_updated_at: NOW, setup_pending: true })
    })

    it("still refuses a card time that is not a time", async () => {
      const project = makeProject({ [PAGE]: mechanism() })
      const result = await record(project, { type: "created", page: PAGE, cardId: id(21), setup: false, cardUpdatedAt: "yesterday", contentHash: HASH_A })
      expect(result.exitCode).toBe(2)
      expect(result.output.problems).toEqual([expect.stringContaining("cardUpdatedAt")])
    })

    it("needs the card time when the setup is not pending", async () => {
      const project = makeProject({ [PAGE]: mechanism() })
      for (const setup of [undefined, true]) {
        const result = await record(project, { type: "created", page: PAGE, cardId: id(21), setup, contentHash: HASH_A })
        expect(result.exitCode).toBe(2)
        expect(result.output.problems).toEqual([expect.stringContaining("cardUpdatedAt")])
      }
    })

    it("refuses a setup flag that is not true or false", async () => {
      const project = makeProject({ [PAGE]: mechanism() })
      const result = await record(project, { type: "created", page: PAGE, cardId: id(21), setup: "no", cardUpdatedAt: NOW, contentHash: HASH_A })
      expect(result.exitCode).toBe(2)
      expect(result.output.problems).toEqual([expect.stringContaining("setup")])
    })

    it("keeps the feedback marker and the placements when the same card is recorded again", async () => {
      const project = await createdProject()
      await record(project, { type: "placed", page: PAGE, whiteboardId: id(31) })
      const map = loadCardMap(project)
      map.pages[PAGE].feedback_card_updated_at = EDITED
      saveCardMap(project, map)
      const again = await record(project, { type: "created", page: PAGE, cardId: id(21), setup: false, contentHash: HASH_B })
      expect(again.exitCode).toBe(0)
      expect(loadCardMap(project).pages[PAGE]).toMatchObject({
        content_hash: HASH_B,
        placements: [id(31)],
        feedback_card_updated_at: EDITED,
        setup_pending: true,
      })
    })

    it("clears the waiting state when the same card is recorded again as complete", async () => {
      const project = makeProject({ [PAGE]: mechanism() })
      await record(project, { type: "created", page: PAGE, cardId: id(21), setup: false, contentHash: HASH_A })
      await record(project, { type: "created", page: PAGE, cardId: id(21), cardUpdatedAt: NOW, contentHash: HASH_A })
      expect(loadCardMap(project).pages[PAGE].setup_pending).toBeUndefined()
    })

    it("refuses another card for a page that waits for setup", async () => {
      const project = makeProject({ [PAGE]: mechanism() })
      await record(project, { type: "created", page: PAGE, cardId: id(21), setup: false, contentHash: HASH_A })
      const result = await record(project, { type: "created", page: PAGE, cardId: id(22), setup: false, contentHash: HASH_A })
      expect(result.exitCode).toBe(2)
      expect(result.output.problems).toEqual([expect.stringContaining(id(21))])
    })
  })

  describe("setup-done", () => {
    async function waitingProject(): Promise<string> {
      const project = makeProject({ [PAGE]: mechanism() })
      await record(project, { type: "created", page: PAGE, cardId: id(21), setup: false, contentHash: HASH_A })
      return project
    }

    it("clears the waiting state and sets the times", async () => {
      const project = await waitingProject()
      const later = "2026-10-24T08:20:00.000Z"
      const result = await runCli([
        ...["hepta", "record", "--project", project, "--now", "2026-10-24T08:16:00.000Z"],
        ...["--event", JSON.stringify({ type: "setup-done", page: PAGE, cardUpdatedAt: later })],
      ])
      expect(result.exitCode).toBe(0)
      const entry = {
        card_id: id(21),
        content_hash: HASH_A,
        last_synced_at: "2026-10-24T08:16:00.000Z",
        card_updated_at: later,
        placements: [],
        status: "active",
      }
      expect(result.output).toEqual({ ok: true, event: "setup-done", page: PAGE, entry })
      expect(loadCardMap(project).pages[PAGE]).toEqual(entry)
    })

    it("needs the card time", async () => {
      const project = await waitingProject()
      for (const cardUpdatedAt of [undefined, "yesterday"]) {
        const result = await record(project, { type: "setup-done", page: PAGE, cardUpdatedAt })
        expect(result.exitCode).toBe(2)
        expect(result.output.problems).toEqual([expect.stringContaining("cardUpdatedAt")])
      }
      expect(loadCardMap(project).pages[PAGE].setup_pending).toBe(true)
    })

    it("needs a page that waits for setup", async () => {
      const project = await createdProject()
      const complete = await record(project, { type: "setup-done", page: PAGE, cardUpdatedAt: NOW })
      expect(complete.exitCode).toBe(2)
      expect(complete.output.problems).toEqual([expect.stringContaining("not waiting for setup")])
      const unmapped = await record(project, { type: "setup-done", page: "wiki/other.md", cardUpdatedAt: NOW })
      expect(unmapped.exitCode).toBe(2)
      expect(unmapped.output.problems).toEqual([expect.stringContaining("not in the card map")])
    })
  })

  describe("a page that waits for setup", () => {
    it("takes no updated, relinked, or retired event until setup is done", async () => {
      const project = makeProject({ [PAGE]: mechanism() })
      await record(project, { type: "created", page: PAGE, cardId: id(21), setup: false, contentHash: HASH_A })
      for (const type of ["updated", "relinked", "retired"]) {
        const result = await record(project, { type, page: PAGE, cardUpdatedAt: NOW, contentHash: HASH_B })
        expect(result.exitCode, type).toBe(2)
        expect(result.output.problems, type).toEqual([expect.stringContaining("waiting for setup")])
      }
      expect(loadCardMap(project).pages[PAGE]).toMatchObject({ content_hash: HASH_A, status: "active", setup_pending: true })
    })
  })

  describe("relinked", () => {
    it("is recorded like updated, under its own name", async () => {
      const project = await createdProject()
      const result = await record(project, { type: "relinked", page: PAGE, cardUpdatedAt: "2026-10-24T08:15:40.000Z", contentHash: HASH_B })
      expect(result.exitCode).toBe(0)
      expect(result.output).toMatchObject({ ok: true, event: "relinked", page: PAGE })
      expect(loadCardMap(project).pages[PAGE]).toMatchObject({ content_hash: HASH_B, card_updated_at: "2026-10-24T08:15:40.000Z" })
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
      const next = await runCli(["hepta", "plan-down", "--project", project, "--now", NOW, ...quietMirrorArgs(project)])
      expect(next.output.actions).toEqual([])
    })

    it("makes a retired page active again", async () => {
      const project = await createdProject()
      await record(project, { type: "retired", page: PAGE, cardUpdatedAt: NOW })
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
      const result = await record(project, { type: "retired", page: PAGE, cardUpdatedAt: "2026-10-24T08:20:00.000Z" })
      expect(result.exitCode).toBe(0)
      expect(loadCardMap(project).pages[PAGE]).toEqual({
        card_id: id(21),
        content_hash: contentHash("此頁已從 wiki 移除。"),
        last_synced_at: NOW,
        card_updated_at: "2026-10-24T08:20:00.000Z",
        placements: [],
        status: "retired",
      })
    })

    it("needs the card time, like every event that writes to a card", async () => {
      const project = await createdProject()
      for (const cardUpdatedAt of [undefined, "yesterday"]) {
        const result = await record(project, { type: "retired", page: PAGE, cardUpdatedAt })
        expect(result.exitCode).toBe(2)
        expect(result.output.problems).toEqual([expect.stringContaining("cardUpdatedAt")])
      }
      expect(loadCardMap(project).pages[PAGE].status).toBe("active")
    })

    it("stops the next plan from retiring the page again", async () => {
      const project = await createdProject()
      rmSync(join(project, PAGE))
      const planned = await runCli(["hepta", "plan-down", "--project", project, "--now", NOW, ...quietMirrorArgs(project)])
      expect((planned.output.actions as { op: string }[]).map((action) => action.op)).toEqual(["retire"])
      await record(project, { type: "retired", page: PAGE, cardUpdatedAt: NOW })
      const next = await runCli(["hepta", "plan-down", "--project", project, "--now", NOW, ...quietMirrorArgs(project)])
      expect(next.output.actions).toEqual([])
    })
  })

  // Final review, I2(b): nothing dropped a retired entry once the user had deleted its card by hand.
  describe("forgotten", () => {
    /** A project whose page is created, retired, and then gone. */
    async function retiredProject(): Promise<string> {
      const project = await createdProject()
      await record(project, { type: "retired", page: PAGE, cardUpdatedAt: "2026-10-24T08:20:00.000Z" })
      return project
    }

    it("removes a retired entry from the map and leaves the rest of the map alone", async () => {
      const project = await retiredProject()
      const other = "wiki/mechanisms/other.md"
      writeProjectFile(project, other, mechanism("Other"))
      await record(project, { type: "created", page: other, cardId: id(22), cardUpdatedAt: NOW, contentHash: HASH_B })
      await record(project, { type: "up-decision", cardId: id(23), decision: "skip" })
      const before = loadCardMap(project)

      const result = await record(project, { type: "forgotten", page: PAGE })

      expect(result.exitCode).toBe(0)
      expect(result.output).toMatchObject({ ok: true, event: "forgotten", page: PAGE })
      const after = loadCardMap(project)
      expect(Object.keys(after.pages)).toEqual([other])
      expect(after.pages[other]).toEqual(before.pages[other])
      expect(after.sources).toEqual(before.sources)
      expect(after.up_decisions).toEqual(before.up_decisions)
    })

    it("takes the page in other forms of the path, like every event", async () => {
      const project = await retiredProject()
      const result = await record(project, { type: "forgotten", page: `./${PAGE}` })
      expect(result.exitCode).toBe(0)
      expect(loadCardMap(project).pages[PAGE]).toBeUndefined()
    })

    it("refuses an active entry: the card of an active page is not gone", async () => {
      const project = await createdProject()
      const result = await record(project, { type: "forgotten", page: PAGE })
      expect(result.exitCode).toBe(2)
      expect(result.output.problems).toEqual([`${PAGE} is not retired, so its card cannot be forgotten`])
      expect(loadCardMap(project).pages[PAGE].status).toBe("active")
    })

    it("refuses a page that is not in the map, and a page that is not a path under wiki/", async () => {
      const project = await retiredProject()
      const missing = await record(project, { type: "forgotten", page: "wiki/mechanisms/none.md" })
      expect(missing.exitCode).toBe(2)
      expect(missing.output.problems).toEqual(["wiki/mechanisms/none.md is not in the card map"])
      for (const page of [undefined, "", "heptabase-map.json", "wiki/readme.txt"]) {
        const bad = await record(project, { type: "forgotten", page })
        expect(bad.exitCode, String(page)).toBe(2)
        expect(bad.output.problems, String(page)).toEqual([expect.stringContaining('event "page"')])
      }
      expect(loadCardMap(project).pages[PAGE].status).toBe("retired")
    })

    it("refuses a card that waits for setup", async () => {
      const project = makeProject({ [PAGE]: mechanism() })
      await record(project, { type: "created", page: PAGE, cardId: id(21), setup: false, contentHash: HASH_A })
      const map = loadCardMap(project)
      map.pages[PAGE].status = "retired"
      saveCardMap(project, map)
      const result = await record(project, { type: "forgotten", page: PAGE })
      expect(result.exitCode).toBe(2)
      expect(result.output.problems).toEqual([`${PAGE} is waiting for setup; record setup-done first`])
    })

    it("lets the page get a new card at the next plan when the page is back and mirrored", async () => {
      const project = await retiredProject()
      await record(project, { type: "forgotten", page: PAGE })
      const planned = await runCli(["hepta", "plan-down", "--project", project, "--now", NOW, ...quietMirrorArgs(project)])
      expect((planned.output.actions as { op: string; page: string }[]).map((action) => [action.op, action.page])).toEqual([["create", PAGE]])
    })

    it("needs no heptabase.yaml", async () => {
      const project = makeProject({}, { noHeptabaseYaml: true })
      const map = loadCardMap(project)
      map.pages[PAGE] = { card_id: id(21), content_hash: HASH_A, last_synced_at: NOW, card_updated_at: NOW, placements: [], status: "retired" }
      saveCardMap(project, map)
      expect((await record(project, { type: "forgotten", page: PAGE })).exitCode).toBe(0)
    })
  })

  describe("the sent text", () => {
    const read = (project: string, path: string): string => readFileSync(join(project, path), "utf8")

    /** Runs plan-down and returns the action of the page: its body file is in the outbox now. */
    async function plannedAction(project: string): Promise<{ op: string; bodyFile: string; contentHash: string; body: string }> {
      const planned = await runCli(["hepta", "plan-down", "--project", project, "--now", NOW, ...quietMirrorArgs(project)])
      return (planned.output.actions as { op: string; page: string; bodyFile: string; contentHash: string; body: string }[]).find(
        (action) => action.page === PAGE,
      ) as { op: string; bodyFile: string; contentHash: string; body: string }
    }

    it("is the outbox file of the page, copied when the card is created", async () => {
      const project = makeProject({ [PAGE]: mechanism() })
      const action = await plannedAction(project)
      expect(action.bodyFile).toBe(outboxPath(PAGE))
      const result = await record(project, { type: "created", page: PAGE, cardId: id(21), cardUpdatedAt: NOW, contentHash: action.contentHash })
      expect(result.exitCode).toBe(0)
      expect(result.output.sent).toBe(sentPath(id(21)))
      expect(read(project, sentPath(id(21)))).toBe(action.body)
    })

    it("is copied when the card waits for setup", async () => {
      const project = makeProject({ [PAGE]: mechanism() })
      const action = await plannedAction(project)
      await record(project, { type: "created", page: PAGE, cardId: id(21), setup: false, contentHash: action.contentHash })
      expect(read(project, sentPath(id(21)))).toBe(action.body)
    })

    it("is replaced by an updated, a relinked, and a retired event", async () => {
      const project = makeProject({ [PAGE]: mechanism() })
      const created = await plannedAction(project)
      await record(project, { type: "created", page: PAGE, cardId: id(21), cardUpdatedAt: NOW, contentHash: created.contentHash })

      writeProjectFile(project, PAGE, mechanism("Event Driven", "Second text."))
      const update = await plannedAction(project)
      expect(update.op).toBe("update")
      const updated = await record(project, { type: "updated", page: PAGE, cardUpdatedAt: NOW, contentHash: update.contentHash })
      expect(updated.output.sent).toBe(sentPath(id(21)))
      expect(read(project, sentPath(id(21)))).toContain("Second text.")

      writeProjectFile(project, PAGE, mechanism("Event Driven", "Third text."))
      const third = await plannedAction(project)
      await record(project, { type: "relinked", page: PAGE, cardUpdatedAt: NOW, contentHash: third.contentHash })
      expect(read(project, sentPath(id(21)))).toContain("Third text.")

      rmSync(join(project, PAGE))
      const retire = await plannedAction(project)
      expect(retire.op).toBe("retire")
      await record(project, { type: "retired", page: PAGE, cardUpdatedAt: NOW })
      expect(read(project, sentPath(id(21)))).toBe("# 🗄 已停用｜Card\n\n此頁已從 wiki 移除。")
    })

    it("can come from a body file that the event names", async () => {
      const project = makeProject({ [PAGE]: mechanism() })
      writeProjectFile(project, ".llm-wiki/hepta/other-body.md", "# Named\n\nText.")
      const result = await record(project, {
        type: "created",
        page: PAGE,
        cardId: id(21),
        cardUpdatedAt: NOW,
        contentHash: HASH_A,
        bodyFile: ".llm-wiki/hepta/other-body.md",
      })
      expect(result.exitCode).toBe(0)
      expect(read(project, sentPath(id(21)))).toBe("# Named\n\nText.")
    })

    it("is not written, and is no error, when the page has no body file", async () => {
      const project = makeProject({ [PAGE]: mechanism() })
      const result = await record(project, { type: "created", page: PAGE, cardId: id(21), cardUpdatedAt: NOW, contentHash: HASH_A })
      expect(result.exitCode).toBe(0)
      expect("sent" in result.output).toBe(false)
      expect(existsSync(join(project, ".llm-wiki/hepta/sent"))).toBe(false)
    })

    it("refuses a body file that is missing or outside the project, and then changes nothing", async () => {
      const project = makeProject({ [PAGE]: mechanism() })
      writeProjectFile(project, ".llm-wiki/hepta/outbox/page.md", "# Page")
      for (const bodyFile of [".llm-wiki/hepta/missing.md", "../outside.md", 7]) {
        const result = await record(project, { type: "created", page: PAGE, cardId: id(21), cardUpdatedAt: NOW, contentHash: HASH_A, bodyFile })
        expect(result.exitCode, String(bodyFile)).toBe(2)
        expect(result.output.problems, String(bodyFile)).toEqual([expect.stringContaining("bodyFile")])
      }
      expect(existsSync(join(project, "heptabase-map.json"))).toBe(false)
      expect(existsSync(join(project, ".llm-wiki/hepta/sent"))).toBe(false)
    })

    it("is not written for an event that is refused", async () => {
      const project = makeProject({ [PAGE]: mechanism() })
      const action = await plannedAction(project)
      const result = await record(project, { type: "created", page: PAGE, cardId: "not-an-id", cardUpdatedAt: NOW, contentHash: action.contentHash })
      expect(result.exitCode).toBe(2)
      expect(existsSync(join(project, ".llm-wiki/hepta/sent"))).toBe(false)
    })
  })

  describe("feedback", () => {
    const SENT = "# Event Driven\n\nFirst line.\n\nSecond line.\n\n---\n來源：無\n由 wiki 產生，請勿直接編輯。"
    const NOTE = `raw/sources/heptabase/feedback-${id(21)}-202610240815.md`

    /** A project whose page is recorded as created, with the text that was sent. */
    async function sentProject(sent: string | null = SENT): Promise<string> {
      const project = await createdProject()
      if (sent !== null) writeProjectFile(project, sentPath(id(21)), sent)
      return project
    }

    const feedback = (project: string, text: string, event: Record<string, unknown> = {}) =>
      record(project, { type: "feedback", page: PAGE, cardId: id(21), cardUpdatedAt: EDITED, ...event }, [cardFile(project, "card.json", text)])

    it("writes a note with the lines the user added and removed", async () => {
      const project = await sentProject()
      const result = await feedback(project, SENT.replace("Second line.", "A line the user wrote."))
      expect(result.exitCode).toBe(0)
      expect(result.output).toEqual({ ok: true, event: "feedback", page: PAGE, note: NOTE })

      const parsed = parseFrontmatter(readFileSync(join(project, NOTE), "utf8"))
      expect(parsed.frontmatter).toEqual({
        source_kind: "note",
        title: "Feedback on Event Driven",
        heptabase_card_id: id(21),
        wiki_page: PAGE,
      })
      expect(parsed.body).toBe(
        `User edits in Heptabase to the mirror card of ${PAGE}.\n\n## Added\n\nA line the user wrote.\n\n## Removed\n\nSecond line.\n`,
      )
    })

    it("has an Added section only when lines were added, and a Removed section only when lines were removed", async () => {
      const project = await sentProject()
      const added = await feedback(project, `${SENT}\n\nA new paragraph.`)
      const addedBody = parseFrontmatter(readFileSync(join(project, added.output.note as string), "utf8")).body
      expect(addedBody).toContain("## Added\n\nA new paragraph.\n")
      expect(addedBody).not.toContain("## Removed")

      const removed = await feedback(project, SENT.replace("\n\nSecond line.", ""))
      const removedBody = parseFrontmatter(readFileSync(join(project, removed.output.note as string), "utf8")).body
      expect(removedBody).toContain("## Removed\n\nSecond line.\n")
      expect(removedBody).not.toContain("## Added")
    })

    it("counts a repeated line", async () => {
      const project = await sentProject()
      const result = await feedback(project, `${SENT}\n\nFirst line.`)
      expect(parseFrontmatter(readFileSync(join(project, result.output.note as string), "utf8")).body).toContain("## Added\n\nFirst line.\n")
    })

    it("writes no note when the card is the sent text, but records the edit as handled", async () => {
      const project = await sentProject()
      const before = loadCardMap(project).pages[PAGE]
      const result = await feedback(project, SENT)
      expect(result.exitCode).toBe(0)
      expect(result.output).toEqual({ ok: true, event: "feedback", page: PAGE, note: null, reason: "same as sent" })
      expect(existsSync(join(project, "raw"))).toBe(false)
      expect(loadCardMap(project).pages[PAGE]).toEqual({ ...before, feedback_card_updated_at: EDITED })
    })

    it("ignores white space and the form of card links when it compares", async () => {
      const sent = `# Event Driven\n\nSee [Other](heptabase://card/${id(22)}) and more.\n\n- Item`
      const project = await sentProject(sent)
      const card = `# Event Driven\n\n\nSee [Other](https://app.heptabase.com/${id(40)}/card/${id(22)})  and   more.  \n\n-   Item\n`
      expect((await feedback(project, card)).output.note).toBeNull()
    })

    /** The text as the wiki sent it, and as Heptabase gives it back: `[` escaped, blank lines added, links with the space id. */
    const SENT_LINKED = [
      "# [Label] Heading",
      "",
      `See [\\[Label\\] x](heptabase://card/${id(22)}) and [Other](heptabase://card/${id(23)}).`,
      "",
      "- a",
      "- b",
      "",
      "---",
      `來源：[Source](heptabase://card/${id(24)})`,
      "由 wiki 產生，請勿直接編輯。",
    ].join("\n")
    const READ_BACK = [
      "# \\[Label] Heading",
      "",
      `See [\\[Label\\] x](https://app.heptabase.com/${id(40)}/card/${id(22)}) and [Other](https://app.heptabase.com/${id(40)}/card/${id(23)}).`,
      "",
      "- a",
      "",
      "- b",
      "",
      "---",
      "",
      `來源：[Source](https://app.heptabase.com/${id(40)}/card/${id(24)})`,
      "由 wiki 產生，請勿直接編輯。",
    ].join("\n")
    const noteBody = (project: string, note: unknown): string => parseFrontmatter(readFileSync(join(project, note as string), "utf8")).body

    it("takes the card as Heptabase gives it back for the text that was sent", async () => {
      const project = await sentProject(SENT_LINKED)
      const result = await feedback(project, READ_BACK)
      expect(result.output).toEqual({ ok: true, event: "feedback", page: PAGE, note: null, reason: "same as sent" })
      expect(existsSync(join(project, "raw"))).toBe(false)
    })

    it("shows a line the user added to a card that Heptabase changed, and nothing else", async () => {
      const project = await sentProject(SENT_LINKED)
      const added = READ_BACK.replace("- b\n", "- b\n\n- [Idea] the user wrote this\n")
      const result = await feedback(project, added)
      expect(result.output.note).toBe(NOTE)
      expect(noteBody(project, result.output.note)).toBe(
        `User edits in Heptabase to the mirror card of ${PAGE}.\n\n## Added\n\n- [Idea] the user wrote this\n`,
      )
    })

    it("shows a changed line as it is written, without the escapes of Heptabase", async () => {
      const project = await sentProject(SENT_LINKED)
      const result = await feedback(project, READ_BACK.replace("# \\[Label] Heading", "# \\[Label] Other heading"))
      expect(noteBody(project, result.output.note)).toBe(
        `User edits in Heptabase to the mirror card of ${PAGE}.\n\n## Added\n\n# [Label] Other heading\n\n## Removed\n\n# [Label] Heading\n`,
      )
    })

    it("sees a link that points to another card, and a word that the user linked", async () => {
      const project = await sentProject(SENT_LINKED)
      const other = READ_BACK.replace(`/card/${id(23)}`, `/card/${id(25)}`)
      const body = noteBody(project, (await feedback(project, other)).output.note)
      expect(body).toContain(`## Added\n\nSee [[Label] x](heptabase://card/${id(22)}) and [Other](heptabase://card/${id(25)}).\n`)
      expect(body).toContain(`## Removed\n\nSee [[Label] x](heptabase://card/${id(22)}) and [Other](heptabase://card/${id(23)}).\n`)

      const linked = READ_BACK.replace("- a\n", `- [a](https://app.heptabase.com/${id(40)}/card/${id(26)})\n`)
      expect(noteBody(project, (await feedback(project, linked)).output.note)).toContain(`## Added\n\n- [a](heptabase://card/${id(26)})\n`)
    })

    it("marks an image that the user added", async () => {
      const project = await sentProject(SENT_LINKED)
      const image = `<image fileId="${id(50)}" sourceObjectId="${id(51)}" sourceObjectType="card" />`
      const result = await feedback(project, READ_BACK.replace("- a\n", `${image}\n\n- a\n`))
      expect(noteBody(project, result.output.note)).toContain("## Added\n\n<!-- heptabase: image -->\n")
      expect(noteBody(project, result.output.note)).not.toContain("## Removed")
    })

    it("uses the whole card text when there is no sent text, or no difference of lines to show", async () => {
      const none = await sentProject(null)
      const whole = await feedback(none, "# Event Driven\n\nText of the user.")
      const wholeBody = parseFrontmatter(readFileSync(join(none, whole.output.note as string), "utf8")).body
      expect(wholeBody).toBe(`User edits in Heptabase to the mirror card of ${PAGE}.\n\n## Card text\n\n# Event Driven\n\nText of the user.\n`)

      // The same lines in another order: the text differs, but no line was added or removed.
      const reordered = await sentProject("Alpha line.\n\nBeta line.")
      const order = await feedback(reordered, "Beta line.\n\nAlpha line.")
      const orderBody = parseFrontmatter(readFileSync(join(reordered, order.output.note as string), "utf8")).body
      expect(orderBody).toContain("## Card text\n\nBeta line.\n\nAlpha line.\n")
      expect(orderBody).not.toContain("## Added")
    })

    it("joins the pages of a result that has several pages", async () => {
      const project = await sentProject()
      const full = SENT.replace("Second line.", "Changed.").split("\n")
      const content = (from: number, to: number): string =>
        JSON.stringify({
          content: [`card "Event Driven" [${id(21)}] ${full.length} lines`, ...full.slice(from, to).map((line, index) => `${from + index + 1}\t${line}`)].join("\n"),
          status: "succeeded",
        })
      writeProjectFile(project, ".llm-wiki/hepta/p1.json", content(0, 4))
      writeProjectFile(project, ".llm-wiki/hepta/p2.json", content(4, full.length))
      const result = await record(
        project,
        { type: "feedback", page: PAGE, cardId: id(21), cardUpdatedAt: EDITED },
        [join(project, ".llm-wiki/hepta/p1.json"), join(project, ".llm-wiki/hepta/p2.json")],
      )
      expect(result.exitCode).toBe(0)
      expect(parseFrontmatter(readFileSync(join(project, result.output.note as string), "utf8")).body).toContain("## Added\n\nChanged.\n")
    })

    it("writes no note for an empty card without a sent text", async () => {
      const project = await sentProject(null)
      const result = await feedback(project, "")
      expect(result.output).toEqual({ ok: true, event: "feedback", page: PAGE, note: null, reason: "card is empty" })
    })

    it("records the time of the edit it handled and nothing else", async () => {
      const project = await sentProject()
      const before = loadCardMap(project).pages[PAGE]
      await feedback(project, `${SENT}\n\nMore.`)
      expect(loadCardMap(project).pages[PAGE]).toEqual({ ...before, feedback_card_updated_at: EDITED })
    })

    it("needs the time of the edit", async () => {
      const project = await sentProject()
      for (const cardUpdatedAt of [undefined, "yesterday"]) {
        const result = await feedback(project, `${SENT}\n\nMore.`, { cardUpdatedAt })
        expect(result.exitCode).toBe(2)
        expect(result.output.problems).toEqual([expect.stringContaining("cardUpdatedAt")])
      }
      expect(existsSync(join(project, "raw"))).toBe(false)
    })

    it("needs --content, and takes it for no other event", async () => {
      const project = await sentProject()
      const missing = await record(project, { type: "feedback", page: PAGE, cardId: id(21), cardUpdatedAt: EDITED, content: "Text in the event." })
      expect(missing.exitCode).toBe(2)
      expect(missing.output.problems).toEqual(["missing option: --content"])

      const other = await record(project, { type: "placed", page: PAGE, whiteboardId: id(31) }, [cardFile(project, "card.json", "Text.")])
      expect(other.exitCode).toBe(2)
      expect(other.output.problems).toEqual(["--content is only for the feedback event"])
    })

    it("refuses a result that failed, a result of another card, and a file it cannot read", async () => {
      const project = await sentProject()
      const failed = join(project, "failed.json")
      writeProjectFile(project, "failed.json", JSON.stringify({ content: "Card not found.", status: "failed" }))
      const event = { type: "feedback", page: PAGE, cardId: id(21), cardUpdatedAt: EDITED }
      expect((await record(project, event, [failed])).output.problems).toEqual([expect.stringContaining(failed)])

      const other = cardFile(project, "other.json", "Text.", id(22))
      expect((await record(project, event, [other])).output.problems).toEqual([expect.stringContaining(id(22))])

      const missing = join(project, "missing.json")
      expect((await record(project, event, [missing])).output.problems).toEqual([expect.stringContaining(missing)])
      expect(existsSync(join(project, "raw"))).toBe(false)
      expect(loadCardMap(project).pages[PAGE].feedback_card_updated_at).toBeUndefined()
    })

    it("does not overwrite a note of the same minute", async () => {
      const project = await sentProject()
      const written: string[] = []
      for (const line of ["First.", "Second.", "Third."]) {
        const result = await feedback(project, `${SENT}\n\n${line}`)
        written.push(result.output.note as string)
      }
      const stem = `raw/sources/heptabase/feedback-${id(21)}-202610240815`
      expect(written).toEqual([`${stem}.md`, `${stem}-2.md`, `${stem}-3.md`])
      expect(written.map((path) => parseFrontmatter(readFileSync(join(project, path), "utf8")).body)).toEqual([
        expect.stringContaining("## Added\n\nFirst.\n"),
        expect.stringContaining("## Added\n\nSecond.\n"),
        expect.stringContaining("## Added\n\nThird.\n"),
      ])
    })

    it("titles the note by the file name when the page is gone", async () => {
      const project = await sentProject()
      rmSync(join(project, PAGE))
      const result = await feedback(project, `${SENT}\n\nMore.`)
      const parsed = parseFrontmatter(readFileSync(join(project, result.output.note as string), "utf8"))
      expect(parsed.frontmatter?.title).toBe("Feedback on event-driven")
    })

    it("keeps a title that needs quoting", async () => {
      const project = await createdProject({ [PAGE]: mechanism('Quote: "x" # y') })
      const result = await feedback(project, "Text.")
      const parsed = parseFrontmatter(readFileSync(join(project, result.output.note as string), "utf8"))
      expect(parsed.frontmatter?.title).toBe('Feedback on Quote: "x" # y')
    })

    it("needs the card of the page and a safe card id", async () => {
      const project = await sentProject()
      const event = { type: "feedback", page: PAGE, cardId: id(22), cardUpdatedAt: EDITED }
      const wrongCard = await record(project, event, [cardFile(project, "other.json", "Edited.", id(22))])
      expect(wrongCard.exitCode).toBe(2)
      expect(wrongCard.output.problems).toEqual([expect.stringContaining(id(21))])

      const traversal = await record(project, { ...event, cardId: "../../escape" }, [cardFile(project, "card.json", "Edited.")])
      expect(traversal.exitCode).toBe(2)
      expect(existsSync(join(project, "raw"))).toBe(false)

      const unmapped = await feedback(project, "Edited.", { page: "wiki/other.md" })
      expect(unmapped.exitCode).toBe(2)
    })

    it("works after a real create: the text the wiki wrote is not the user's change", async () => {
      const project = makeProject({ [PAGE]: mechanism() })
      const planned = await runCli(["hepta", "plan-down", "--project", project, "--now", NOW])
      const [action] = planned.output.actions as { body: string; contentHash: string }[]
      await record(project, { type: "created", page: PAGE, cardId: id(21), cardUpdatedAt: NOW, contentHash: action.contentHash })
      // Heptabase gives the card back as it was sent.
      const same = await feedback(project, action.body)
      expect(same.output.note).toBeNull()
      const edited = await feedback(project, action.body.replace("Body text.", "Body text, and more."))
      expect(parseFrontmatter(readFileSync(join(project, edited.output.note as string), "utf8")).body).toContain("## Added\n\nBody text, and more.\n")
    })
  })

  describe("up-decision", () => {
    const decide = (project: string, event: Record<string, unknown>) => record(project, { type: "up-decision", cardId: id(9), decision: "skip", ...event })

    it("saves a skip and this-wiki", async () => {
      const project = makeProject()
      const skip = await decide(project, {})
      expect(skip.exitCode).toBe(0)
      expect(skip.output).toEqual({ ok: true, event: "up-decision", cardId: id(9), decision: "skip" })
      await decide(project, { cardId: id(10), decision: "this-wiki" })
      expect(loadCardMap(project).up_decisions).toEqual({ [id(9)]: "skip", [id(10)]: "this-wiki" })
    })

    it("replaces an earlier answer and leaves the rest of the map alone", async () => {
      const project = await createdProject()
      const before = loadCardMap(project)
      await decide(project, {})
      await decide(project, { decision: "this-wiki" })
      expect(loadCardMap(project)).toEqual({ ...before, up_decisions: { [id(9)]: "this-wiki" } })
    })

    it("refuses a decision that is not skip or this-wiki, and a card id that is not an id", async () => {
      const project = makeProject()
      // A root id was an answer in an older version; it is not one now.
      for (const event of [{ decision: "Skip" }, { decision: "other" }, { decision: undefined }, { decision: 5 }, { decision: id(12) }]) {
        const result = await decide(project, event)
        expect(result.exitCode).toBe(2)
        expect(result.output.problems).toEqual([expect.stringContaining("decision")])
      }
      for (const cardId of ["../x", undefined, id(9).toUpperCase().replace("0", "A")]) {
        const result = await decide(project, { cardId })
        expect(result.exitCode).toBe(2)
        expect(result.output.problems).toEqual([expect.stringContaining("cardId")])
      }
      expect(existsSync(join(project, "heptabase-map.json"))).toBe(false)
    })

    it("needs no heptabase.yaml", async () => {
      const project = makeProject({ "heptabase.yaml": "version: 2\n" })
      expect((await decide(project, { decision: "this-wiki" })).exitCode).toBe(0)
    })
  })

  describe("the command line", () => {
    it("saves the map after every event, without leftover files", async () => {
      const project = await createdProject()
      const sizes: number[] = []
      for (const event of [
        { type: "placed", page: PAGE, whiteboardId: id(31) },
        { type: "updated", page: PAGE, cardUpdatedAt: NOW, contentHash: HASH_B },
        { type: "retired", page: PAGE, cardUpdatedAt: NOW },
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
