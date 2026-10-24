/**
 * Review actions of a mechanism wiki. The tests run on a real temp folder: a reading wiki
 * (`reading/`) and a work wiki (`work/`) side by side, as the app lays them out.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createTempProject, fileExists, readFileRaw, realFs, writeFileRaw } from "@/test-helpers/fs-temp"
import { MECHANISM_TEMPLATE_FILES } from "@/lib/mechanism-template"
import { parseDomainsYaml } from "@/lib/wiki-config/domains"
import type { ReviewItem } from "@/stores/review-store"
import type { MechanismContext } from "./context"

vi.mock("@/commands/fs", () => realFs)

/** A test can replace what `loadMechanismContext` returns, for a state the real loader never produces. */
const loader = vi.hoisted(() => ({ override: undefined as MechanismContext | null | undefined }))

vi.mock("./context", async (importOriginal) => {
  const original = await importOriginal<typeof import("./context")>()
  return {
    ...original,
    loadMechanismContext: vi.fn(async (projectPath: string) =>
      loader.override !== undefined ? loader.override : original.loadMechanismContext(projectPath),
    ),
  }
})

import { handleMechanismReviewAction, stageResearchResult } from "./review-actions"
import type { ReviewActionContext } from "./review-actions"

let root = ""
let cleanup: () => Promise<void> = async () => {}
let reading = ""
let work = ""

beforeEach(async () => {
  const temp = await createTempProject("review-actions")
  root = temp.path
  cleanup = temp.cleanup
  reading = `${root}/reading`
  work = `${root}/work`
  loader.override = undefined
})

afterEach(async () => {
  await cleanup()
})

const TEMPLATE_DOMAINS = MECHANISM_TEMPLATE_FILES["domains.yaml"]

const LISTED_DOMAINS = [
  "# Domains of my wiki. Keep this comment.",
  "version: 1",
  "domains:",
  "  # The first domain.",
  "  hardware/async-circuits:",
  "    lens: hardware",
  "    description: Digital circuits without a global clock",
  "    whiteboards: []   # Optional.",
  "",
  "  ai/architecture:",
  "    lens: ai",
  "    description: Designs of neural networks",
  "    whiteboards: []",
  "# A closing note.",
  "",
].join("\n")

const READING_WIKI = "version: 1\nid: reading\nrole: reading\nmechanism_library: null\n"

function workWiki(library: string | null = "../reading"): string {
  return `version: 1\nid: work\nrole: work\nmechanism_library: ${library === null ? "null" : library}\n`
}

async function setUpReading(domains: string = TEMPLATE_DOMAINS): Promise<void> {
  await writeFileRaw(`${reading}/domains.yaml`, domains)
  await writeFileRaw(`${reading}/wiki.yaml`, READING_WIKI)
  await writeFileRaw(`${reading}/lenses/hardware.md`, "# Hardware\n")
  await writeFileRaw(`${reading}/lenses/ai.md`, "# AI\n")
}

async function setUpWork(wikiYaml: string = workWiki()): Promise<void> {
  await writeFileRaw(`${work}/domains.yaml`, LISTED_DOMAINS)
  await writeFileRaw(`${work}/wiki.yaml`, wikiYaml)
}

function makeReview(patch: Partial<ReviewItem> & Pick<ReviewItem, "type">): ReviewItem {
  return {
    id: "review-abc",
    title: "Item",
    description: "",
    options: [],
    resolved: false,
    createdAt: 0,
    ...patch,
  }
}

function makeCtx(projectPath: string, extra: Partial<ReviewActionContext> = {}) {
  const resolveItem = vi.fn<(id: string, label: string) => void>()
  const refresh = vi.fn(async () => {})
  const ctx: ReviewActionContext = { projectPath, resolveItem, refresh, ...extra }
  return { ctx, resolveItem, refresh }
}

function proposal(path: string, lens: string, description: string): ReviewItem {
  return makeReview({
    type: "new-domain",
    title: `New domain: ${path}`,
    description: `The analysis proposes a domain.\nPROPOSAL: ${path} | ${lens} | ${description}`,
  })
}

describe("handleMechanismReviewAction: unknown actions", () => {
  it("unknown action is not handled", async () => {
    await setUpReading()
    const { ctx, resolveItem, refresh } = makeCtx(reading)
    const item = makeReview({ type: "confirm" })

    expect(await handleMechanismReviewAction(item, "Skip", ctx)).toBe(false)
    expect(await handleMechanismReviewAction(item, "mech:no-such-action", ctx)).toBe(false)
    expect(await handleMechanismReviewAction(item, "constructor", ctx)).toBe(false)
    expect(await handleMechanismReviewAction(undefined, "Skip", ctx)).toBe(false)
    expect(resolveItem).not.toHaveBeenCalled()
    expect(refresh).not.toHaveBeenCalled()
  })

  it("throws when a mech: action has no review item", async () => {
    await setUpReading()
    const { ctx } = makeCtx(reading)

    await expect(handleMechanismReviewAction(undefined, "mech:approve-domain", ctx)).rejects.toThrow(
      /no longer in the review list/,
    )
  })
})

