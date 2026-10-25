/**
 * Fusion candidates: the prompt, the reading of the answer, and the review item that a new mechanism gets.
 *
 * The parse tests use a context built by hand. The propose tests run on a real temp folder with real
 * `domains.yaml`, `wiki.yaml`, and mechanism pages; only the model is a fake. Every domain, board, and page
 * name here is an example name.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createTempProject, fileExists, readFileRaw, realFs, writeFileRaw } from "@/test-helpers/fs-temp"
import { useReviewStore } from "@/stores/review-store"
import { useWikiStore } from "@/stores/wiki-store"
import type { MechanismContext } from "./context"
import { loadMechanismContext } from "./context"

vi.mock("@/commands/fs", () => realFs)

/** What the fake model saw and what it answers. An `Error` makes the call fail. */
const model = vi.hoisted(() => ({
  answer: "" as string | Error,
  /** A call that never answers and never reports an error, as a stuck connection does. */
  hang: false,
  calls: [] as Array<{ system: string; user: string; maxTokens: unknown }>,
}))

vi.mock("@/lib/llm-client", () => ({
  streamChat: vi.fn(async (_config, messages, callbacks, _signal, overrides) => {
    model.calls.push({
      system: String(messages?.[0]?.content ?? ""),
      user: String(messages?.[1]?.content ?? ""),
      maxTokens: overrides?.max_tokens,
    })
    if (model.hang) await new Promise<never>(() => {})
    if (model.answer instanceof Error) {
      callbacks.onError(model.answer)
      return
    }
    callbacks.onToken(model.answer)
    callbacks.onDone()
  }),
}))

import {
  buildCandidatePrompt,
  FUSION_DISMISSED_FILE,
  instanceDomainsOf,
  parseCandidates,
  proposeFusionCandidates,
  readDismissedPairs,
  readRecentBoards,
} from "./fusion-candidates"

// --- a context and pages made by hand ----------------------------------

function fakeContext(domains: Record<string, string>): MechanismContext {
  return {
    projectPath: "/unused",
    identity: { version: 1, id: "reading", role: "reading", mechanism_library: null },
    identityStatus: "ok",
    domains: {
      version: 1,
      domains: Object.fromEntries(
        Object.entries(domains).map(([name, lens]) => [name, { lens, description: `About ${name}`, whiteboards: [] }]),
      ),
    },
    lenses: {},
    pageTypeRules: {},
    mechanismLibraryPath: "/unused",
    configIssues: [],
  }
}

const DOMAIN_LENSES = {
  "example/alpha": "hardware",
  "example/beta": "ai",
  "example/gamma": "physics",
  "example/delta": "business",
  "example/epsilon": "ai",
}

const PAGE_PATH = "wiki/mechanisms/example-loop.md"

const PAGE = [
  "---",
  "type: mechanism",
  'title: "Example loop"',
  "lenses: [hardware, ai]",
  "instances: [alpha-thing, beta-thing]",
  "tags: []",
  "related: []",
  'sources: ["a.md"]',
  "created: 2026-01-01",
  "updated: 2026-01-01",
  "---",
  "# Example loop",
  "",
  "A part acts only when a signal reaches it.",
  "",
  "## Parts",
  "",
  "- Signal: a change that needs a reaction.",
  "",
  "## Known instances",
  "",
  "- [[alpha-thing]] (example/alpha): local alpha",
  "- [[beta-thing]] (example/beta): local beta",
  "",
].join("\n")

const ZH_PAGE = [
  "---",
  "type: mechanism",
  'title: "範例迴圈"',
  "---",
  "# 範例迴圈",
  "",
  "## 已知實例",
  "",
  "- [[alpha-thing]] (example/alpha): 在地詞",
  "",
  "## Next",
  "",
  "- [[other-thing]] (example/gamma): not an instance line of the section",
].join("\n")

/** The first line of `text` that matches `pattern`, or "". */
function lineWith(text: string, pattern: RegExp): string {
  return text.split("\n").find((candidate) => pattern.test(candidate)) ?? ""
}

function line(domain: string, strength: string, reason: string): string {
  return `CANDIDATE: ${domain} | ${strength} | ${reason}`
}

