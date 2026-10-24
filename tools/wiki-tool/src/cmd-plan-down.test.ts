/**
 * cmd-plan-down.test.ts - tests for `wiki-tool hepta plan-down`.
 *
 * The tests run the command through runCli, so they also cover the registration of the
 * hepta group. Results of earlier steps (create, record) come from the commands themselves,
 * the way the wiki-sync skill uses them. Ids are placeholders and titles are generic.
 */
import { readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, describe, expect, it } from "vitest"
import { type CardMap, contentHash, saveCardMap } from "./card-map"
import { runCli } from "./cli"
import type { DownAction } from "./cmd-plan-down"
import { id, makeProject, pageText, PROPERTY_IDS, removeProjects, writeProjectFile } from "./test-project"

const FIXTURES = fileURLToPath(new URL("../fixtures/", import.meta.url))
const DATABASE = join(FIXTURES, "read_database.json")

const NOW = "2026-10-24T08:00:00.000Z"
const UNSYNCED = "（僅在 wiki）"
const FOOTER_NOTICE = "由 wiki 產生，請勿直接編輯。"

afterEach(removeProjects)

interface PlanOutput {
  ok: boolean
  pass: 1 | 2
  actions: DownAction[]
  problems: unknown[]
}

async function plan(project: string, extra: string[] = []): Promise<{ exitCode: number; output: PlanOutput }> {
  const result = await runCli(["hepta", "plan-down", "--project", project, "--now", NOW, ...extra])
  return { exitCode: result.exitCode, output: result.output as unknown as PlanOutput }
}

async function record(project: string, event: Record<string, unknown>, now = NOW): Promise<void> {
  const result = await runCli(["hepta", "record", "--project", project, "--now", now, "--event", JSON.stringify(event)])
  if (result.exitCode !== 0) throw new Error(`record failed: ${JSON.stringify(result.output)}`)
}

/** Record a `created` event for a create action, as the skill does. */
async function recordCreated(project: string, action: DownAction, cardId: string, now = NOW): Promise<void> {
  if (action.op !== "create") throw new Error("not a create action")
  await record(
    project,
    { type: "created", page: action.page, cardId, cardUpdatedAt: now, contentHash: action.contentHash },
    now,
  )
}

/** Record an `updated` event for an update or relink action. */
async function recordUpdated(project: string, action: DownAction, now = NOW): Promise<void> {
  if (action.op !== "update" && action.op !== "relink") throw new Error("not an update action")
  await record(project, { type: "updated", page: action.page, cardUpdatedAt: now, contentHash: action.contentHash }, now)
}

function mechanism(title: string, body = "Body text.", extra: Record<string, string | string[]> = {}): string {
  return pageText({ type: "mechanism", title, sources: ["a.md"], ...extra }, body)
}

/** A list_cards text of the mirror tag: one line per card. */
function mirrorList(cards: { id: string; title: string; updated: string }[]): string {
  const lines = cards.map(
    (card) =>
      `card "${card.title}" [${card.id}] whiteboards: none, tags: wiki-test [${id(4)}], created: 2026-09-01T00:00:00.000Z; updated: ${card.updated}`,
  )
  return ["Cards:", ...lines].join("\n")
}

function writeMirrorList(project: string, cards: { id: string; title: string; updated: string }[]): string {
  writeProjectFile(project, ".llm-wiki/hepta/mirror.txt", mirrorList(cards))
  return join(project, ".llm-wiki/hepta/mirror.txt")
}

const MECHANISM_PATH = "wiki/mechanisms/event-driven.md"

/** A card map with pages built from a short form. */
function mapOf(pages: Record<string, { card_id: string; content_hash: string; status?: "active" | "retired" }>): CardMap {
  const map: CardMap = { version: 1, pages: {}, sources: {}, whiteboards_cache: { updated_at: "", items: [] } }
  for (const [path, entry] of Object.entries(pages)) {
    map.pages[path] = {
      card_id: entry.card_id,
      content_hash: entry.content_hash,
      last_synced_at: NOW,
      card_updated_at: NOW,
      placements: [],
      status: entry.status ?? "active",
    }
  }
  return map
}