describe("mech:approve-domain", () => {
  it("adds the domain to the end of the list and keeps every comment", async () => {
    await setUpReading(LISTED_DOMAINS)
    const { ctx, resolveItem, refresh } = makeCtx(reading)

    const handled = await handleMechanismReviewAction(
      proposal("business/franchising", "business", "Growing a business by licensing its brand"),
      "mech:approve-domain",
      ctx,
    )

    expect(handled).toBe(true)
    const text = await readFileRaw(`${reading}/domains.yaml`)
    expect(text).toBe(
      [
        "# Domains of my wiki. Keep this comment.",
        "version: 1",
        "domains:",
        "  # The first domain.",
        "  hardware/async-circuits:",
        "    lens: hardware",
        "    description: Digital circuits without a global clock",
        "    whiteboards: []   # Optional.",
        "",
        "  ai/architecture:",
        "    lens: ai",
        "    description: Designs of neural networks",
        "    whiteboards: []",
        "  business/franchising:",
        "    lens: business",
        "    description: Growing a business by licensing its brand",
        "    whiteboards: []",
        "# A closing note.",
        "",
      ].join("\n"),
    )
    const parsed = parseDomainsYaml(text)
    expect(parsed.ok).toBe(true)
    expect(Object.keys(parsed.ok ? parsed.value.domains : {})).toEqual([
      "hardware/async-circuits",
      "ai/architecture",
      "business/franchising",
    ])
    expect(resolveItem).toHaveBeenCalledWith("review-abc", "Approved")
    expect(refresh).toHaveBeenCalledTimes(1)
  })

  it("replaces the domains: {} line of the template and keeps the template comments", async () => {
    await setUpReading(TEMPLATE_DOMAINS)
    const { ctx, resolveItem } = makeCtx(reading)

    await handleMechanismReviewAction(
      proposal("hardware/async-circuits", "hardware", "Digital circuits without a global clock"),
      "mech:approve-domain",
      ctx,
    )

    const text = await readFileRaw(`${reading}/domains.yaml`)
    expect(text.split("\n")).not.toContain("domains: {}")
    expect(text.split("\n")).toContain("domains:")
    expect(text).toContain("# Domain list. An AI agent picks the domain of each page only from this list.")
    expect(text).toContain("# Example entry. To use it")
    // Every template line except the one that was replaced is still there.
    for (const line of TEMPLATE_DOMAINS.split("\n")) {
      if (line !== "domains: {}") expect(text.split("\n")).toContain(line)
    }
    const parsed = parseDomainsYaml(text)
    expect(parsed.ok && parsed.value.domains).toEqual({
      "hardware/async-circuits": {
        lens: "hardware",
        description: "Digital circuits without a global clock",
        whiteboards: [],
      },
    })
    expect(resolveItem).toHaveBeenCalledWith("review-abc", "Approved")
  })

  it("adds a second domain after the first one added to an empty list", async () => {
    await setUpReading(TEMPLATE_DOMAINS)
    const { ctx } = makeCtx(reading)

    await handleMechanismReviewAction(proposal("ai/architecture", "ai", "Neural networks"), "mech:approve-domain", ctx)
    await handleMechanismReviewAction(proposal("hardware/async-circuits", "hardware", "Circuits"), "mech:approve-domain", ctx)

    const parsed = parseDomainsYaml(await readFileRaw(`${reading}/domains.yaml`))
    expect(parsed.ok && Object.keys(parsed.value.domains)).toEqual(["ai/architecture", "hardware/async-circuits"])
  })

  it("approve-domain rejects an invalid proposal", async () => {
    await setUpReading(LISTED_DOMAINS)
    const before = await readFileRaw(`${reading}/domains.yaml`)
    const { ctx, resolveItem, refresh } = makeCtx(reading)

    // A lens that no built-in list or lenses/ file names.
    await expect(
      handleMechanismReviewAction(proposal("chemistry/reactions", "chemistry", "How things react"), "mech:approve-domain", ctx),
    ).rejects.toThrow(/lens/)
    // A domain name that breaks the naming rule.
    await expect(
      handleMechanismReviewAction(proposal("Chemistry Reactions", "hardware", "How things react"), "mech:approve-domain", ctx),
    ).rejects.toThrow(/Chemistry Reactions/)
    // No description.
    await expect(
      handleMechanismReviewAction(proposal("chemistry/reactions", "hardware", " "), "mech:approve-domain", ctx),
    ).rejects.toThrow(/PROPOSAL/)
    // No PROPOSAL line at all.
    await expect(
      handleMechanismReviewAction(makeReview({ type: "new-domain", description: "nothing here" }), "mech:approve-domain", ctx),
    ).rejects.toThrow(/PROPOSAL/)

    expect(await readFileRaw(`${reading}/domains.yaml`)).toBe(before)
    expect(resolveItem).not.toHaveBeenCalled()
    expect(refresh).not.toHaveBeenCalled()
  })

  it("accepts a lens that has a file in lenses/", async () => {
    await setUpReading(LISTED_DOMAINS)
    await writeFileRaw(`${reading}/lenses/chemistry.md`, "# Chemistry\n")
    const { ctx, resolveItem } = makeCtx(reading)

    await handleMechanismReviewAction(proposal("chemistry/reactions", "chemistry", "How things react"), "mech:approve-domain", ctx)

    const parsed = parseDomainsYaml(await readFileRaw(`${reading}/domains.yaml`), ["hardware", "ai", "chemistry"])
    expect(parsed.ok && parsed.value.domains["chemistry/reactions"].lens).toBe("chemistry")
    expect(resolveItem).toHaveBeenCalledWith("review-abc", "Approved")
  })

  it("quotes a description that plain YAML would misread", async () => {
    await setUpReading(LISTED_DOMAINS)
    const { ctx } = makeCtx(reading)
    const description = 'Rules: "fast" # not a comment | 100% sure, yes'

    await handleMechanismReviewAction(proposal("business/rules", "business", description), "mech:approve-domain", ctx)

    const parsed = parseDomainsYaml(await readFileRaw(`${reading}/domains.yaml`))
    expect(parsed.ok && parsed.value.domains["business/rules"].description).toBe(description)
  })

  it("keeps the indentation and the line endings of the file", async () => {
    await setUpReading("version: 1\r\ndomains:\r\n    ai/architecture:\r\n        lens: ai\r\n        description: Neural networks\r\n")
    const { ctx } = makeCtx(reading)

    await handleMechanismReviewAction(proposal("hardware/async-circuits", "hardware", "Circuits"), "mech:approve-domain", ctx)

    const text = await readFileRaw(`${reading}/domains.yaml`)
    expect(text.startsWith("version: 1\r\ndomains:\r\n    ai/architecture:\r\n        lens: ai\r\n        description: Neural networks\r\n")).toBe(true)
    expect(text).toContain("\r\n    hardware/async-circuits:\r\n")
    expect(text.replace(/\r\n/g, "")).not.toContain("\n")
    expect(parseDomainsYaml(text).ok).toBe(true)
  })

  it("adds after an entry whose text block ends with a line that starts with #", async () => {
    await setUpReading(
      "version: 1\ndomains:\n  ai/architecture:\n    lens: ai\n    description: |\n      Neural networks\n      # still the description\n",
    )
    const { ctx } = makeCtx(reading)

    await handleMechanismReviewAction(proposal("hardware/async-circuits", "hardware", "Circuits"), "mech:approve-domain", ctx)

    const parsed = parseDomainsYaml(await readFileRaw(`${reading}/domains.yaml`))
    expect(parsed.ok && parsed.value.domains["ai/architecture"].description).toBe("Neural networks\n# still the description\n")
    expect(parsed.ok && parsed.value.domains["hardware/async-circuits"].description).toBe("Circuits")
  })

  it("adds a domains key when the file has none", async () => {
    await setUpReading("version: 1\n")
    const { ctx } = makeCtx(reading)

    await handleMechanismReviewAction(proposal("ai/architecture", "ai", "Neural networks"), "mech:approve-domain", ctx)

    const parsed = parseDomainsYaml(await readFileRaw(`${reading}/domains.yaml`))
    expect(parsed.ok && Object.keys(parsed.value.domains)).toEqual(["ai/architecture"])
  })

  it("resolves without writing when the domain is already listed", async () => {
    await setUpReading(LISTED_DOMAINS)
    const { ctx, resolveItem } = makeCtx(reading)

    await handleMechanismReviewAction(proposal("ai/architecture", "ai", "Another words"), "mech:approve-domain", ctx)

    expect(await readFileRaw(`${reading}/domains.yaml`)).toBe(LISTED_DOMAINS)
    expect(resolveItem).toHaveBeenCalledWith("review-abc", "Approved")
  })

  it("does not lose a domain when two approvals run together", async () => {
    await setUpReading(LISTED_DOMAINS)
    const { ctx } = makeCtx(reading)

    await Promise.all([
      handleMechanismReviewAction(proposal("business/a", "business", "A"), "mech:approve-domain", ctx),
      handleMechanismReviewAction(proposal("business/b", "business", "B"), "mech:approve-domain", ctx),
    ])

    const parsed = parseDomainsYaml(await readFileRaw(`${reading}/domains.yaml`))
    expect(parsed.ok && Object.keys(parsed.value.domains)).toEqual([
      "hardware/async-circuits",
      "ai/architecture",
      "business/a",
      "business/b",
    ])
  })

  it("does not write a file that is not a mechanism wiki", async () => {
    const { ctx } = makeCtx(reading)

    await expect(
      handleMechanismReviewAction(proposal("ai/architecture", "ai", "Neural networks"), "mech:approve-domain", ctx),
    ).rejects.toThrow(/domains\.yaml/)
    expect(await fileExists(`${reading}/domains.yaml`)).toBe(false)
  })

  it("does not write when the file cannot be edited as text", async () => {
    const flow = "version: 1\ndomains: {ai/architecture: {lens: ai, description: Neural networks}}\n"
    await setUpReading(flow)
    const { ctx, resolveItem } = makeCtx(reading)

    await expect(
      handleMechanismReviewAction(proposal("hardware/async-circuits", "hardware", "Circuits"), "mech:approve-domain", ctx),
    ).rejects.toThrow()
    expect(await readFileRaw(`${reading}/domains.yaml`)).toBe(flow)
    expect(resolveItem).not.toHaveBeenCalled()
  })
})