// --- parseCandidates ----------------------------------------------------

describe("parseCandidates", () => {
  const ctx = fakeContext(DOMAIN_LENSES)

  it("parses up to three candidates", () => {
    const output = [
      "Here are the candidates:",
      line("example/gamma", "structural", "Same trigger and same reaction."),
      line("example/delta", "surface", "Both wait for a request."),
      line("example/epsilon", "mathematical", "The same update rule."),
      line("example/alpha", "structural", "A fourth line must not count."),
    ].join("\n")

    const parsed = parseCandidates(output, ctx, [], [])

    expect(parsed).toEqual([
      { mechanism: "", targetDomain: "example/gamma", strength: "structural", reason: "Same trigger and same reaction." },
      { mechanism: "", targetDomain: "example/delta", strength: "surface", reason: "Both wait for a request." },
      { mechanism: "", targetDomain: "example/epsilon", strength: "mathematical", reason: "The same update rule." },
    ])
  })

  it("keeps the model order, the first three valid lines, and the mechanism that was given", () => {
    const output = [
      line("example/zzz", "structural", "Not a known domain."),
      line("example/delta", "surface", "First valid line."),
      line("example/gamma", "huge", "Not a known strength."),
      line("example/gamma", "structural", "Second valid line."),
      line("example/epsilon", "mathematical", "Third valid line."),
      line("example/alpha", "surface", "Fourth valid line."),
    ].join("\n")

    const parsed = parseCandidates(output, ctx, [], [], PAGE_PATH)

    expect(parsed.map((candidate) => candidate.targetDomain)).toEqual(["example/delta", "example/gamma", "example/epsilon"])
    expect(parsed.every((candidate) => candidate.mechanism === PAGE_PATH)).toBe(true)
  })

  it("drops unknown domains", () => {
    const output = [
      line("example/unknown", "structural", "The wiki has no such domain."),
      line("example", "structural", "A parent that is not listed."),
      line("EXAMPLE/GAMMA", "structural", "Different letters."),
      line("example/gamma", "structural", "This one is listed."),
    ].join("\n")

    const parsed = parseCandidates(output, ctx, [], [])

    expect(parsed.map((candidate) => candidate.targetDomain)).toEqual(["example/gamma"])
  })

  it("matches a domain exactly after trimming, and drops a strength outside the three", () => {
    const output = [
      "CANDIDATE:   example/gamma   |   structural   |   Padded fields.   ",
      line("example/delta", "strong", "Strength is not one of the three."),
      line("example/epsilon", "", "Strength is empty."),
    ].join("\n")

    expect(parseCandidates(output, ctx, [], [])).toEqual([
      { mechanism: "", targetDomain: "example/gamma", strength: "structural", reason: "Padded fields." },
    ])
  })

  it("drops a line with no reason, a line that is not a candidate, and a domain that appears twice", () => {
    const output = [
      "CANDIDATE: example/gamma | structural",
      "CANDIDATE: example/gamma | structural |   ",
      "candidate: example/gamma | structural | Lower case is not the format.",
      "example/gamma | structural | No keyword.",
      line("example/delta", "surface", "Kept."),
      line("example/delta", "structural", "A second line for the same domain."),
      line("example/gamma", "structural", "Reason with | a bar | inside."),
    ].join("\n")

    expect(parseCandidates(output, ctx, [], [])).toEqual([
      { mechanism: "", targetDomain: "example/delta", strength: "surface", reason: "Kept." },
      { mechanism: "", targetDomain: "example/gamma", strength: "structural", reason: "Reason with | a bar | inside." },
    ])
  })

  it("dismissed pairs are not proposed", () => {
    const output = [
      line("example/gamma", "structural", "Dismissed before."),
      line("example/delta", "surface", "Not dismissed."),
      line("example/epsilon", "structural", "Dismissed for another mechanism."),
    ].join("\n")
    const dismissed = [
      { mechanism: PAGE_PATH, targetDomain: "example/gamma" },
      { mechanism: "wiki/mechanisms/other.md", targetDomain: "example/epsilon" },
    ]

    // With the mechanism, only a pair of that mechanism counts.
    expect(parseCandidates(output, ctx, dismissed, [], PAGE_PATH).map((c) => c.targetDomain)).toEqual([
      "example/delta",
      "example/epsilon",
    ])
    // Without it, the list is taken as the pairs of this mechanism: a domain in it is never proposed.
    expect(parseCandidates(output, ctx, dismissed, []).map((c) => c.targetDomain)).toEqual(["example/delta"])
  })

  it("skips domains that already have an instance", () => {
    const output = [
      line("example/alpha", "structural", "Already has an instance."),
      line("example/beta", "structural", "Already has an instance."),
      line("example/gamma", "structural", "Free."),
    ].join("\n")

    expect(parseCandidates(output, ctx, [], ["example/alpha", "example/beta"]).map((c) => c.targetDomain)).toEqual([
      "example/gamma",
    ])
  })

  it("returns nothing for an answer with no candidate line", () => {
    expect(parseCandidates("", ctx, [], [])).toEqual([])
    expect(parseCandidates("NONE", ctx, [], [])).toEqual([])
  })
})