describe("hepta plan-down", () => {
  it("plans create for an eligible new page", async () => {
    const project = makeProject({ [MECHANISM_PATH]: mechanism("Event Driven") })
    const result = await plan(project)
    expect(result.exitCode).toBe(0)
    const body = `# Event Driven\n\nBody text.\n\n---\n來源：無\n${FOOTER_NOTICE}`
    expect(result.output).toEqual({
      ok: true,
      pass: 1,
      problems: [],
      actions: [
        {
          op: "create",
          page: MECHANISM_PATH,
          title: "Event Driven",
          body,
          contentHash: contentHash(body),
          properties: [
            { propertyId: PROPERTY_IDS.page_type, type: "select", value: "mechanism" },
            { propertyId: PROPERTY_IDS.wiki, type: "select", value: "test" },
            { propertyId: PROPERTY_IDS.status, type: "select", value: "active" },
            { propertyId: PROPERTY_IDS.wiki_page, type: "text", value: MECHANISM_PATH },
            { propertyId: PROPERTY_IDS.last_synced, type: "date", value: { start: "2026-10-24T00:00:00.000Z" } },
          ],
        },
      ],
    })
  })

  it("uses the date of the clock for last synced, in UTC", async () => {
    const project = makeProject({ [MECHANISM_PATH]: mechanism("Event Driven") })
    const result = await runCli(["hepta", "plan-down", "--project", project, "--now", "2026-01-02T23:59:59.000-05:00"])
    const action = (result.output.actions as DownAction[])[0]
    // 23:59 at UTC-5 is 04:59 on the next day in UTC.
    const lastSynced = action.op === "create" ? action.properties.find((property) => property.propertyId === PROPERTY_IDS.last_synced) : null
    expect(lastSynced?.value).toEqual({ start: "2026-01-03T00:00:00.000Z" })
  })

  it("takes the title from the first heading when the frontmatter has none", async () => {
    const project = makeProject({
      "wiki/mechanisms/no-title.md": pageText({ type: "mechanism", sources: ["a.md"] }, "# Heading Title\n\nBody text."),
      "wiki/mechanisms/no-heading.md": pageText({ type: "mechanism", sources: ["a.md"] }, "Body text."),
    })
    const titles = (await plan(project)).output.actions.map((action) => (action.op === "create" ? action.title : ""))
    expect(titles).toEqual(["no-heading", "Heading Title"])
  })

  it("skips ineligible pages", async () => {
    const project = makeProject({
      // A concept needs two sources.
      "wiki/concepts/one-source.md": pageText({ type: "concept", title: "One", sources: ["a.md"], domain: "ai/x" }),
      "wiki/concepts/no-sources.md": pageText({ type: "concept", title: "None" }),
      "wiki/entities/someone.md": pageText({ type: "entity", title: "Someone", sources: ["a.md", "b.md"] }),
      "wiki/queries/question.md": pageText({ type: "query", title: "Question", sources: ["a.md", "b.md"] }),
      "wiki/untyped.md": "No frontmatter here.\n",
      // The pages the app maintains are never synced.
      "wiki/index.md": pageText({ type: "mechanism", title: "Index" }),
      "wiki/log.md": pageText({ type: "mechanism", title: "Log" }),
      "wiki/overview.md": pageText({ type: "mechanism", title: "Overview" }),
      "wiki/indexes/domain.md": pageText({ type: "mechanism", title: "Domain index" }),
      "wiki/notes.txt": "not a page",
    })
    const result = await plan(project)
    expect(result.exitCode).toBe(0)
    expect(result.output).toMatchObject({ ok: true, pass: 1, actions: [], problems: [] })
  })

  it("plans pages that are eligible by type or by source count", async () => {
    const project = makeProject({
      "wiki/concepts/two-sources.md": pageText({ type: "concept", title: "Two", sources: ["a.md", "b.md"] }),
      "wiki/concepts/repeated-source.md": pageText({ type: "concept", title: "Repeat", sources: ["a.md", "a.md"] }),
      "wiki/comparisons/versus.md": pageText({ type: "comparison", title: "Versus", sources: ["a.md"] }),
      "wiki/hypotheses/idea.md": pageText({ type: "hypothesis", title: "Idea", sources: ["a.md"] }),
    })
    const pages = (await plan(project)).output.actions.map((action) => action.page)
    expect(pages).toEqual(["wiki/comparisons/versus.md", "wiki/concepts/two-sources.md", "wiki/hypotheses/idea.md"])
  })

  it("plans update only when content changed", async () => {
    const project = makeProject({ [MECHANISM_PATH]: mechanism("Event Driven") })
    const first = await plan(project)
    await recordCreated(project, first.output.actions[0], id(21))

    expect((await plan(project)).output.actions).toEqual([])

    writeProjectFile(project, MECHANISM_PATH, mechanism("Event Driven", "Changed body."))
    const changed = (await plan(project)).output.actions
    const body = `# Event Driven\n\nChanged body.\n\n---\n來源：無\n${FOOTER_NOTICE}`
    expect(changed).toEqual([
      {
        op: "update",
        page: MECHANISM_PATH,
        cardId: id(21),
        title: "Event Driven",
        body,
        contentHash: contentHash(body),
        properties: expect.any(Array),
      },
    ])
    const update = changed[0]
    expect(update.op === "update" && update.properties.map((property) => property.propertyId)).toEqual([
      PROPERTY_IDS.page_type,
      PROPERTY_IDS.wiki,
      PROPERTY_IDS.status,
      PROPERTY_IDS.wiki_page,
      PROPERTY_IDS.last_synced,
    ])
  })

  it("counts a new title as a change", async () => {
    const project = makeProject({ [MECHANISM_PATH]: mechanism("Event Driven") })
    await recordCreated(project, (await plan(project)).output.actions[0], id(21))
    writeProjectFile(project, MECHANISM_PATH, mechanism("Event Driven Systems"))
    const [action] = (await plan(project)).output.actions
    expect(action).toMatchObject({ op: "update", title: "Event Driven Systems" })
  })

  it("detects user edits", async () => {
    const project = makeProject({ [MECHANISM_PATH]: mechanism("Event Driven") })
    await recordCreated(project, (await plan(project)).output.actions[0], id(21))
    writeProjectFile(project, MECHANISM_PATH, mechanism("Event Driven", "Changed body."))

    // The card changed ten minutes after the last sync: do not overwrite it.
    const edited = writeMirrorList(project, [{ id: id(21), title: "Event Driven", updated: "2026-10-24T08:10:00.000Z" }])
    const result = await plan(project, ["--mirror-cards", edited])
    expect(result.output.actions).toEqual([
      { op: "skip-edited", page: MECHANISM_PATH, cardId: id(21), cardUpdatedAt: "2026-10-24T08:10:00.000Z" },
    ])
  })

  it("allows 60 seconds between the sync and the card update", async () => {
    const project = makeProject({ [MECHANISM_PATH]: mechanism("Event Driven") })
    await recordCreated(project, (await plan(project)).output.actions[0], id(21))
    writeProjectFile(project, MECHANISM_PATH, mechanism("Event Driven", "Changed body."))

    const within = writeMirrorList(project, [{ id: id(21), title: "Event Driven", updated: "2026-10-24T08:01:00.000Z" }])
    expect((await plan(project, ["--mirror-cards", within])).output.actions.map((a) => a.op)).toEqual(["update"])
    const beyond = writeMirrorList(project, [{ id: id(21), title: "Event Driven", updated: "2026-10-24T08:01:01.000Z" }])
    expect((await plan(project, ["--mirror-cards", beyond])).output.actions.map((a) => a.op)).toEqual(["skip-edited"])
  })

  it("does not report an edited card whose page did not change", async () => {
    const project = makeProject({ [MECHANISM_PATH]: mechanism("Event Driven") })
    await recordCreated(project, (await plan(project)).output.actions[0], id(21))
    const edited = writeMirrorList(project, [{ id: id(21), title: "Event Driven", updated: "2026-10-24T09:00:00.000Z" }])
    expect((await plan(project, ["--mirror-cards", edited])).output.actions).toEqual([])
  })

  it("reads the mirror cards from several list files", async () => {
    const project = makeProject({ [MECHANISM_PATH]: mechanism("Event Driven") })
    await recordCreated(project, (await plan(project)).output.actions[0], id(21))
    writeProjectFile(project, MECHANISM_PATH, mechanism("Event Driven", "Changed body."))
    writeProjectFile(project, "one.txt", mirrorList([{ id: id(22), title: "Other", updated: "2026-10-24T08:00:00.000Z" }]))
    writeProjectFile(project, "two.txt", mirrorList([{ id: id(21), title: "Event Driven", updated: "2026-10-24T09:00:00.000Z" }]))
    const result = await plan(project, ["--mirror-cards", join(project, "one.txt"), "--mirror-cards", join(project, "two.txt")])
    expect(result.output.actions.map((a) => a.op)).toEqual(["skip-edited"])
  })

  it("plans retire when a mapped page is deleted", async () => {
    const project = makeProject({ [MECHANISM_PATH]: mechanism("Event Driven") })
    await recordCreated(project, (await plan(project)).output.actions[0], id(21))
    rmSync(join(project, MECHANISM_PATH))

    // Without the card list the title falls back to the file name.
    const bare = await plan(project)
    expect(bare.output.actions).toEqual([
      {
        op: "retire",
        page: MECHANISM_PATH,
        cardId: id(21),
        title: "🗄 已停用｜event-driven",
        body: "此頁已從 wiki 移除。",
        contentHash: contentHash("此頁已從 wiki 移除。"),
        properties: [
          { propertyId: PROPERTY_IDS.status, type: "select", value: "retired" },
          { propertyId: PROPERTY_IDS.last_synced, type: "date", value: { start: "2026-10-24T00:00:00.000Z" } },
        ],
      },
    ])

    // The card title comes from the list; a prefix that is there already is not doubled.
    const list = writeMirrorList(project, [{ id: id(21), title: "🗄 已停用｜Event Driven", updated: NOW }])
    const listed = await plan(project, ["--mirror-cards", list])
    expect(listed.output.actions[0]).toMatchObject({ op: "retire", title: "🗄 已停用｜Event Driven" })
  })

  it("plans retire when a mapped page is no longer eligible", async () => {
    const project = makeProject({
      "wiki/concepts/idea.md": pageText({ type: "concept", title: "Idea", sources: ["a.md", "b.md"] }),
    })
    await recordCreated(project, (await plan(project)).output.actions[0], id(21))
    writeProjectFile(project, "wiki/concepts/idea.md", pageText({ type: "concept", title: "Idea", sources: ["a.md"] }))
    const [action] = (await plan(project)).output.actions
    expect(action).toMatchObject({ op: "retire", cardId: id(21), title: "🗄 已停用｜Idea" })
  })

  it("does not plan anything for a retired card whose page is gone", async () => {
    const project = makeProject()
    saveCardMap(
      project,
      mapOf({ "wiki/mechanisms/gone.md": { card_id: id(21), content_hash: "x", status: "retired" } }),
    )
    expect((await plan(project)).output.actions).toEqual([])
  })

  it("does not retire a card the user edited", async () => {
    const project = makeProject({ [MECHANISM_PATH]: mechanism("Event Driven") })
    await recordCreated(project, (await plan(project)).output.actions[0], id(21))
    rmSync(join(project, MECHANISM_PATH))
    const edited = writeMirrorList(project, [{ id: id(21), title: "Event Driven", updated: "2026-10-24T09:00:00.000Z" }])
    expect((await plan(project, ["--mirror-cards", edited])).output.actions.map((a) => a.op)).toEqual(["skip-edited"])
  })

  it("revives a retired card when its page is back", async () => {
    const project = makeProject({ [MECHANISM_PATH]: mechanism("Event Driven") })
    saveCardMap(
      project,
      mapOf({ [MECHANISM_PATH]: { card_id: id(21), content_hash: contentHash("此頁已從 wiki 移除。"), status: "retired" } }),
    )
    const [action] = (await plan(project)).output.actions
    expect(action).toMatchObject({ op: "update", cardId: id(21), title: "Event Driven" })
    expect(action.op === "update" && action.properties).toContainEqual({
      propertyId: PROPERTY_IDS.status,
      type: "select",
      value: "active",
    })
  })

  it("does not retire a page whose frontmatter cannot be read", async () => {
    const project = makeProject({ [MECHANISM_PATH]: mechanism("Event Driven") })
    await recordCreated(project, (await plan(project)).output.actions[0], id(21))
    writeProjectFile(project, MECHANISM_PATH, "---\ntype: [mechanism\n---\nBody\n")
    const result = await plan(project)
    expect(result.exitCode).toBe(0)
    expect(result.output.actions).toEqual([])
    expect(result.output.problems).toEqual([{ page: MECHANISM_PATH, problem: expect.stringContaining("frontmatter") }])
  })

  it("omits domain for mechanism pages", async () => {
    const project = makeProject({
      "wiki/mechanisms/a.md": mechanism("A", "Body.", { domain: "business/financial-analysis" }),
      "wiki/concepts/b.md": pageText({ type: "concept", title: "B", sources: ["a.md", "b.md"], domain: "business/financial-analysis" }),
      "wiki/concepts/c.md": pageText({ type: "concept", title: "C", sources: ["a.md", "b.md"] }),
    })
    const actions = (await plan(project)).output.actions
    const domains = (page: string) => {
      const action = actions.find((candidate) => candidate.page === page)
      return action?.op === "create" ? action.properties.filter((property) => property.propertyId === PROPERTY_IDS.domain) : null
    }
    expect(domains("wiki/mechanisms/a.md")).toEqual([])
    expect(domains("wiki/concepts/b.md")).toEqual([
      { propertyId: PROPERTY_IDS.domain, type: "select", value: "business/financial-analysis" },
    ])
    // A page without a domain gets no domain property.
    expect(domains("wiki/concepts/c.md")).toEqual([])
  })

  it("adds hypothesis properties", async () => {
    const project = makeProject({
      "wiki/hypotheses/idea.md": pageText({
        type: "hypothesis",
        title: "Idea",
        sources: ["a.md"],
        from_domain: "business/financial-analysis",
        to_domain: "education/learning-science",
        status: "testing",
        strength: "structural",
      }),
    })
    const [action] = (await plan(project)).output.actions
    expect(action.op === "create" && action.properties).toEqual([
      { propertyId: PROPERTY_IDS.domain, type: "select", value: "education/learning-science" },
      { propertyId: PROPERTY_IDS.page_type, type: "select", value: "hypothesis" },
      { propertyId: PROPERTY_IDS.wiki, type: "select", value: "test" },
      { propertyId: PROPERTY_IDS.status, type: "select", value: "active" },
      { propertyId: PROPERTY_IDS.wiki_page, type: "text", value: "wiki/hypotheses/idea.md" },
      { propertyId: PROPERTY_IDS.last_synced, type: "date", value: { start: "2026-10-24T00:00:00.000Z" } },
      { propertyId: PROPERTY_IDS.hypothesis_status, type: "select", value: "testing" },
      { propertyId: PROPERTY_IDS.strength, type: "select", value: "structural" },
    ])
  })

  it("leaves out a property that heptabase.yaml does not name", async () => {
    const project = makeProject({ [MECHANISM_PATH]: mechanism("Event Driven") })
    const yaml = readFileSync(join(project, "heptabase.yaml"), "utf8")
    writeFileSync(join(project, "heptabase.yaml"), yaml.replace(/ {2}last_synced: .*\n/, "").replace(/ {2}wiki_page: .*\n/, ""))
    const [action] = (await plan(project)).output.actions
    expect(action.op === "create" && action.properties.map((property) => property.propertyId)).toEqual([
      PROPERTY_IDS.page_type,
      PROPERTY_IDS.wiki,
      PROPERTY_IDS.status,
    ])
  })

  it("plans relink in pass 2", async () => {
    const project = makeProject({
      "wiki/mechanisms/alpha.md": mechanism("Alpha", "See [[beta]] and [[missing-page]]."),
      "wiki/mechanisms/beta.md": mechanism("Beta", "See [[alpha]]."),
    })

    // Pass 1: both pages are new, so the links between them are not resolved yet.
    const first = await plan(project)
    expect(first.output.pass).toBe(1)
    const creates = first.output.actions
    expect(creates.map((action) => action.op)).toEqual(["create", "create"])
    expect(creates[0].op === "create" && creates[0].body).toContain(`Beta${UNSYNCED}`)
    expect(creates[0].op === "create" && creates[0].body).toContain(`missing-page${UNSYNCED}`)
    await recordCreated(project, creates[0], id(21))
    await recordCreated(project, creates[1], id(22))

    // Pass 2: the cards exist, so both pages get their links.
    const second = await plan(project)
    expect(second.output.pass).toBe(2)
    expect(second.output.actions.map((action) => [action.op, action.page])).toEqual([
      ["relink", "wiki/mechanisms/alpha.md"],
      ["relink", "wiki/mechanisms/beta.md"],
    ])
    const [alpha, beta] = second.output.actions
    expect(alpha.op === "relink" && alpha.cardId).toBe(id(21))
    expect(alpha.op === "relink" && alpha.body).toContain(`[Beta](heptabase://card/${id(22)})`)
    expect(alpha.op === "relink" && alpha.body).toContain(`missing-page${UNSYNCED}`)
    expect(beta.op === "relink" && beta.body).toContain(`[Alpha](heptabase://card/${id(21)})`)
    // A relink carries the body and nothing else.
    expect(Object.keys(alpha).sort()).toEqual(["body", "cardId", "contentHash", "op", "page"])

    await recordUpdated(project, alpha)
    await recordUpdated(project, beta)
    expect(await plan(project)).toMatchObject({ output: { pass: 1, actions: [] } })
  })

  it("relinks a page that links to an old page and a new one", async () => {
    const project = makeProject({
      "wiki/mechanisms/old.md": mechanism("Old"),
      "wiki/mechanisms/fresh.md": mechanism("Fresh"),
      "wiki/mechanisms/linker.md": mechanism("Linker", "See [[old]] and [[fresh]]."),
    })
    // Only the old page is synced in the first wave.
    const firstPlan = await plan(project)
    await recordCreated(project, firstPlan.output.actions.find((a) => a.page.endsWith("old.md")) as DownAction, id(21))

    const wave = (await plan(project)).output
    expect(wave.actions.map((action) => [action.op, action.page])).toEqual([
      ["create", "wiki/mechanisms/fresh.md"],
      ["create", "wiki/mechanisms/linker.md"],
    ])
    const linker = wave.actions[1]
    expect(linker.op === "create" && linker.body).toContain(`[Old](heptabase://card/${id(21)})`)
    expect(linker.op === "create" && linker.body).toContain(`Fresh${UNSYNCED}`)
    await recordCreated(project, wave.actions[0], id(22))
    await recordCreated(project, wave.actions[1], id(23))

    const relinks = (await plan(project)).output
    expect(relinks.pass).toBe(2)
    expect(relinks.actions).toMatchObject([{ op: "relink", page: "wiki/mechanisms/linker.md", cardId: id(23) }])
  })

  it("relinks a page with many links", async () => {
    const names = Array.from({ length: 12 }, (_unused, index) => `target-${String(index + 1).padStart(2, "0")}`)
    const files: Record<string, string> = {
      "wiki/mechanisms/linker.md": mechanism("Linker", names.map((name) => `[[${name}]]`).join(" ")),
    }
    for (const name of names) files[`wiki/mechanisms/${name}.md`] = mechanism(name)
    const project = makeProject(files)

    // The first eleven targets get a card first, so the linker is sent with only the last one missing.
    const everything = (await plan(project)).output.actions
    for (const [index, name] of names.slice(0, 11).entries()) {
      await recordCreated(project, everything.find((action) => action.page.endsWith(`/${name}.md`)) as DownAction, id(21 + index))
    }
    const wave = (await plan(project)).output.actions
    expect(wave.map((action) => action.page)).toEqual(["wiki/mechanisms/linker.md", "wiki/mechanisms/target-12.md"])
    await recordCreated(project, wave[0], id(40))
    await recordCreated(project, wave[1], id(41))

    const relinks = (await plan(project)).output
    expect(relinks.pass).toBe(2)
    expect(relinks.actions).toMatchObject([{ op: "relink", page: "wiki/mechanisms/linker.md", cardId: id(40) }])
  })

  it("plans an update, not a relink, when the content changed as well", async () => {
    const project = makeProject({
      "wiki/mechanisms/alpha.md": mechanism("Alpha", "See [[beta]]."),
      "wiki/mechanisms/beta.md": mechanism("Beta"),
    })
    const creates = (await plan(project)).output.actions
    await recordCreated(project, creates[0], id(21))
    await recordCreated(project, creates[1], id(22))
    writeProjectFile(project, "wiki/mechanisms/alpha.md", mechanism("Alpha", "See [[beta]] for more."))
    const result = await plan(project)
    expect(result.output.pass).toBe(1)
    expect(result.output.actions.map((action) => action.op)).toEqual(["update"])
  })

  it("waits with relinks until the pass 1 actions are recorded", async () => {
    const project = makeProject({
      "wiki/mechanisms/alpha.md": mechanism("Alpha", "See [[beta]]."),
      "wiki/mechanisms/beta.md": mechanism("Beta"),
    })
    const creates = (await plan(project)).output.actions
    await recordCreated(project, creates[0], id(21))
    await recordCreated(project, creates[1], id(22))
    // A new page appears while the relink of alpha is due.
    writeProjectFile(project, "wiki/mechanisms/gamma.md", mechanism("Gamma"))
    const during = await plan(project)
    expect(during.output.pass).toBe(1)
    expect(during.output.actions.map((action) => [action.op, action.page])).toEqual([["create", "wiki/mechanisms/gamma.md"]])
    await recordCreated(project, during.output.actions[0], id(23))
    expect((await plan(project)).output).toMatchObject({ pass: 2, actions: [{ op: "relink", page: "wiki/mechanisms/alpha.md" }] })
  })

  it("does not relink a card the user edited", async () => {
    const project = makeProject({
      "wiki/mechanisms/alpha.md": mechanism("Alpha", "See [[beta]]."),
      "wiki/mechanisms/beta.md": mechanism("Beta"),
    })
    const creates = (await plan(project)).output.actions
    await recordCreated(project, creates[0], id(21))
    await recordCreated(project, creates[1], id(22))
    const edited = writeMirrorList(project, [{ id: id(21), title: "Alpha", updated: "2026-10-24T09:00:00.000Z" }])
    const result = await plan(project, ["--mirror-cards", edited])
    expect(result.output.actions.map((a) => a.op)).toEqual(["skip-edited"])
  })

  it("keeps a link to a page that is not eligible as plain text", async () => {
    const project = makeProject({
      "wiki/mechanisms/alpha.md": mechanism("Alpha", "See [[small]]."),
      "wiki/concepts/small.md": pageText({ type: "concept", title: "Small Concept", sources: ["a.md"] }),
    })
    const [action] = (await plan(project)).output.actions
    expect(action.op === "create" && action.body).toContain(`Small Concept${UNSYNCED}`)
  })

  it("plans place for a hypothesis once", async () => {
    const hypothesis = pageText({
      type: "hypothesis",
      title: "Idea",
      sources: ["a.md"],
      to_domain: "education/learning-science",
      status: "draft",
      heptabase_whiteboard: id(31),
    })
    const project = makeProject({ "wiki/hypotheses/idea.md": hypothesis })

    // The card does not exist yet, so there is nothing to place.
    const first = await plan(project)
    expect(first.output.actions.map((action) => action.op)).toEqual(["create"])
    await recordCreated(project, first.output.actions[0], id(21))

    const second = await plan(project)
    expect(second.output.actions).toEqual([
      { op: "place", page: "wiki/hypotheses/idea.md", cardId: id(21), whiteboardId: id(31) },
    ])

    await record(project, { type: "placed", page: "wiki/hypotheses/idea.md", whiteboardId: id(31) })
    expect((await plan(project)).output.actions).toEqual([])

    // A new whiteboard is placed again; the first one stays recorded.
    writeProjectFile(
      project,
      "wiki/hypotheses/idea.md",
      hypothesis.replace(`heptabase_whiteboard: "${id(31)}"`, `heptabase_whiteboard: "${id(32)}"`),
    )
    const third = (await plan(project)).output.actions
    expect(third).toEqual([{ op: "place", page: "wiki/hypotheses/idea.md", cardId: id(21), whiteboardId: id(32) }])
  })

  it("reports a heptabase_whiteboard that is not an id", async () => {
    const project = makeProject({
      "wiki/hypotheses/idea.md": pageText({ type: "hypothesis", title: "Idea", sources: ["a.md"], heptabase_whiteboard: "Board A" }),
    })
    await recordCreated(project, (await plan(project)).output.actions[0], id(21))
    const result = await plan(project)
    expect(result.output.actions).toEqual([])
    expect(result.output.problems).toEqual([
      { page: "wiki/hypotheses/idea.md", problem: expect.stringContaining("heptabase_whiteboard") },
    ])
  })

  it("resumes after partial run", async () => {
    const project = makeProject({
      "wiki/mechanisms/alpha.md": mechanism("Alpha"),
      "wiki/mechanisms/beta.md": mechanism("Beta"),
    })
    const first = await plan(project)
    expect(first.output.actions.map((action) => action.page)).toEqual(["wiki/mechanisms/alpha.md", "wiki/mechanisms/beta.md"])

    // The run stops after the first card.
    await recordCreated(project, first.output.actions[0], id(21))

    const second = await plan(project)
    expect(second.output.actions.map((action) => [action.op, action.page])).toEqual([["create", "wiki/mechanisms/beta.md"]])
  })

  it("reports a missing select option", async () => {
    const project = makeProject({
      "wiki/concepts/known.md": pageText({
        type: "concept",
        title: "Known",
        sources: ["a.md", "b.md"],
        domain: "education/learning-science",
      }),
      "wiki/concepts/new-domain.md": pageText({
        type: "concept",
        title: "New Domain",
        sources: ["a.md", "b.md"],
        domain: "ai/new-domain",
      }),
    })

    // Without the database nothing is checked.
    const unchecked = await plan(project)
    expect(unchecked.output.actions.map((action) => action.page)).toEqual([
      "wiki/concepts/known.md",
      "wiki/concepts/new-domain.md",
    ])

    const checked = await plan(project, ["--database", DATABASE])
    expect(checked.exitCode).toBe(0)
    expect(checked.output.ok).toBe(true)
    expect(checked.output.actions.map((action) => action.page)).toEqual(["wiki/concepts/known.md"])
    expect(checked.output.problems).toEqual([
      {
        page: "wiki/concepts/new-domain.md",
        problem: 'add the option "ai/new-domain" to the "domain" property in Heptabase',
      },
    ])
  })

  it("reports every missing option of a page and plans nothing for it", async () => {
    const project = makeProject(
      {
        "wiki/hypotheses/idea.md": pageText({
          type: "hypothesis",
          title: "Idea",
          sources: ["a.md"],
          to_domain: "ai/new-domain",
          status: "paused",
          strength: "structural",
          heptabase_whiteboard: id(31),
        }),
      },
      { wikiId: "other-wiki" },
    )
    const result = await plan(project, ["--database", DATABASE])
    expect(result.output.actions).toEqual([])
    expect(result.output.problems).toEqual([
      { page: "wiki/hypotheses/idea.md", problem: 'add the option "ai/new-domain" to the "domain" property in Heptabase' },
      { page: "wiki/hypotheses/idea.md", problem: 'add the option "other-wiki" to the "wiki" property in Heptabase' },
      { page: "wiki/hypotheses/idea.md", problem: 'add the option "paused" to the "hypothesis status" property in Heptabase' },
    ])
  })

  it("checks the options of an update and of a retire", async () => {
    const project = makeProject({
      "wiki/concepts/known.md": pageText({ type: "concept", title: "Known", sources: ["a.md", "b.md"], domain: "education/learning-science" }),
    })
    await recordCreated(project, (await plan(project)).output.actions[0], id(21))
    writeProjectFile(
      project,
      "wiki/concepts/known.md",
      pageText({ type: "concept", title: "Known", sources: ["a.md", "b.md"], domain: "ai/new-domain" }, "Changed body."),
    )
    const updated = await plan(project, ["--database", DATABASE])
    expect(updated.output.actions).toEqual([])
    expect(updated.output.problems).toHaveLength(1)

    // A database that has no "retired" status option blocks the retire.
    const database = JSON.parse(readFileSync(DATABASE, "utf8")) as {
      configuration: { schema: Record<string, { options?: { name: string }[] }> }
    }
    const status = database.configuration.schema[PROPERTY_IDS.status]
    status.options = status.options?.filter((option) => option.name !== "retired")
    writeFileSync(join(project, "database.json"), JSON.stringify(database))
    rmSync(join(project, "wiki/concepts/known.md"))
    const retired = await plan(project, ["--database", join(project, "database.json")])
    expect(retired.output.actions).toEqual([])
    expect(retired.output.problems).toEqual([
      { page: "wiki/concepts/known.md", problem: 'add the option "retired" to the "status" property in Heptabase' },
    ])
  })

  it("rejects a database that lacks a configured select property", async () => {
    const project = makeProject({ [MECHANISM_PATH]: mechanism("Event Driven") })
    const database = JSON.parse(readFileSync(DATABASE, "utf8")) as { configuration: { schema: Record<string, unknown> } }
    delete database.configuration.schema[PROPERTY_IDS.strength]
    writeFileSync(join(project, "database.json"), JSON.stringify(database))
    const result = await plan(project, ["--database", join(project, "database.json")])
    expect(result.exitCode).toBe(2)
    expect(result.output.problems).toEqual([expect.stringContaining(PROPERTY_IDS.strength)])
  })

  it("footer lists source cards from snapshots", async () => {
    const project = makeProject({
      "wiki/concepts/idea.md": pageText({
        type: "concept",
        title: "Idea",
        // The third name has no snapshot; the fourth is a path in the identity form of the app.
        sources: [`${id(61)}.md`, "article.md", "heptabase/other-name.md", `heptabase/${id(62)}.md`],
      }),
      [`raw/sources/heptabase/${id(61)}.md`]: pageText({ title: "Snapshot [One]", heptabase_card_id: id(61), source_kind: "note" }),
      // This snapshot has no title: the file name stands in.
      [`raw/sources/heptabase/${id(62)}.md`]: "Just text.\n",
    })
    saveCardMap(project, {
      ...mapOf({}),
      sources: {
        [id(61)]: { raw_path: `raw/sources/heptabase/${id(61)}.md`, card_updated_at: NOW, ingest_commit: null },
        [id(62)]: { raw_path: `raw/sources/heptabase/${id(62)}.md`, card_updated_at: NOW, ingest_commit: null },
        [id(63)]: { raw_path: "raw/sources/heptabase/unused.md", card_updated_at: NOW, ingest_commit: null },
      },
    })
    const [action] = (await plan(project)).output.actions
    expect(action.op === "create" && action.body).toBe(
      [
        "# Idea",
        "",
        "Body text.",
        "",
        "---",
        `來源：[Snapshot \\[One\\]](heptabase://card/${id(61)}), [${id(62)}](heptabase://card/${id(62)})`,
        FOOTER_NOTICE,
      ].join("\n"),
    )
  })

  it("lists a source card once", async () => {
    const snapshot = `raw/sources/heptabase/${id(61)}.md`
    const project = makeProject({
      [MECHANISM_PATH]: pageText({ type: "mechanism", title: "Event Driven", sources: [`${id(61)}.md`, `heptabase/${id(61)}.md`] }),
      [snapshot]: pageText({ title: "Snapshot" }),
    })
    saveCardMap(project, {
      ...mapOf({}),
      sources: { [id(61)]: { raw_path: snapshot, card_updated_at: NOW, ingest_commit: null } },
    })
    const [action] = (await plan(project)).output.actions
    expect(action.op === "create" && action.body).toContain(`來源：[Snapshot](heptabase://card/${id(61)})\n`)
  })

  it("counts a change of a snapshot title as a change of the page", async () => {
    const snapshot = `raw/sources/heptabase/${id(61)}.md`
    const project = makeProject({
      [MECHANISM_PATH]: pageText({ type: "mechanism", title: "Event Driven", sources: [`${id(61)}.md`] }),
      [snapshot]: pageText({ title: "Old Title" }),
    })
    saveCardMap(project, {
      ...mapOf({}),
      sources: { [id(61)]: { raw_path: snapshot, card_updated_at: NOW, ingest_commit: null } },
    })
    await recordCreated(project, (await plan(project)).output.actions[0], id(21))
    expect((await plan(project)).output.actions).toEqual([])
    writeProjectFile(project, snapshot, pageText({ title: "New Title" }))
    const [action] = (await plan(project)).output.actions
    expect(action.op === "update" && action.body).toContain("[New Title]")
  })

  it("ignores a snapshot path that leaves the project", async () => {
    const project = makeProject({
      [MECHANISM_PATH]: pageText({ type: "mechanism", title: "Event Driven", sources: ["outside.md"] }),
    })
    saveCardMap(project, {
      ...mapOf({}),
      sources: { [id(61)]: { raw_path: "../outside.md", card_updated_at: NOW, ingest_commit: null } },
    })
    const [action] = (await plan(project)).output.actions
    expect(action.op === "create" && action.body).toContain(`來源：[outside](heptabase://card/${id(61)})`)
  })

  it("does not change files", async () => {
    const project = makeProject({ [MECHANISM_PATH]: mechanism("Event Driven") })
    await plan(project)
    expect(() => readFileSync(join(project, "heptabase-map.json"))).toThrow()
  })

  describe("when the inputs are wrong", () => {
    it("requires --project", async () => {
      const result = await runCli(["hepta", "plan-down"])
      expect(result.exitCode).toBe(2)
      expect(result.output).toEqual({ ok: false, problems: ["missing option: --project"] })
    })

    it("reports a project folder that is not there", async () => {
      const result = await runCli(["hepta", "plan-down", "--project", join(makeProject(), "nope")])
      expect(result.exitCode).toBe(2)
      expect(result.output.problems).toEqual([expect.stringContaining("project folder not found")])
    })

    it("reports a missing heptabase.yaml", async () => {
      const project = makeProject({}, { noHeptabaseYaml: true })
      const result = await plan(project)
      expect(result.exitCode).toBe(2)
      expect(result.output.problems).toEqual([expect.stringContaining("heptabase.yaml")])
    })

    it("reports the problems of an invalid heptabase.yaml and wiki.yaml", async () => {
      const project = makeProject()
      writeProjectFile(project, "heptabase.yaml", "version: 2\n")
      writeProjectFile(project, "wiki.yaml", "version: 1\nid: Bad Id\nrole: reading\n")
      const result = await plan(project)
      expect(result.exitCode).toBe(2)
      const problems = result.output.problems as string[]
      expect(problems.filter((problem) => problem.startsWith("invalid heptabase.yaml: "))).not.toHaveLength(0)
      expect(problems.filter((problem) => problem.startsWith("invalid wiki.yaml: "))).toEqual([
        expect.stringContaining("id:"),
      ])
    })

    it("reports a card map that cannot be read", async () => {
      const project = makeProject()
      writeProjectFile(project, "heptabase-map.json", "{ not json")
      const result = await plan(project)
      expect(result.exitCode).toBe(2)
      expect(result.output.problems).toEqual([expect.stringContaining("heptabase-map.json")])
    })

    it("reports a file it cannot read or understand", async () => {
      const project = makeProject()
      const missing = join(project, "missing.txt")
      const result = await runCli([
        "hepta",
        "plan-down",
        ...["--project", project, "--mirror-cards", missing, "--database", missing, "--now", "yesterday"],
      ])
      expect(result.exitCode).toBe(2)
      expect(result.output.problems).toEqual([
        expect.stringContaining("--now"),
        expect.stringContaining(`cannot read --mirror-cards file: ${missing}`),
        expect.stringContaining(`cannot read --database file: ${missing}`),
      ])
    })

    it("reports an option that does not exist", async () => {
      const project = makeProject()
      const result = await runCli(["hepta", "plan-down", "--project", project, "--bogus", "x"])
      expect(result.exitCode).toBe(2)
      expect(result.output.problems).toEqual(["unknown option: --bogus"])
    })
  })
})