describe("mech:propose-mechanism", () => {
  const PAGE = [
    "---",
    "type: mechanism",
    "title: Event-driven computation",
    "lenses: [hardware]",
    'sources: ["raw/sources/private-notes.md"]',
    "---",
    "# Event-driven computation",
    "",
    "One line that states it.",
    "",
    "## Known instances",
    "",
    "- [[async-handshake]] (hardware/async-circuits): request/ack",
  ].join("\n")

  function mechanismReview(patch: Partial<ReviewItem> = {}): ReviewItem {
    return makeReview({
      type: "new-mechanism",
      title: "Event-driven computation",
      description: PAGE,
      sourcePath: "raw/sources/private-notes.md",
      affectedPages: ["wiki/mechanisms/event-driven-computation.md"],
      ...patch,
    })
  }

  it("propose-mechanism writes only to the library path", async () => {
    await setUpReading()
    await setUpWork()
    const { ctx, resolveItem } = makeCtx(work)

    const handled = await handleMechanismReviewAction(mechanismReview(), "mech:propose-mechanism", ctx)

    expect(handled).toBe(true)
    const written = await readFileRaw(`${reading}/raw/sources/proposals/event-driven-computation.md`)
    expect(written).toBe(
      [
        "---",
        "source_kind: note",
        'title: "Event-driven computation"',
        "proposed_from: work",
        "---",
        "",
        "# Event-driven computation",
        "",
        "One line that states it.",
        "",
        "## Known instances",
        "",
        "- [[async-handshake]] (hardware/async-circuits): request/ack",
        "",
      ].join("\n"),
    )
    // The original source path stays in the work wiki.
    expect(written).not.toContain("private-notes")
    expect(written).not.toContain("raw/sources/private")
    // Nothing is written in the work wiki.
    expect(await fileExists(`${work}/raw`)).toBe(false)
    expect(await fileExists(`${work}/wiki`)).toBe(false)
    expect(resolveItem).toHaveBeenCalledWith("review-abc", "Sent to reading wiki")
  })

  it("propose-mechanism names an incomplete proposal and marks it", async () => {
    await setUpReading()
    await setUpWork()
    const { ctx, resolveItem } = makeCtx(work)
    const partial = ["---", "type: mechanism", "title: Event-driven computation", "lens"].join("\n")

    await handleMechanismReviewAction(
      mechanismReview({ title: "(incomplete) Event-driven computation", description: `${partial}\n\nA partial body.` }),
      "mech:propose-mechanism",
      ctx,
    )

    const written = await readFileRaw(`${reading}/raw/sources/proposals/event-driven-computation.md`)
    expect(written.startsWith("---\nsource_kind: note\n")).toBe(true)
    expect(written).toContain('title: "Event-driven computation"')
    expect(written).toContain("proposed_from: work\n")
    expect(written).toContain("incomplete: true\n")
    expect(written).toContain("A partial body.")
    expect(resolveItem).toHaveBeenCalledWith("review-abc", "Sent to reading wiki")
  })

  it("propose-mechanism never overwrites", async () => {
    await setUpReading()
    await setUpWork()
    const { ctx } = makeCtx(work)
    const dir = `${reading}/raw/sources/proposals`
    await writeFileRaw(`${dir}/event-driven-computation.md`, "EXISTING FILE\n")

    await handleMechanismReviewAction(mechanismReview({ description: "First body." }), "mech:propose-mechanism", ctx)
    await handleMechanismReviewAction(mechanismReview({ description: "Second body." }), "mech:propose-mechanism", ctx)

    expect(await readFileRaw(`${dir}/event-driven-computation.md`)).toBe("EXISTING FILE\n")
    expect(await readFileRaw(`${dir}/event-driven-computation-2.md`)).toContain("First body.")
    expect(await readFileRaw(`${dir}/event-driven-computation-3.md`)).toContain("Second body.")
  })

  it("keeps a Chinese title as the file name", async () => {
    await setUpReading()
    await setUpWork()
    const { ctx } = makeCtx(work)

    await handleMechanismReviewAction(mechanismReview({ title: "事件驅動 計算" }), "mech:propose-mechanism", ctx)

    expect(await fileExists(`${reading}/raw/sources/proposals/事件驅動-計算.md`)).toBe(true)
  })

  it("uses proposal-<hash> when the title has no usable word", async () => {
    await setUpReading()
    await setUpWork()
    const { ctx } = makeCtx(work)

    await handleMechanismReviewAction(mechanismReview({ title: "!!! ???" }), "mech:propose-mechanism", ctx)
    await handleMechanismReviewAction(mechanismReview({ title: "(incomplete) ///" }), "mech:propose-mechanism", ctx)
    await handleMechanismReviewAction(mechanismReview({ title: "!!! ???" }), "mech:propose-mechanism", ctx)

    const { listDirectory } = await import("@/commands/fs")
    const names = (await listDirectory(`${reading}/raw/sources/proposals`)).map((node) => node.name).sort()
    expect(names).toHaveLength(3)
    for (const name of names) expect(name).toMatch(/^proposal-[0-9a-f]{8}(?:-\d+)?\.md$/)
    // The same title gives the same base name, so the second copy gets a number.
    const bases = names.map((name) => name.replace(/(?:-\d+)?\.md$/, ""))
    expect(new Set(bases).size).toBe(2)
    expect(names.filter((name) => name.endsWith("-2.md"))).toHaveLength(1)
  })

  it("cuts a long title to 80 characters and never makes a path from a title", async () => {
    await setUpReading()
    await setUpWork()
    const { ctx } = makeCtx(work)
    const long = `${"event ".repeat(40)}driven`

    await handleMechanismReviewAction(mechanismReview({ title: long }), "mech:propose-mechanism", ctx)
    await handleMechanismReviewAction(
      mechanismReview({ title: "../../../etc/passwd" }),
      "mech:propose-mechanism",
      ctx,
    )
    await handleMechanismReviewAction(mechanismReview({ title: "a\\b/c" }), "mech:propose-mechanism", ctx)

    const { listDirectory } = await import("@/commands/fs")
    const names = (await listDirectory(`${reading}/raw/sources/proposals`)).map((node) => node.name).sort()
    expect(names).toHaveLength(3)
    for (const name of names) {
      expect(name).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*\.md$/)
      expect(name.length).toBeLessThanOrEqual(80 + ".md".length)
    }
    expect(names).toContain("etc-passwd.md")
    expect(names).toContain("a-b-c.md")
    expect(await fileExists(`${root}/etc`)).toBe(false)
  })

  it("throws a clear error when the wiki has no library path", async () => {
    await setUpReading()
    await setUpWork()
    const real = await vi.importActual<typeof import("./context")>("./context")
    const context = await real.loadMechanismContext(work)
    const { ctx, resolveItem } = makeCtx(work)

    loader.override = { ...context!, mechanismLibraryPath: null }
    await expect(handleMechanismReviewAction(mechanismReview(), "mech:propose-mechanism", ctx)).rejects.toThrow(
      /mechanism library/,
    )
    loader.override = null
    await expect(handleMechanismReviewAction(mechanismReview(), "mech:propose-mechanism", ctx)).rejects.toThrow(
      /domains\.yaml/,
    )

    expect(await fileExists(`${reading}/raw`)).toBe(false)
    expect(resolveItem).not.toHaveBeenCalled()
  })

  it("does not guess the library when wiki.yaml is broken", async () => {
    await setUpReading()
    await setUpWork("version: 1\nid: work\nrole: work\n")
    const { ctx, resolveItem } = makeCtx(work)

    await expect(handleMechanismReviewAction(mechanismReview(), "mech:propose-mechanism", ctx)).rejects.toThrow(
      /wiki\.yaml/,
    )

    expect(await fileExists(`${work}/raw`)).toBe(false)
    expect(resolveItem).not.toHaveBeenCalled()
  })

  it("throws when the item has no proposal text", async () => {
    await setUpReading()
    await setUpWork()
    const { ctx } = makeCtx(work)

    await expect(
      handleMechanismReviewAction(mechanismReview({ description: "---\ntype: mechanism\n---\n" }), "mech:propose-mechanism", ctx),
    ).rejects.toThrow(/no proposal text/)
    expect(await fileExists(`${reading}/raw`)).toBe(false)
  })
})