// --- instanceDomainsOf --------------------------------------------------

describe("instanceDomainsOf", () => {
  it("reads the domain of each line of the Known instances section", () => {
    expect(instanceDomainsOf(PAGE)).toEqual(["example/alpha", "example/beta"])
  })

  it("reads the heading of any output language, and only that section", () => {
    expect(instanceDomainsOf(ZH_PAGE)).toEqual(["example/alpha"])
  })

  it("returns nothing for a page without the section", () => {
    expect(instanceDomainsOf("# Title\n\nNo sections.")).toEqual([])
  })
})

// --- buildCandidatePrompt ----------------------------------------------

describe("buildCandidatePrompt", () => {
  const ctx = fakeContext(DOMAIN_LENSES)

  it("carries the page, the domains with their lens, the instance domains, and the output format", () => {
    const prompt = buildCandidatePrompt(PAGE, ctx, [])

    expect(prompt).toContain("A part acts only when a signal reaches it.")
    for (const [domain, lens] of Object.entries(DOMAIN_LENSES)) expect(prompt).toContain(`- ${domain} (lens: ${lens})`)
    expect(prompt).toContain("CANDIDATE: <domain> | <surface|structural|mathematical> | <reason>")
    expect(prompt).toMatch(/at most 3/i)
    // The domains that have an instance are named on one line, and no other domain is.
    const skipLine = lineWith(prompt, /already has an instance/i)
    expect(skipLine).toContain("example/alpha, example/beta")
    expect(skipLine).not.toContain("example/gamma")
    expect(lineWith(prompt, /dismissed/i)).toBe("")
  })

  it("names the dismissed domains and the extra domains to skip", () => {
    const prompt = buildCandidatePrompt(PAGE, ctx, [], { dismissedDomains: ["example/gamma"], skipDomains: ["example/delta"] })

    expect(lineWith(prompt, /dismissed/i)).toMatch(/example\/gamma$/)
    expect(lineWith(prompt, /already has an instance/i)).toContain("example/alpha, example/beta, example/delta")
  })

  it("lists the recent boards as a hint, and says nothing about boards when there are none", () => {
    const withBoards = buildCandidatePrompt(PAGE, ctx, ["Board One", "Board Two"])
    expect(withBoards).toContain("- Board One")
    expect(withBoards).toContain("- Board Two")
    expect(withBoards).toMatch(/works on these boards/i)

    const without = buildCandidatePrompt(PAGE, ctx, [])
    expect(without).not.toMatch(/boards/i)
  })

  it("prefers a domain whose lens fits before a domain of the recent boards", () => {
    const prompt = buildCandidatePrompt(PAGE, ctx, ["Board One"])

    const lens = prompt.indexOf("lens fits")
    const boards = prompt.indexOf("recent boards")
    expect(lens).toBeGreaterThan(-1)
    expect(boards).toBeGreaterThan(lens)
  })
})

// --- readRecentBoards ---------------------------------------------------

