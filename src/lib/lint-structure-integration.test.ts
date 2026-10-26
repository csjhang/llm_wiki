/**
 * Layer 1 of the domain lint, run inside the app.
 *
 * `runMechanismStructuralLint` scans the files of a project and runs `checkStructure`. The lint view
 * shows the findings as items of type "structure", and the ingest queue refreshes them in the background
 * when it drains. These tests use a real temporary folder for the project; the ingest itself is a fake.
 * The queue tests wait for the background step with `pendingStructuralLints()`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createDeferred, flushIO, waitFor } from "@/test-helpers/deferred"
import { createTempProject, realFs, writeFileRaw } from "@/test-helpers/fs-temp"
import { useWikiStore } from "@/stores/wiki-store"
import { useLintStore } from "@/stores/lint-store"
import type { LintItem } from "@/stores/lint-store"

vi.mock("@/commands/fs", () => realFs)

// The ingest is a fake: the tests decide when it ends and what it reports.
vi.mock("./ingest", () => ({ autoIngest: vi.fn() }))
vi.mock("./sweep-reviews", () => ({ sweepResolvedReviews: vi.fn().mockResolvedValue(0) }))

const TEST_ID = "structure-test-project"
const pathById: { map: Record<string, string> } = { map: {} }
vi.mock("@/lib/project-identity", () => ({
  ensureProjectId: vi.fn(),
  upsertProjectInfo: vi.fn(),
  getProjectPathById: vi.fn(async (id: string) => pathById.map[id] ?? null),
  getProjectIdByPath: vi.fn(),
  loadRegistry: vi.fn(),
}))

// Version history is a fake too, so a test can see when the ingest commit happens.
vi.mock("@/lib/git-history", async () => {
  const { titleFromSourcePath } = await import("./commit-message")
  return {
    resolveGitHistory: vi.fn(),
    getCachedGitHistory: vi.fn(),
    isGitHistoryOnCached: vi.fn(),
    prepareIngestBaseline: vi.fn(),
    trackIngestPath: vi.fn(),
    commitIngest: vi.fn(),
    restoreFailedIngest: vi.fn(),
    recoverInterruptedIngest: vi.fn(),
    titleFromSourcePath,
  }
})

// The real lint run, wrapped in a spy so a test can see the calls and replace one answer.
vi.mock("@/lib/mechanism-wiki/lint-run", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/mechanism-wiki/lint-run")>()
  return { ...actual, runMechanismStructuralLint: vi.fn(actual.runMechanismStructuralLint) }
})

import { autoIngest } from "./ingest"
import { commitIngest, getCachedGitHistory, isGitHistoryOnCached, prepareIngestBaseline, resolveGitHistory } from "@/lib/git-history"
import { runStructuralLint, structureFindingToLintResult } from "./lint"
import type { LintResult } from "./lint"
import { runMechanismStructuralLint } from "@/lib/mechanism-wiki/lint-run"
import type { StructureFinding } from "@/lib/mechanism-wiki/lint-structure"
import { loadLintItems, saveLintItems } from "./persist"
import {
  clearQueueState,
  enqueueBatch,
  enqueueIngest,
  getQueue,
  pauseQueue,
  pendingStructuralLints,
  restoreQueue,
} from "./ingest-queue"

const mockAutoIngest = vi.mocked(autoIngest)
const mockLintRun = vi.mocked(runMechanismStructuralLint)
const mockCommitIngest = vi.mocked(commitIngest)

const ALPHA = "example/alpha"
const BETA = "example/beta"
const CARD_1 = "00000000-0000-4000-8000-000000000001"
const CARD_2 = "00000000-0000-4000-8000-000000000002"

let tmp: { path: string; cleanup: () => Promise<void> }
let project: string

/** The queue saves its state to a real file, so a step takes more ticks than with a fake file system. */
const MAX_TICKS = 5_000
const waitUntil = (predicate: () => boolean): Promise<void> => waitFor(predicate, MAX_TICKS)