describe("mech:replace-source", () => {
  const OLDER = "raw/sources/handshakes.md"
  const NEWER = "raw/sources/handshakes-copy.md"

  function duplicateReview(existing: string, newer: string): ReviewItem {
    return makeReview({
      type: "duplicate-source",
      title: "Duplicate source: handshakes-copy.md",
      description: `handshakes-copy.md repeats handshakes.md.\nEXISTING: ${existing}\nNEWER: ${newer}`,
    })
  }

  it("copies the newer text over the older source and keeps the newer file", async () => {
    await setUpReading()
    await writeFileRaw(`${reading}/${OLDER}`, "Short text.\n")
    await writeFileRaw(`${reading}/${NEWER}`, "Short text, and then a lot more.\n")
    const { ctx, resolveItem, refresh } = makeCtx(reading)

    const handled = await handleMechanismReviewAction(duplicateReview(OLDER, NEWER), "mech:replace-source", ctx)

    expect(handled).toBe(true)
    expect(await readFileRaw(`${reading}/${OLDER}`)).toBe("Short text, and then a lot more.\n")
    expect(await readFileRaw(`${reading}/${NEWER}`)).toBe("Short text, and then a lot more.\n")
    expect(resolveItem).toHaveBeenCalledWith("review-abc", "Replaced the older source")
    expect(refresh).toHaveBeenCalledTimes(1)
  })

  it("reads the lines at the end, not a file name that looks like one", async () => {
    await setUpReading()
    await writeFileRaw(`${reading}/${OLDER}`, "Short text.\n")
    await writeFileRaw(`${reading}/${NEWER}`, "Longer text.\n")
    const { ctx, resolveItem } = makeCtx(reading)
    const item = makeReview({
      type: "duplicate-source",
      description: `EXISTING: odd name.md repeats NEWER: other.md\nEXISTING: ${OLDER}\nNEWER: ${NEWER}`,
    })

    await handleMechanismReviewAction(item, "mech:replace-source", ctx)

    expect(await readFileRaw(`${reading}/${OLDER}`)).toBe("Longer text.\n")
    expect(resolveItem).toHaveBeenCalledTimes(1)
  })

  it("asks the caller to ingest the replaced source again, before it resolves the item", async () => {
    await setUpReading()
    await writeFileRaw(`${reading}/${OLDER}`, "Short text.\n")
    await writeFileRaw(`${reading}/${NEWER}`, "Longer text.\n")
    const order: string[] = []
    const reingest = vi.fn(async (path: string) => {
      order.push(`reingest ${path}`)
    })
    const { ctx, resolveItem } = makeCtx(reading, { reingest })
    resolveItem.mockImplementation(() => {
      order.push("resolve")
    })

    await handleMechanismReviewAction(duplicateReview(OLDER, NEWER), "mech:replace-source", ctx)

    expect(order).toEqual([`reingest ${OLDER}`, "resolve"])
  })

  it("leaves the item open when the ingest cannot be queued", async () => {
    await setUpReading()
    await writeFileRaw(`${reading}/${OLDER}`, "Short text.\n")
    await writeFileRaw(`${reading}/${NEWER}`, "Longer text.\n")
    const { ctx, resolveItem } = makeCtx(reading, {
      reingest: async () => {
        throw new Error("queue is closed")
      },
    })

    await expect(handleMechanismReviewAction(duplicateReview(OLDER, NEWER), "mech:replace-source", ctx)).rejects.toThrow(
      "queue is closed",
    )
    expect(resolveItem).not.toHaveBeenCalled()
  })

  it("replace-source rejects a path outside raw/sources", async () => {
    await setUpReading()
    await writeFileRaw(`${reading}/${NEWER}`, "Newer text.\n")
    await writeFileRaw(`${reading}/wiki/index.md`, "# Index\n")
    await writeFileRaw(`${root}/outside.md`, "Outside.\n")
    const { ctx, resolveItem, refresh } = makeCtx(reading)

    const bad = [
      "../outside.md",
      "raw/sources/../../outside.md",
      "raw/sources/../../../outside.md",
      "raw/../wiki/index.md",
      "wiki/index.md",
      `${root}/outside.md`,
      "/etc/passwd",
      "C:/Windows/win.ini",
      "raw\\sources\\..\\..\\outside.md",
      "raw/sources",
      "raw/sources/",
      "raw/sources//x.md",
      "raw/sources/./x.md",
      "raw/sourcesx/a.md",
      "raw/wiki/index.md",
      "wiki/sources/page.md",
      "other/sources/a.md",
      "Raw/Sources/a.md",
      "",
    ]
    for (const path of bad) {
      // Both lines are checked: a bad path in either position is refused.
      await expect(
        handleMechanismReviewAction(duplicateReview(path, NEWER), "mech:replace-source", ctx),
      ).rejects.toThrow()
      await expect(
        handleMechanismReviewAction(duplicateReview(NEWER.replace("-copy", "-other"), path), "mech:replace-source", ctx),
      ).rejects.toThrow()
    }

    expect(await readFileRaw(`${root}/outside.md`)).toBe("Outside.\n")
    expect(await readFileRaw(`${reading}/wiki/index.md`)).toBe("# Index\n")
    expect(await fileExists(`${reading}/raw/sources/handshakes-other.md`)).toBe(false)
    expect(resolveItem).not.toHaveBeenCalled()
    expect(refresh).not.toHaveBeenCalled()
  })

  it("throws when a line is missing, the two paths are one file, or the file types differ", async () => {
    await setUpReading()
    await writeFileRaw(`${reading}/${OLDER}`, "Older.\n")
    await writeFileRaw(`${reading}/${NEWER}`, "Newer.\n")
    await writeFileRaw(`${reading}/raw/sources/handshakes.pdf`, "%PDF")
    const { ctx, resolveItem } = makeCtx(reading)

    await expect(
      handleMechanismReviewAction(makeReview({ type: "duplicate-source", description: `NEWER: ${NEWER}` }), "mech:replace-source", ctx),
    ).rejects.toThrow(/EXISTING/)
    await expect(
      handleMechanismReviewAction(makeReview({ type: "duplicate-source", description: `EXISTING: ${OLDER}` }), "mech:replace-source", ctx),
    ).rejects.toThrow(/NEWER/)
    await expect(
      handleMechanismReviewAction(duplicateReview(OLDER, OLDER), "mech:replace-source", ctx),
    ).rejects.toThrow(/same file/)
    await expect(
      handleMechanismReviewAction(duplicateReview("raw/sources/handshakes.pdf", NEWER), "mech:replace-source", ctx),
    ).rejects.toThrow(/type/)

    expect(await readFileRaw(`${reading}/${OLDER}`)).toBe("Older.\n")
    expect(await readFileRaw(`${reading}/raw/sources/handshakes.pdf`)).toBe("%PDF")
    expect(resolveItem).not.toHaveBeenCalled()
  })

  it("throws when the newer file is gone and leaves the older one alone", async () => {
    await setUpReading()
    await writeFileRaw(`${reading}/${OLDER}`, "Older.\n")
    const { ctx, resolveItem } = makeCtx(reading)

    await expect(handleMechanismReviewAction(duplicateReview(OLDER, NEWER), "mech:replace-source", ctx)).rejects.toThrow(
      /no longer exists/,
    )
    expect(await readFileRaw(`${reading}/${OLDER}`)).toBe("Older.\n")
    expect(resolveItem).not.toHaveBeenCalled()
  })
})