describe("readRecentBoards", () => {
  let tmp: { path: string; cleanup: () => Promise<void> }
  let project: string

  beforeEach(async () => {
    tmp = await createTempProject("fusion-boards")
    // A folder inside the temp folder, so a path that leaves the project still lands in the temp folder.
    project = `${tmp.path}/project`
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    await tmp.cleanup()
  })

  function snapshot(boards: string[]): string {
    const list = boards.map((board) => JSON.stringify(board)).join(", ")
    return `---\ntitle: "Card"\nheptabase_whiteboards: [${list}]\n---\n\nBody.\n`
  }

  async function writeMap(sources: Record<string, { raw_path: string; card_updated_at: string }>, file = "heptabase-map.json") {
    const map = {
      version: 1,
      pages: {},
      sources: Object.fromEntries(
        Object.entries(sources).map(([id, entry]) => [id, { ...entry, ingest_commit: null }]),
      ),
      whiteboards_cache: { updated_at: "", items: [] },
    }
    await writeFileRaw(`${project}/${file}`, JSON.stringify(map))
  }

  it("is empty when there is no card map", async () => {
    expect(await readRecentBoards(project)).toEqual([])
  })

  it("is empty when the card map has no sources", async () => {
    await writeMap({})
    expect(await readRecentBoards(project)).toEqual([])
  })

  it("takes the distinct boards of the five newest snapshots, newest first", async () => {
    const sources: Record<string, { raw_path: string; card_updated_at: string }> = {}
    for (let day = 1; day <= 7; day++) {
      const id = `card-${day}`
      sources[id] = { raw_path: `raw/sources/heptabase/${id}.md`, card_updated_at: `2026-02-0${day}T10:00:00.000Z` }
      await writeFileRaw(`${project}/raw/sources/heptabase/${id}.md`, snapshot([`Board ${day}`, "Shared Board"]))
    }
    await writeMap(sources)

    expect(await readRecentBoards(project)).toEqual([
      "Board 7",
      "Shared Board",
      "Board 6",
      "Board 5",
      "Board 4",
      "Board 3",
    ])
  })

  it("reads only the card map of the project folder, not a file of that name in .llm-wiki", async () => {
    await writeFileRaw(`${project}/raw/sources/heptabase/card-1.md`, snapshot(["Board One"]))
    await writeMap({ "card-1": { raw_path: "raw/sources/heptabase/card-1.md", card_updated_at: "2026-02-01T10:00:00.000Z" } }, ".llm-wiki/heptabase-map.json")

    expect(await readRecentBoards(project)).toEqual([])
  })

  it("skips a missing snapshot, a snapshot without boards, and a path outside the project", async () => {
    await writeFileRaw(`${project}/raw/sources/heptabase/good.md`, snapshot(["Board One"]))
    await writeFileRaw(`${project}/raw/sources/heptabase/plain.md`, "---\ntitle: Card\n---\n\nNo boards.\n")
    await writeFileRaw(`${tmp.path}/outside-boards.md`, snapshot(["Outside Board"]))
    await writeMap({
      a: { raw_path: "raw/sources/heptabase/missing.md", card_updated_at: "2026-02-09T10:00:00.000Z" },
      b: { raw_path: "raw/sources/heptabase/plain.md", card_updated_at: "2026-02-08T10:00:00.000Z" },
      c: { raw_path: "../outside-boards.md", card_updated_at: "2026-02-07T10:00:00.000Z" },
      d: { raw_path: "/etc/hostname", card_updated_at: "2026-02-06T10:00:00.000Z" },
      e: { raw_path: "raw/sources/heptabase/good.md", card_updated_at: "2026-02-05T10:00:00.000Z" },
    })

    expect(await readRecentBoards(project)).toEqual(["Board One"])
  })

  it("is empty for a map that is not valid JSON, and for a map of the wrong shape", async () => {
    await writeFileRaw(`${project}/heptabase-map.json`, "{ not json")
    expect(await readRecentBoards(project)).toEqual([])
    await writeFileRaw(`${project}/heptabase-map.json`, JSON.stringify({ version: 1, sources: [1, 2] }))
    expect(await readRecentBoards(project)).toEqual([])
    await writeFileRaw(`${project}/heptabase-map.json`, JSON.stringify({ version: 1, sources: { a: { raw_path: 7 } } }))
    expect(await readRecentBoards(project)).toEqual([])
  })
})