function domainsYaml(...names: string[]): string {
  return [
    "version: 1",
    "domains:",
    ...names.flatMap((name) => [`  ${name}:`, "    lens: ai", `    description: The ${name} domain`, "    whiteboards: []"]),
    "",
  ].join("\n")
}

function wikiYaml(options: { role?: "reading" | "work"; library?: string | null; lint?: string[] } = {}): string {
  const role = options.role ?? "reading"
  return [
    "version: 1",
    `id: ${role}`,
    `role: ${role}`,
    `mechanism_library: ${options.library ?? "null"}`,
    ...(options.lint === undefined ? [] : ["lint:", ...options.lint.map((line) => `  ${line}`)]),
    "",
  ].join("\n")
}

function pageText(fields: Record<string, string | undefined>, body = "# Page\n"): string {
  const lines = Object.entries(fields)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key}: ${JSON.stringify(value)}`)
  return `---\n${lines.join("\n")}\n---\n${body}`
}

/** A reading wiki: two domains, one page without a domain, one page with an unknown domain. */
async function makeReadingWiki(root: string, lint?: string[]): Promise<void> {
  await writeFileRaw(`${root}/domains.yaml`, domainsYaml(ALPHA, BETA))
  await writeFileRaw(`${root}/wiki.yaml`, wikiYaml({ lint }))
  await writeFileRaw(`${root}/wiki/concepts/loose.md`, pageText({ type: "concept", title: "Loose" }))
  await writeFileRaw(`${root}/wiki/concepts/wrong.md`, pageText({ type: "concept", title: "Wrong", domain: "example/missing" }))
  await writeFileRaw(`${root}/wiki/concepts/fine.md`, pageText({ type: "concept", title: "Fine", domain: ALPHA }))
}

/** A project that is not a mechanism wiki: no `domains.yaml`. */
async function makePlainWiki(root: string): Promise<void> {
  await writeFileRaw(`${root}/wiki/concepts/a.md`, "# A\n\nText.\n")
  await writeFileRaw(`${root}/wiki/concepts/b.md`, "# B\n\nText.\n")
}

function only(check: string, findings: StructureFinding[]): StructureFinding[] {
  return findings.filter((finding) => finding.check === check)
}

function structureItems(): LintItem[] {
  return useLintStore.getState().items.filter((item) => item.type === "structure")
}

beforeEach(async () => {
  tmp = await createTempProject("structure-lint")
  project = `${tmp.path}/project`
  mockLintRun.mockReset()
})

afterEach(async () => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  await tmp.cleanup()
})

describe("runMechanismStructuralLint", () => {
  it("returns nothing for a project that is not a mechanism wiki", async () => {
    await makePlainWiki(project)

    expect(await runMechanismStructuralLint(project)).toEqual([])
  })

  it("returns nothing for a folder that does not exist", async () => {
    expect(await runMechanismStructuralLint(`${tmp.path}/missing`)).toEqual([])
  })

  it("scans the pages of a reading wiki and returns the findings of checkStructure", async () => {
    await makeReadingWiki(project)

    const findings = await runMechanismStructuralLint(project)

    expect(only("domain-missing", findings)).toEqual([
      expect.objectContaining({ page: "wiki/concepts/loose.md" }),
    ])
    expect(only("domain-unknown", findings)).toEqual([
      expect.objectContaining({ page: "wiki/concepts/wrong.md", domains: ["example/missing"] }),
    ])
    // The domain beta has no page, and alpha has one: both are below the default minimum of three.
    expect(only("domain-too-small", findings).map((finding) => finding.domains)).toEqual([[ALPHA], [BETA]])
  })

  it("takes the thresholds from wiki.yaml", async () => {
    await makeReadingWiki(project, ["min_domain_pages: 1"])

    const findings = await runMechanismStructuralLint(project)

    expect(only("domain-too-small", findings).map((finding) => finding.domains)).toEqual([[BETA]])
  })

  it("leaves out the index files of the app", async () => {
    await makeReadingWiki(project)
    await writeFileRaw(`${project}/wiki/index.md`, "# Wiki Index\n")
    await writeFileRaw(`${project}/wiki/indexes/example--alpha.md`, "# example/alpha\n")

    const findings = await runMechanismStructuralLint(project)

    expect(findings.map((finding) => finding.page)).not.toContain("wiki/index.md")
    expect(findings.map((finding) => finding.page)).not.toContain("wiki/indexes/example--alpha.md")
  })

  describe("the card map", () => {
    const writeMap = (pages: unknown): Promise<void> =>
      writeFileRaw(`${project}/heptabase-map.json`, JSON.stringify({ version: 1, pages, sources: {}, whiteboards_cache: { updated_at: "", items: [] } }))

    it("reports a retired card and an active card whose page is gone", async () => {
      await makeReadingWiki(project)
      await writeMap({
        "wiki/concepts/fine.md": { status: "retired", card_id: CARD_1, content_hash: "x" },
        "wiki/concepts/gone.md": { status: "active", card_id: CARD_2, content_hash: "y" },
      })

      const findings = await runMechanismStructuralLint(project)

      expect(only("mirror-retired", findings)).toEqual([expect.objectContaining({ page: "wiki/concepts/fine.md" })])
      expect(only("mirror-retired", findings)[0].message).toContain(CARD_1)
      expect(only("map-missing-page", findings)).toEqual([expect.objectContaining({ page: "wiki/concepts/gone.md" })])
    })

    it.each([
      ["missing", undefined],
      ["not JSON", "{ not json"],
      ["not an object", "[]"],
      ["without pages", JSON.stringify({ version: 1 })],
      ["of another version", JSON.stringify({ version: 2, pages: { "wiki/gone.md": { status: "active", card_id: CARD_1 } } })],
    ])("treats a card map that is %s as no card map", async (_name, text) => {
      await makeReadingWiki(project)
      if (text !== undefined) await writeFileRaw(`${project}/heptabase-map.json`, text)

      const findings = await runMechanismStructuralLint(project)

      expect(only("mirror-retired", findings)).toEqual([])
      expect(only("map-missing-page", findings)).toEqual([])
      expect(only("domain-missing", findings)).toHaveLength(1)
    })

    it("skips an entry that has no status or card id", async () => {
      await makeReadingWiki(project)
      await writeMap({
        "wiki/concepts/a.md": { card_id: CARD_1 },
        "wiki/concepts/b.md": { status: "active" },
        "wiki/concepts/c.md": "text",
        "wiki/concepts/d.md": { status: "active", card_id: CARD_2 },
      })

      const findings = await runMechanismStructuralLint(project)

      expect(only("map-missing-page", findings).map((finding) => finding.page)).toEqual(["wiki/concepts/d.md"])
    })
  })

  describe("today", () => {
    const draft = (updated: string): string =>
      pageText({ type: "hypothesis", title: "Draft", status: "draft", from_domain: ALPHA, to_domain: BETA, updated })

    it("is the local date, so a draft older than draft_days is stale", async () => {
      await makeReadingWiki(project)
      await writeFileRaw(`${project}/wiki/hypotheses/h.md`, draft("2026-09-01"))
      vi.useFakeTimers({ toFake: ["Date"] })
      vi.setSystemTime(new Date(2026, 9, 26, 12, 0, 0)) // 26 October 2026, local time

      const findings = await runMechanismStructuralLint(project)

      expect(only("hypothesis-stale-draft", findings)).toEqual([expect.objectContaining({ page: "wiki/hypotheses/h.md" })])
      expect(only("hypothesis-stale-draft", findings)[0].message).toContain("55 days")
    })

    it("does not flag a draft that is younger than draft_days", async () => {
      await makeReadingWiki(project)
      await writeFileRaw(`${project}/wiki/hypotheses/h.md`, draft("2026-09-01"))
      vi.useFakeTimers({ toFake: ["Date"] })
      vi.setSystemTime(new Date(2026, 9, 1, 0, 30, 0)) // just after local midnight

      expect(only("hypothesis-stale-draft", await runMechanismStructuralLint(project))).toEqual([])
    })
  })

  describe("a work wiki", () => {
    async function makeWorkWiki(): Promise<{ work: string }> {
      const library = `${tmp.path}/reading`
      const work = `${tmp.path}/work`
      await writeFileRaw(`${library}/domains.yaml`, domainsYaml("example/library-only", "example/shared"))
      await writeFileRaw(`${library}/wiki.yaml`, wikiYaml())
      await writeFileRaw(`${work}/domains.yaml`, domainsYaml("example/work"))
      await writeFileRaw(`${work}/wiki.yaml`, wikiYaml({ role: "work", library: "../reading" }))
      await writeFileRaw(
        `${work}/wiki/hypotheses/from-library.md`,
        pageText({ type: "hypothesis", title: "H", status: "testing", from_domain: "example/library-only", to_domain: "example/work" }),
      )
      await writeFileRaw(
        `${work}/wiki/hypotheses/bad.md`,
        pageText({ type: "hypothesis", title: "Bad", status: "testing", from_domain: "example/nowhere", to_domain: "example/work" }),
      )
      await writeFileRaw(`${work}/wiki/concepts/plain.md`, pageText({ type: "concept", title: "Plain", domain: "example/library-only" }))
      return { work }
    }

    it("knows the library domains as the from_domain of a hypothesis, and nowhere else", async () => {
      const { work } = await makeWorkWiki()

      const unknown = only("domain-unknown", await runMechanismStructuralLint(work))

      expect(unknown.map((finding) => [finding.page, finding.domains])).toEqual([
        ["wiki/concepts/plain.md", ["example/library-only"]],
        ["wiki/hypotheses/bad.md", ["example/nowhere"]],
      ])
    })

    it("still works when the library cannot be found", async () => {
      const { work } = await makeWorkWiki()
      await writeFileRaw(`${work}/wiki.yaml`, wikiYaml({ role: "work", library: "../no-such-wiki" }))

      const unknown = only("domain-unknown", await runMechanismStructuralLint(work))

      expect(unknown.map((finding) => finding.page)).toEqual([
        "wiki/concepts/plain.md",
        "wiki/hypotheses/bad.md",
        "wiki/hypotheses/from-library.md",
      ])
    })
  })

  it("stops with an AbortError when the signal is aborted", async () => {
    await makeReadingWiki(project)
    const controller = new AbortController()
    controller.abort()

    await expect(runMechanismStructuralLint(project, { signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" })
  })
})

describe("structureFindingToLintResult", () => {
  const finding = (check: string, page: string | null): StructureFinding => ({ check, page, message: `Message of ${check}.`, domains: [ALPHA] })

  it.each([
    ["domain-unknown", "warning"],
    ["map-missing-page", "warning"],
    ["concept-cross-domain", "warning"],
    ["domain-missing", "info"],
    ["mechanism-no-instance", "info"],
    ["mirror-retired", "info"],
    ["hypothesis-stale-draft", "info"],
    ["domain-too-large", "info"],
    ["domain-too-small", "info"],
  ])("gives %s the severity %s", (check, severity) => {
    expect(structureFindingToLintResult(finding(check, "wiki/concepts/a.md"))).toEqual({
      type: "structure",
      severity,
      page: "wiki/concepts/a.md",
      detail: `Message of ${check}.`,
      check,
    })
  })

  it("uses an empty page for a finding about a domain", () => {
    expect(structureFindingToLintResult(finding("domain-too-small", null)).page).toBe("")
  })
})

describe("runStructuralLint in the lint view", () => {
  it("lint result includes structure findings in a mechanism wiki", async () => {
    await makeReadingWiki(project)

    const results = await runStructuralLint(project)

    const structure = results.filter((result) => result.type === "structure")
    expect(structure).toContainEqual(
      expect.objectContaining({ type: "structure", severity: "info", check: "domain-missing", page: "wiki/concepts/loose.md" }),
    )
    expect(structure).toContainEqual(
      expect.objectContaining({ type: "structure", severity: "warning", check: "domain-unknown", page: "wiki/concepts/wrong.md" }),
    )
    // The checks of the app are still there.
    expect(results).toContainEqual(expect.objectContaining({ type: "orphan", page: "concepts/loose.md" }))
    expect(results).toContainEqual(expect.objectContaining({ type: "no-outlinks", page: "concepts/loose.md" }))
  })

  it("non-mechanism project unchanged", async () => {
    await makePlainWiki(project)

    const results = await runStructuralLint(project)

    expect(results.map((result) => `${result.type}:${result.page}`).sort()).toEqual([
      "no-outlinks:concepts/a.md",
      "no-outlinks:concepts/b.md",
      "orphan:concepts/a.md",
      "orphan:concepts/b.md",
    ])
    expect(results.every((result) => result.check === undefined)).toBe(true)
  })

  it("a failure of the structure checks does not take away the other results", async () => {
    await makeReadingWiki(project)
    vi.spyOn(console, "warn").mockImplementation(() => {})
    mockLintRun.mockRejectedValueOnce(new Error("scan failed"))

    const results = await runStructuralLint(project)

    expect(results.some((result) => result.type === "structure")).toBe(false)
    expect(results.some((result) => result.type === "orphan")).toBe(true)
  })

  it("passes the signal of the lint run on to the structure checks", async () => {
    await makeReadingWiki(project)
    const controller = new AbortController()

    await runStructuralLint(project, { signal: controller.signal })

    expect(mockLintRun).toHaveBeenCalledWith(project, { signal: controller.signal })
  })

  it("lets a cancel of the structure checks cancel the lint run", async () => {
    await makeReadingWiki(project)
    mockLintRun.mockRejectedValueOnce(new DOMException("cancelled", "AbortError"))

    await expect(runStructuralLint(project)).rejects.toMatchObject({ name: "AbortError" })
  })
})

describe("the lint store and lint.json", () => {
  const result: LintResult = {
    type: "structure",
    severity: "warning",
    page: "wiki/concepts/wrong.md",
    detail: "Unknown domain.",
    check: "domain-unknown",
  }

  beforeEach(() => {
    useLintStore.setState({ items: [] })
  })

  it("keeps the check id of a result", () => {
    useLintStore.getState().addItems([result])

    expect(useLintStore.getState().items[0]).toMatchObject({ type: "structure", check: "domain-unknown" })
  })

  it("keeps the check id in lint.json", async () => {
    await makeReadingWiki(project)
    useLintStore.getState().addItems([result])

    await saveLintItems(project, useLintStore.getState().items)
    const loaded = await loadLintItems(project)

    expect(loaded).toHaveLength(1)
    expect(loaded[0]).toMatchObject({ type: "structure", check: "domain-unknown", page: "wiki/concepts/wrong.md" })
  })

  it("replaces the items of one type and keeps every other item", () => {
    useLintStore.getState().addItems([
      { ...result, page: "wiki/old-1.md" },
      { type: "orphan", severity: "info", page: "concepts/o.md", detail: "No other pages link to this page." },
      { ...result, page: "wiki/old-2.md" },
    ])

    useLintStore.getState().replaceItemsOfType("structure", [{ ...result, page: "wiki/new.md" }])

    expect(useLintStore.getState().items.map((item) => [item.type, item.page])).toEqual([
      ["orphan", "concepts/o.md"],
      ["structure", "wiki/new.md"],
    ])
  })

  it("replaces them with nothing when the new list is empty", () => {
    useLintStore.getState().addItems([result, { ...result, page: "wiki/other.md" }])

    useLintStore.getState().replaceItemsOfType("structure", [])

    expect(useLintStore.getState().items).toEqual([])
  })

  it("does not touch the store when there is nothing to remove or add", () => {
    useLintStore.getState().addItems([{ type: "orphan", severity: "info", page: "a.md", detail: "d" }])
    const before = useLintStore.getState().items

    useLintStore.getState().replaceItemsOfType("structure", [])

    expect(useLintStore.getState().items).toBe(before)
  })
})

describe("after an ingest", () => {
  const finding = (check: string, page: string | null): StructureFinding => ({ check, page, message: `Message of ${check}.` })

  /** Wait for the call to the lint, and then for the background step to end. */
  async function lintSettled(calls = 1): Promise<void> {
    await waitUntil(() => mockLintRun.mock.calls.length >= calls)
    await Promise.all(pendingStructuralLints())
  }

  /** Wait until the queue has no task left. */
  const queueEmpty = (): Promise<void> => waitUntil(() => getQueue().length === 0)

  beforeEach(async () => {
    clearQueueState()
    useLintStore.setState({ items: [] })
    mockAutoIngest.mockReset()
    mockAutoIngest.mockResolvedValue(["wiki/concepts/loose.md"])
    mockLintRun.mockReset()
    vi.mocked(resolveGitHistory).mockResolvedValue(false)
    vi.mocked(getCachedGitHistory).mockReturnValue(false)
    vi.mocked(isGitHistoryOnCached).mockReturnValue(false)
    vi.mocked(prepareIngestBaseline).mockResolvedValue(true)
    mockCommitIngest.mockReset()
    mockCommitIngest.mockResolvedValue("a".repeat(40))
    useWikiStore.getState().setLlmConfig({
      provider: "openai",
      apiKey: "k",
      model: "m",
      ollamaUrl: "",
      customEndpoint: "",
      maxContextSize: 128000,
    })
    await makeReadingWiki(project)
    pathById.map = { [TEST_ID]: project }
    await restoreQueue(TEST_ID, project)
  })

  afterEach(async () => {
    clearQueueState()
    await flushIO()
  })

  it("runs after a successful ingest and stores the findings as items of type structure", async () => {
    await enqueueIngest(TEST_ID, "raw/sources/a.md")
    await lintSettled()

    expect(mockLintRun).toHaveBeenCalledWith(project, expect.objectContaining({ signal: expect.any(AbortSignal) }))
    const items = structureItems()
    expect(items).toContainEqual(expect.objectContaining({ check: "domain-missing", page: "wiki/concepts/loose.md", severity: "info" }))
    expect(items).toContainEqual(expect.objectContaining({ check: "domain-unknown", page: "wiki/concepts/wrong.md", severity: "warning" }))
    expect(getQueue()).toEqual([])
  })

  it("runs after the ingest commit", async () => {
    const order: string[] = []
    vi.mocked(getCachedGitHistory).mockReturnValue(true)
    mockCommitIngest.mockImplementation(async () => {
      order.push("commit")
      return "a".repeat(40)
    })
    mockLintRun.mockImplementationOnce(async () => {
      order.push("lint")
      return []
    })

    await enqueueIngest(TEST_ID, "raw/sources/a.md")
    await lintSettled()

    expect(order).toEqual(["commit", "lint"])
  })

  it("runs once when the queue drains, not once for each source", async () => {
    await enqueueBatch(TEST_ID, [
      { sourcePath: "raw/sources/a.md", folderContext: "" },
      { sourcePath: "raw/sources/b.md", folderContext: "" },
      { sourcePath: "raw/sources/c.md", folderContext: "" },
    ])
    await lintSettled()
    await queueEmpty()
    await flushIO()

    expect(mockAutoIngest).toHaveBeenCalledTimes(3)
    expect(mockLintRun).toHaveBeenCalledTimes(1)
  })

  it("does not run when the ingest fails", async () => {
    mockAutoIngest.mockRejectedValue(new Error("model failed"))
    vi.spyOn(console, "log").mockImplementation(() => {})

    await enqueueIngest(TEST_ID, "raw/sources/a.md")
    // The queue tries a failing task three times.
    await waitUntil(() => mockAutoIngest.mock.calls.length >= 3)
    await flushIO(5)

    expect(mockLintRun).not.toHaveBeenCalled()
  })

  it("replaces the old items of type structure and keeps every other item", async () => {
    useLintStore.getState().addItems([
      { type: "structure", severity: "info", page: "wiki/old.md", detail: "Old.", check: "domain-missing" },
      { type: "orphan", severity: "info", page: "concepts/o.md", detail: "No other pages link to this page." },
      { type: "semantic", severity: "warning", page: "Title", detail: "[suggestion] Add a page." },
    ])
    const kept = useLintStore.getState().items.filter((item) => item.type !== "structure")
    mockLintRun.mockResolvedValueOnce([finding("domain-unknown", "wiki/concepts/wrong.md")])

    await enqueueIngest(TEST_ID, "raw/sources/a.md")
    await lintSettled()

    const items = useLintStore.getState().items
    expect(items.filter((item) => item.type !== "structure")).toEqual(kept)
    expect(structureItems().map((item) => [item.check, item.page])).toEqual([["domain-unknown", "wiki/concepts/wrong.md"]])
  })

  it("clears the old items of type structure when the wiki is clean", async () => {
    useLintStore.getState().addItems([{ type: "structure", severity: "info", page: "wiki/old.md", detail: "Old.", check: "domain-missing" }])
    mockLintRun.mockResolvedValueOnce([])

    await enqueueIngest(TEST_ID, "raw/sources/a.md")
    await lintSettled()

    expect(structureItems()).toEqual([])
  })

  it("leaves the lint store alone in a project that is not a mechanism wiki", async () => {
    const plain = `${tmp.path}/plain`
    await makePlainWiki(plain)
    pathById.map = { [TEST_ID]: plain }
    await restoreQueue(TEST_ID, plain)
    useLintStore.getState().addItems([{ type: "orphan", severity: "info", page: "concepts/o.md", detail: "d" }])
    const before = useLintStore.getState().items

    await enqueueIngest(TEST_ID, "raw/sources/a.md")
    await lintSettled()

    expect(useLintStore.getState().items).toBe(before)
  })

  describe("lint failure never fails the ingest", () => {
    it("when the lint rejects", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
      mockLintRun.mockRejectedValueOnce(new Error("scan failed"))

      await enqueueIngest(TEST_ID, "raw/sources/a.md")
      await lintSettled()

      expect(getQueue()).toEqual([])
      expect(structureItems()).toEqual([])
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("Structural lint"), expect.anything())
    })

    it("when the lint throws before it returns a promise", async () => {
      vi.spyOn(console, "warn").mockImplementation(() => {})
      mockLintRun.mockImplementationOnce(() => {
        throw new Error("sync failure")
      })

      await enqueueIngest(TEST_ID, "raw/sources/a.md")
      await lintSettled()

      expect(getQueue()).toEqual([])
      expect(mockAutoIngest).toHaveBeenCalledTimes(1)
    })

    it("when the lint never ends, the queue goes on and the next drain starts a new lint", async () => {
      const hang = createDeferred<StructureFinding[]>()
      mockLintRun.mockImplementationOnce(() => hang.promise)

      await enqueueIngest(TEST_ID, "raw/sources/a.md")
      await waitUntil(() => mockLintRun.mock.calls.length === 1)
      await queueEmpty()
      // A second source is ingested while the first lint is still running.
      await enqueueIngest(TEST_ID, "raw/sources/b.md")
      await waitUntil(() => mockAutoIngest.mock.calls.length === 2)
      await queueEmpty()

      expect(getQueue()).toEqual([])
      expect(mockAutoIngest).toHaveBeenCalledTimes(2)
      hang.resolve([])
      await lintSettled(2)
    })
  })

  describe("when the open project changes before the lint ends", () => {
    it("stores nothing after a project switch", async () => {
      const slow = createDeferred<StructureFinding[]>()
      mockLintRun.mockImplementationOnce(() => slow.promise)
      useLintStore.getState().addItems([{ type: "structure", severity: "info", page: "wiki/old.md", detail: "Old.", check: "domain-missing" }])
      const before = useLintStore.getState().items

      await enqueueIngest(TEST_ID, "raw/sources/a.md")
      await waitUntil(() => mockLintRun.mock.calls.length === 1)
      await pauseQueue()
      slow.resolve([finding("domain-unknown", "wiki/concepts/wrong.md")])
      await Promise.all(pendingStructuralLints())

      expect(useLintStore.getState().items).toBe(before)
    })

    it("aborts the signal of the lint", async () => {
      const slow = createDeferred<StructureFinding[]>()
      mockLintRun.mockImplementationOnce(() => slow.promise)

      await enqueueIngest(TEST_ID, "raw/sources/a.md")
      await waitUntil(() => mockLintRun.mock.calls.length === 1)
      const signal = mockLintRun.mock.calls[0][1]?.signal
      expect(signal?.aborted).toBe(false)
      await pauseQueue()

      expect(signal?.aborted).toBe(true)
      slow.resolve([])
      await Promise.all(pendingStructuralLints())
    })

    it("stores nothing after the queue state is cleared", async () => {
      const slow = createDeferred<StructureFinding[]>()
      mockLintRun.mockImplementationOnce(() => slow.promise)

      await enqueueIngest(TEST_ID, "raw/sources/a.md")
      await waitUntil(() => mockLintRun.mock.calls.length === 1)
      clearQueueState()
      slow.resolve([finding("domain-unknown", "wiki/concepts/wrong.md")])
      await Promise.all(pendingStructuralLints())

      expect(structureItems()).toEqual([])
    })

    it("lets a newer lint replace an older one that is still running", async () => {
      const slow = createDeferred<StructureFinding[]>()
      mockLintRun.mockImplementationOnce(() => slow.promise)

      await enqueueIngest(TEST_ID, "raw/sources/a.md")
      await waitUntil(() => mockLintRun.mock.calls.length === 1)
      const firstSignal = mockLintRun.mock.calls[0][1]?.signal
      await queueEmpty()
      // The second ingest drains the queue again. Its lint is the real one, and it ends first.
      await enqueueIngest(TEST_ID, "raw/sources/b.md")
      await waitUntil(() => structureItems().length > 0)
      const newest = structureItems()

      expect(firstSignal?.aborted).toBe(true)
      expect(newest.map((item) => item.check)).toContain("domain-unknown")
      // The old lint ends late, with an answer of its own. The answer is dropped.
      slow.resolve([finding("domain-missing", "wiki/concepts/old.md")])
      await Promise.all(pendingStructuralLints())
      expect(structureItems()).toEqual(newest)
    })

    it("stores nothing for a project that was switched to the same id again", async () => {
      const slow = createDeferred<StructureFinding[]>()
      mockLintRun.mockImplementationOnce(() => slow.promise)

      await enqueueIngest(TEST_ID, "raw/sources/a.md")
      await waitUntil(() => mockLintRun.mock.calls.length === 1)
      await pauseQueue()
      await restoreQueue(TEST_ID, project)
      slow.resolve([finding("domain-unknown", "wiki/concepts/wrong.md")])
      await Promise.all(pendingStructuralLints())

      expect(structureItems()).toEqual([])
    })
  })
})