describe("research staging", () => {
  const FILE = "research-async-handshakes-2026-06-06-100000-task-1.md"
  const PAGE = [
    "---",
    "type: query",
    'title: "Research: async handshakes"',
    "origin: deep-research",
    "---",
    "",
    "# Research: async handshakes",
    "",
    "A request line goes high when the sender has data.",
    "",
  ].join("\n")

  it("stageResearchResult writes the file to staging and returns a research-result review", async () => {
    await setUpReading()

    const review = await stageResearchResult(reading, FILE, PAGE)

    expect(await readFileRaw(`${reading}/.llm-wiki/research-staging/${FILE}`)).toBe(PAGE)
    expect(await fileExists(`${reading}/wiki/queries/${FILE}`)).toBe(false)
    expect(review.type).toBe("research-result")
    expect(review.sourcePath).toBe(`.llm-wiki/research-staging/${FILE}`)
    expect(review.affectedPages).toEqual([`wiki/queries/${FILE}`])
    expect(review.options.map((option) => option.action)).toContain("mech:accept-research")
    expect(review.title).toContain(FILE.replace(/\.md$/, ""))
    expect(review.description).toContain("Research: async handshakes")
    expect(review.description).toContain("A request line goes high")
    expect(review).not.toHaveProperty("id")
  })

  it("does not overwrite a staged result that is still waiting", async () => {
    await setUpReading()

    const first = await stageResearchResult(reading, FILE, "first\n")
    const second = await stageResearchResult(reading, FILE, "second\n")

    expect(await readFileRaw(`${reading}/.llm-wiki/research-staging/${FILE}`)).toBe("first\n")
    expect(second.sourcePath).toBe(`.llm-wiki/research-staging/${FILE.replace(/\.md$/, "-2.md")}`)
    expect(second.title).not.toBe(first.title)
    expect(await readFileRaw(`${reading}/${second.sourcePath}`)).toBe("second\n")
  })

  it.each(["", "..", "a/b.md", "..\\x.md", "../x.md", "a\0b.md"])("refuses the file name %j", async (name) => {
    await setUpReading()

    await expect(stageResearchResult(reading, name, PAGE)).rejects.toThrow(/file name/)
    expect(await fileExists(`${reading}/.llm-wiki`)).toBe(false)
  })

  it("mech:accept-research moves the staged file to wiki/queries and resolves as Saved", async () => {
    await setUpReading()
    const review = makeReview({ ...(await stageResearchResult(reading, FILE, PAGE)), id: "review-r1" })
    const { ctx, resolveItem, refresh } = makeCtx(reading)

    const handled = await handleMechanismReviewAction(review, "mech:accept-research", ctx)

    expect(handled).toBe(true)
    expect(await readFileRaw(`${reading}/wiki/queries/${FILE}`)).toBe(PAGE)
    expect(await fileExists(`${reading}/.llm-wiki/research-staging/${FILE}`)).toBe(false)
    expect(resolveItem).toHaveBeenCalledWith("review-r1", "Saved")
    expect(refresh).toHaveBeenCalledTimes(1)
  })

  it("mech:accept-research never overwrites a page in wiki/queries", async () => {
    await setUpReading()
    await writeFileRaw(`${reading}/wiki/queries/${FILE}`, "A page the user wrote.\n")
    const review = makeReview({ ...(await stageResearchResult(reading, FILE, PAGE)), id: "review-r1" })
    const { ctx } = makeCtx(reading)

    await handleMechanismReviewAction(review, "mech:accept-research", ctx)

    expect(await readFileRaw(`${reading}/wiki/queries/${FILE}`)).toBe("A page the user wrote.\n")
    expect(await readFileRaw(`${reading}/wiki/queries/${FILE.replace(/\.md$/, "-2.md")}`)).toBe(PAGE)
  })

  it("mech:accept-research refuses a staged path outside the staging folder", async () => {
    await setUpReading()
    await writeFileRaw(`${reading}/raw/sources/secret.md`, "Secret.\n")
    await writeFileRaw(`${root}/outside.md`, "Outside.\n")
    await writeFileRaw(`${reading}/.llm-wiki/research-staging/staged.md`, "Staged.\n")
    const { ctx, resolveItem } = makeCtx(reading)

    const bad = [
      // As long as the staging folder prefix, but not the prefix: the rest must not be read as a staged file name.
      `${"x".repeat(".llm-wiki/research-staging/".length)}staged.md`,
      ".llm-wiki/research-staging-old/staged.md",
      "raw/sources/secret.md",
      "wiki/index.md",
      ".llm-wiki/research-staging/../../raw/sources/secret.md",
      ".llm-wiki/research-staging/sub/x.md",
      ".llm-wiki/research-staging/",
      ".llm-wiki/research-staging/..",
      `${root}/outside.md`,
      "../outside.md",
      ".llm-wiki/research-staging\\..\\..\\raw\\sources\\secret.md",
      "",
    ]
    for (const sourcePath of bad) {
      await expect(
        handleMechanismReviewAction(makeReview({ type: "research-result", sourcePath }), "mech:accept-research", ctx),
      ).rejects.toThrow()
    }
    await expect(
      handleMechanismReviewAction(makeReview({ type: "research-result" }), "mech:accept-research", ctx),
    ).rejects.toThrow()

    expect(await readFileRaw(`${reading}/raw/sources/secret.md`)).toBe("Secret.\n")
    expect(await readFileRaw(`${root}/outside.md`)).toBe("Outside.\n")
    expect(await fileExists(`${reading}/wiki/queries`)).toBe(false)
    expect(await readFileRaw(`${reading}/.llm-wiki/research-staging/staged.md`)).toBe("Staged.\n")
    expect(resolveItem).not.toHaveBeenCalled()
  })

  it("mech:accept-research throws when the staged file is gone", async () => {
    await setUpReading()
    const { ctx, resolveItem } = makeCtx(reading)
    const review = makeReview({ type: "research-result", sourcePath: `.llm-wiki/research-staging/${FILE}` })

    await expect(handleMechanismReviewAction(review, "mech:accept-research", ctx)).rejects.toThrow(/no longer/)
    expect(resolveItem).not.toHaveBeenCalled()
  })
})