// --- readDismissedPairs -------------------------------------------------

describe("readDismissedPairs", () => {
  let tmp: { path: string; cleanup: () => Promise<void> }

  beforeEach(async () => {
    tmp = await createTempProject("fusion-dismissed-read")
  })

  afterEach(async () => {
    await tmp.cleanup()
  })

  it("reads the pairs and ignores entries that are not pairs", async () => {
    await writeFileRaw(
      `${tmp.path}/${FUSION_DISMISSED_FILE}`,
      JSON.stringify([
        { mechanism: PAGE_PATH, targetDomain: "example/gamma" },
        { mechanism: PAGE_PATH },
        "text",
        null,
        { mechanism: 3, targetDomain: "example/delta" },
      ]),
    )

    expect(await readDismissedPairs(tmp.path)).toEqual([{ mechanism: PAGE_PATH, targetDomain: "example/gamma" }])
  })

  it("is empty for a missing file and for a file that is not a JSON array", async () => {
    expect(await readDismissedPairs(tmp.path)).toEqual([])
    await writeFileRaw(`${tmp.path}/${FUSION_DISMISSED_FILE}`, "{ nope")
    expect(await readDismissedPairs(tmp.path)).toEqual([])
    await writeFileRaw(`${tmp.path}/${FUSION_DISMISSED_FILE}`, JSON.stringify({ mechanism: PAGE_PATH }))
    expect(await readDismissedPairs(tmp.path)).toEqual([])
  })
})

// --- proposeFusionCandidates -------------------------------------------

describe("proposeFusionCandidates", () => {
  let tmp: { path: string; cleanup: () => Promise<void> }
  let project: string

  const DOMAINS = [
    "version: 1",
    "domains:",
    ...Object.entries(DOMAIN_LENSES).flatMap(([name, lens]) => [
      `  ${name}:`,
      `    lens: ${lens}`,
      `    description: About ${name}`,
      "    whiteboards: []",
    ]),
    "",
  ].join("\n")

  async function setUp(wikiYaml = "version: 1\nid: reading\nrole: reading\nmechanism_library: null\n"): Promise<MechanismContext> {
    await writeFileRaw(`${project}/domains.yaml`, DOMAINS)
    await writeFileRaw(`${project}/wiki.yaml`, wikiYaml)
    await writeFileRaw(`${project}/${PAGE_PATH}`, PAGE)
    const ctx = await loadMechanismContext(project)
    if (ctx === null) throw new Error("the test project is not a mechanism wiki")
    return ctx
  }

  function propose(ctx: MechanismContext, options?: Parameters<typeof proposeFusionCandidates>[4]): Promise<number> {
    return proposeFusionCandidates(project, ctx, PAGE_PATH, { ...useWikiStore.getState().llmConfig }, options)
  }

  beforeEach(async () => {
    tmp = await createTempProject("fusion-propose")
    project = tmp.path
    model.answer = ""
    model.hang = false
    model.calls.length = 0
    useReviewStore.setState({ items: [] })
    vi.spyOn(console, "warn").mockImplementation(() => {})
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    await tmp.cleanup()
  })

  it("adds one review item that lists the candidates", async () => {
    const ctx = await setUp()
    model.answer = [
      line("example/gamma", "structural", "Same trigger and same reaction."),
      line("example/delta", "surface", "Both wait for a request."),
    ].join("\n")

    const added = await propose(ctx)

    expect(added).toBe(1)
    const items = useReviewStore.getState().items
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({
      type: "fusion-candidate",
      title: "Fusion candidates: Example loop (example-loop)",
      description: [
        "Domains where Example loop may also work:",
        "CANDIDATE: example/gamma | structural | Same trigger and same reaction.",
        "CANDIDATE: example/delta | surface | Both wait for a request.",
      ].join("\n"),
      affectedPages: [PAGE_PATH],
      options: [
        { label: "Start fusion", action: "mech:start-fusion" },
        { label: "Skip", action: "mech:dismiss-fusion" },
      ],
      resolved: false,
    })
    // The model is asked once, and the page and the domains are in the prompt.
    expect(model.calls).toHaveLength(1)
    expect(model.calls[0].system).toContain("A part acts only when a signal reaches it.")
    expect(model.calls[0].system).toContain("- example/gamma (lens: physics)")
  })

  it("uses the slug when the page has no title", async () => {
    const ctx = await setUp()
    await writeFileRaw(`${project}/${PAGE_PATH}`, PAGE.replace('title: "Example loop"\n', ""))
    model.answer = line("example/gamma", "structural", "Same trigger.")

    await propose(ctx)

    // The slug is the title now: it is not written twice.
    expect(useReviewStore.getState().items[0].title).toBe("Fusion candidates: example-loop")
    expect(useReviewStore.getState().items[0].description.split("\n")[0]).toBe("Domains where example-loop may also work:")
  })

  it("gives two mechanisms with the same title two items", async () => {
    const ctx = await setUp()
    await writeFileRaw(`${project}/wiki/mechanisms/other-loop.md`, PAGE)
    model.answer = line("example/gamma", "structural", "Same trigger.")

    expect(await propose(ctx)).toBe(1)
    expect(await proposeFusionCandidates(project, ctx, "wiki/mechanisms/other-loop.md", { ...useWikiStore.getState().llmConfig })).toBe(1)

    expect(useReviewStore.getState().items.map((item) => item.title)).toEqual([
      "Fusion candidates: Example loop (example-loop)",
      "Fusion candidates: Example loop (other-loop)",
    ])
  })

  it("adds the item and leaves the file alone when .llm-wiki/fusion-dismissed.json is corrupt", async () => {
    const ctx = await setUp()
    await writeFileRaw(`${project}/${FUSION_DISMISSED_FILE}`, "{ this is not json")
    model.answer = line("example/gamma", "structural", "Same trigger.")

    expect(await propose(ctx)).toBe(1)

    expect(useReviewStore.getState().items).toHaveLength(1)
    expect(await readFileRaw(`${project}/${FUSION_DISMISSED_FILE}`)).toBe("{ this is not json")
  })

  it("no review when no candidates", async () => {
    const ctx = await setUp()
    model.answer = "NONE"

    expect(await propose(ctx)).toBe(0)

    expect(model.calls).toHaveLength(1)
    expect(useReviewStore.getState().items).toEqual([])
  })

  it("adds no review when every line is dropped", async () => {
    const ctx = await setUp()
    // The two instance domains and an unknown domain: all dropped.
    model.answer = [
      line("example/alpha", "structural", "Has an instance."),
      line("example/beta", "structural", "Has an instance."),
      line("example/nowhere", "structural", "Unknown."),
    ].join("\n")

    expect(await propose(ctx)).toBe(0)
    expect(useReviewStore.getState().items).toEqual([])
  })

  it("skips the domain of the source of this ingest", async () => {
    const ctx = await setUp()
    model.answer = [line("example/gamma", "structural", "Where the source is."), line("example/delta", "surface", "Free.")].join("\n")

    await propose(ctx, { sourceDomain: "example/gamma" })

    expect(useReviewStore.getState().items[0].description).not.toContain("example/gamma")
    expect(useReviewStore.getState().items[0].description).toContain("example/delta")
    expect(lineWith(model.calls[0].system, /already has an instance/i)).toContain("example/gamma")
  })

  it("does not propose a dismissed pair, and tells the model about it", async () => {
    const ctx = await setUp()
    await writeFileRaw(
      `${project}/${FUSION_DISMISSED_FILE}`,
      JSON.stringify([
        { mechanism: PAGE_PATH, targetDomain: "example/gamma" },
        { mechanism: "wiki/mechanisms/other.md", targetDomain: "example/delta" },
      ]),
    )
    model.answer = [
      line("example/gamma", "structural", "Dismissed for this mechanism."),
      line("example/delta", "surface", "Dismissed only for another mechanism."),
    ].join("\n")

    await propose(ctx)

    const description = useReviewStore.getState().items[0].description
    expect(description).not.toContain("example/gamma")
    expect(description).toContain("example/delta")
    const dismissedLine = lineWith(model.calls[0].system, /dismissed/i)
    expect(dismissedLine).toContain("example/gamma")
    expect(dismissedLine).not.toContain("example/delta")
  })

  it("puts the recent boards of the card map into the prompt", async () => {
    const ctx = await setUp()
    await writeFileRaw(
      `${project}/raw/sources/heptabase/card-1.md`,
      '---\ntitle: "Card"\nheptabase_whiteboards: ["Board One"]\n---\n\nBody.\n',
    )
    await writeFileRaw(
      `${project}/heptabase-map.json`,
      JSON.stringify({
        version: 1,
        pages: {},
        sources: { "card-1": { raw_path: "raw/sources/heptabase/card-1.md", card_updated_at: "2026-02-01T10:00:00.000Z", ingest_commit: null } },
        whiteboards_cache: { updated_at: "", items: [] },
      }),
    )
    model.answer = "NONE"

    await propose(ctx)

    expect(model.calls[0].system).toContain("- Board One")
  })

  it("does not ask the model when every domain is excluded", async () => {
    const ctx = await setUp()
    await writeFileRaw(
      `${project}/${FUSION_DISMISSED_FILE}`,
      JSON.stringify(["example/gamma", "example/delta", "example/epsilon"].map((targetDomain) => ({ mechanism: PAGE_PATH, targetDomain }))),
    )

    expect(await propose(ctx)).toBe(0)
    expect(model.calls).toEqual([])
  })

  it("does nothing in a wiki that cannot write mechanism pages", async () => {
    const ctx = await setUp("version: 1\nid: work\nrole: work\nmechanism_library: ../reading\n")
    model.answer = line("example/gamma", "structural", "Same trigger.")

    expect(await propose(ctx)).toBe(0)
    expect(model.calls).toEqual([])
    expect(useReviewStore.getState().items).toEqual([])
  })

  it("throws when the model call fails, and adds nothing", async () => {
    const ctx = await setUp()
    model.answer = new Error("provider down")

    await expect(propose(ctx)).rejects.toThrow("provider down")
    expect(useReviewStore.getState().items).toEqual([])
  })

  it("stops waiting for a model that never answers when the signal aborts, and adds nothing", async () => {
    const ctx = await setUp()
    model.hang = true
    const controller = new AbortController()

    const result = propose(ctx, { signal: controller.signal })
    // Let the call start, then cut it off.
    await vi.waitFor(() => expect(model.calls).toHaveLength(1))
    controller.abort(new Error("timed out"))

    await expect(result).rejects.toThrow("timed out")
    expect(useReviewStore.getState().items).toEqual([])
  })

  it("does not ask the model when the signal is aborted already", async () => {
    const ctx = await setUp()
    model.answer = line("example/gamma", "structural", "Same trigger.")
    const controller = new AbortController()
    controller.abort()

    expect(await propose(ctx, { signal: controller.signal })).toBe(0)
    expect(model.calls).toEqual([])
  })

  it("throws when the page cannot be read", async () => {
    const ctx = await setUp()

    await expect(
      proposeFusionCandidates(project, ctx, "wiki/mechanisms/missing.md", { ...useWikiStore.getState().llmConfig }),
    ).rejects.toThrow()
    expect(model.calls).toEqual([])
  })

  it("does not write any file", async () => {
    const ctx = await setUp()
    model.answer = line("example/gamma", "structural", "Same trigger.")

    await propose(ctx)

    expect(await fileExists(`${project}/${FUSION_DISMISSED_FILE}`)).toBe(false)
    expect(await readFileRaw(`${project}/${PAGE_PATH}`)).toBe(PAGE)
  })

  it("adds nothing new when the same mechanism already has its item", async () => {
    const ctx = await setUp()
    model.answer = line("example/gamma", "structural", "Same trigger.")

    expect(await propose(ctx)).toBe(1)
    expect(await propose(ctx)).toBe(0)
    expect(useReviewStore.getState().items).toHaveLength(1)
  })
})
