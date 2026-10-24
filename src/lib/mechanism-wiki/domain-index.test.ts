import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createTempProject, readFileRaw, realFs, writeFileRaw, fileExists } from "@/test-helpers/fs-temp"
import { materializeSampleWiki } from "@/test-helpers/sample-wiki"

vi.mock("@/commands/fs", () => ({
  ...realFs,
  writeFile: vi.fn(realFs.writeFile),
  listDirectory: vi.fn(realFs.listDirectory),
}))

import { listDirectory, writeFile } from "@/commands/fs"
import { loadMechanismContext } from "./context"
import type { MechanismContext } from "./context"
import { buildScopedIndexText, listMechanismSlugs, rebuildDomainIndex, scanWikiPages } from "./domain-index"

const mockWriteFile = vi.mocked(writeFile)
const mockListDirectory = vi.mocked(listDirectory)

function pageText(options: { type: string; title: string; domain?: string; extra?: string[] }): string {
  return [
    "---",
    `type: ${options.type}`,
    `title: ${options.title}`,
    ...(options.domain === undefined ? [] : [`domain: ${options.domain}`]),
    ...(options.extra ?? []),
    "---",
    "",
    `# ${options.title}`,
    "",
  ].join("\n")
}

describe("domain index files", () => {
  let tmp: { path: string; cleanup: () => Promise<void> }
  let project: string

  beforeEach(async () => {
    mockWriteFile.mockClear()
    mockListDirectory.mockReset()
    mockListDirectory.mockImplementation(realFs.listDirectory)
    tmp = await createTempProject("domain-index")
    project = `${tmp.path}/wiki-a`
    await materializeSampleWiki(project)
  })

  afterEach(async () => {
    await tmp.cleanup()
  })

  async function load(path: string = project): Promise<MechanismContext> {
    const ctx = await loadMechanismContext(path)
    if (!ctx) throw new Error("expected a mechanism context")
    return ctx
  }

  async function addPage(relativePath: string, text: string, root: string = project): Promise<void> {
    await writeFileRaw(`${root}/${relativePath}`, text)
  }

  async function addSamplePages(root: string = project): Promise<void> {
    await addPage("wiki/concepts/handshake.md", pageText({ type: "concept", title: "Handshake", domain: "hardware/async-circuits" }), root)
    await addPage("wiki/entities/click-element.md", pageText({ type: "entity", title: "Click element", domain: "hardware/async-circuits" }), root)
    await addPage("wiki/concepts/spikes.md", pageText({ type: "concept", title: "Spikes", domain: "ai/architecture" }), root)
    await addPage("wiki/mechanisms/event-driven-computing.md", pageText({ type: "mechanism", title: "Event-driven computing" }), root)
    await addPage("wiki/concepts/loose.md", pageText({ type: "concept", title: "Loose" }), root)
  }

  describe("scanWikiPages", () => {
    it("scans the pages of wiki/ and leaves out the aggregate files and the indexes", async () => {
      await addSamplePages()
      await addPage("wiki/index.md", "# Wiki Index\n")
      await addPage("wiki/log.md", "# Log\n")
      await addPage("wiki/overview.md", "# Overview\n")
      await addPage("wiki/indexes/ai--architecture.md", "# ai/architecture\n")
      await addPage("wiki/media/pic.png", "binary")
      await addPage("wiki/concepts/notes.txt", "not markdown")

      const pages = await scanWikiPages(project)

      expect(pages.map((page) => page.path)).toEqual([
        "wiki/concepts/handshake.md",
        "wiki/concepts/loose.md",
        "wiki/concepts/spikes.md",
        "wiki/entities/click-element.md",
        "wiki/mechanisms/event-driven-computing.md",
      ])
      expect(pages[0]).toEqual({
        path: "wiki/concepts/handshake.md",
        slug: "handshake",
        type: "concept",
        title: "Handshake",
        domain: "hardware/async-circuits",
      })
    })

    it("keeps an index.md in a subfolder: only the one at the top is an aggregate file", async () => {
      await addPage("wiki/concepts/index.md", pageText({ type: "concept", title: "Concept home", domain: "ai/architecture" }))

      const pages = await scanWikiPages(project)

      expect(pages.map((page) => page.path)).toEqual(["wiki/concepts/index.md"])
    })

    it("returns an empty list when the project has no wiki folder", async () => {
      expect(await scanWikiPages(`${tmp.path}/missing`)).toEqual([])
    })
  })

  describe("rebuildDomainIndex", () => {
    it("writes the root index, the mechanism index, and one index per listed domain", async () => {
      await addSamplePages()
      const ctx = await load()

      const written = await rebuildDomainIndex(project, ctx)

      expect(written).toEqual([
        "wiki/index.md",
        "wiki/indexes/_mechanisms.md",
        "wiki/indexes/ai--architecture.md",
        "wiki/indexes/business--franchising.md",
        "wiki/indexes/hardware--async-circuits.md",
      ])
      expect(await readFileRaw(`${project}/wiki/index.md`)).toBe(
        [
          "# Wiki Index",
          "",
          "- [ai/architecture](indexes/ai--architecture.md) — 1 pages",
          "- [business/franchising](indexes/business--franchising.md) — 0 pages",
          "- [hardware/async-circuits](indexes/hardware--async-circuits.md) — 2 pages",
          "- [Mechanisms](indexes/_mechanisms.md) — 1 pages",
          "- Unassigned — 1 pages",
          "  - [[loose]]",
          "",
        ].join("\n"),
      )
      expect(await readFileRaw(`${project}/wiki/indexes/_mechanisms.md`)).toBe(
        "# Mechanisms\n\n- [[event-driven-computing]] — Event-driven computing\n",
      )
      expect(await readFileRaw(`${project}/wiki/indexes/hardware--async-circuits.md`)).toBe(
        [
          "# hardware/async-circuits",
          "",
          "## Entity",
          "",
          "- [[click-element]] — Click element",
          "",
          "## Concept",
          "",
          "- [[handshake]] — Handshake",
          "",
        ].join("\n"),
      )
      expect(await readFileRaw(`${project}/wiki/indexes/business--franchising.md`)).toBe("# business/franchising\n")
    })

    it("writes only changed files", async () => {
      await addSamplePages()
      const ctx = await load()
      await rebuildDomainIndex(project, ctx)
      mockWriteFile.mockClear()

      // Nothing changed: nothing is written.
      expect(await rebuildDomainIndex(project, ctx)).toEqual([])
      expect(mockWriteFile).not.toHaveBeenCalled()

      // A new page in one domain changes the root index (count) and that domain's index only.
      await addPage("wiki/concepts/spiking.md", pageText({ type: "concept", title: "Spiking", domain: "ai/architecture" }))
      const written = await rebuildDomainIndex(project, ctx)

      expect(written).toEqual(["wiki/index.md", "wiki/indexes/ai--architecture.md"])
      expect(mockWriteFile.mock.calls.map(([path]) => path)).toEqual([
        `${project}/wiki/index.md`,
        `${project}/wiki/indexes/ai--architecture.md`,
      ])
      expect(await readFileRaw(`${project}/wiki/indexes/ai--architecture.md`)).toContain("[[spiking]] — Spiking")
    })

    it("reports each written file through the callback", async () => {
      await addSamplePages()
      const ctx = await load()
      const reported: string[] = []

      const written = await rebuildDomainIndex(project, ctx, (path) => reported.push(path))

      expect(reported).toEqual(written)
      expect(reported).toHaveLength(5)
      // A second run writes nothing, so it reports nothing.
      await rebuildDomainIndex(project, ctx, (path) => reported.push(path))
      expect(reported).toHaveLength(5)
    })

    it("has reported the files it wrote before a write fails", async () => {
      await addSamplePages()
      const ctx = await load()
      const reported: string[] = []
      mockWriteFile
        .mockImplementationOnce(realFs.writeFile)
        .mockImplementationOnce(realFs.writeFile)
        .mockRejectedValueOnce(new Error("disk full"))

      await expect(rebuildDomainIndex(project, ctx, (path) => reported.push(path))).rejects.toThrow("disk full")

      expect(reported).toEqual(["wiki/index.md", "wiki/indexes/_mechanisms.md"])
    })

    it("writes the same bytes on every run", async () => {
      await addSamplePages()
      const ctx = await load()
      await rebuildDomainIndex(project, ctx)
      const first = await Promise.all(
        ["wiki/index.md", "wiki/indexes/_mechanisms.md", "wiki/indexes/hardware--async-circuits.md"].map((p) =>
          readFileRaw(`${project}/${p}`),
        ),
      )

      await rebuildDomainIndex(project, ctx)
      const second = await Promise.all(
        ["wiki/index.md", "wiki/indexes/_mechanisms.md", "wiki/indexes/hardware--async-circuits.md"].map((p) =>
          readFileRaw(`${project}/${p}`),
        ),
      )

      expect(second).toEqual(first)
    })

    it("indexes a hypothesis page under its to_domain", async () => {
      await addPage(
        "wiki/hypotheses/handshake-backpressure.md",
        pageText({
          type: "hypothesis",
          title: "Handshakes are backpressure",
          extra: ["from_domain: hardware/async-circuits", "to_domain: ai/architecture"],
        }),
      )
      const ctx = await load()

      await rebuildDomainIndex(project, ctx)

      expect(await readFileRaw(`${project}/wiki/indexes/ai--architecture.md`)).toBe(
        "# ai/architecture\n\n## Hypothesis\n\n- [[handshake-backpressure]] — Handshakes are backpressure\n",
      )
      expect(await readFileRaw(`${project}/wiki/indexes/hardware--async-circuits.md`)).toBe("# hardware/async-circuits\n")
      expect(await readFileRaw(`${project}/wiki/index.md`)).toContain("- [ai/architecture](indexes/ai--architecture.md) — 1 pages")
    })

    it("does not index its own index files and keeps the index of a domain that is gone", async () => {
      await addPage("wiki/indexes/old--domain.md", "# old/domain\n\n- [[something]]\n")
      await addSamplePages()
      const ctx = await load()

      await rebuildDomainIndex(project, ctx)
      await rebuildDomainIndex(project, ctx)

      expect(await readFileRaw(`${project}/wiki/indexes/old--domain.md`)).toBe("# old/domain\n\n- [[something]]\n")
      const root = await readFileRaw(`${project}/wiki/index.md`)
      expect(root).not.toContain("old--domain")
      expect(root).not.toContain("something")
      expect(root).toContain("- Unassigned — 1 pages")
    })

    it("lists a page of a domain that domains.yaml does not list as unassigned", async () => {
      await addPage("wiki/concepts/attention.md", pageText({ type: "concept", title: "Attention", domain: "cognition/attention" }))
      const ctx = await load()

      await rebuildDomainIndex(project, ctx)

      expect(await fileExists(`${project}/wiki/indexes/cognition--attention.md`)).toBe(false)
      expect(await readFileRaw(`${project}/wiki/index.md`)).toContain("- Unassigned — 1 pages\n  - [[attention]]\n")
    })
  })

  describe("buildScopedIndexText", () => {
    it("holds the root index, the mechanism index, and the index of the hinted domain", async () => {
      await addSamplePages()
      const ctx = await load()

      const text = await buildScopedIndexText(project, ctx, "hardware/async-circuits")

      expect(text.startsWith("# Wiki Index\n")).toBe(true)
      expect(text).toContain("- [hardware/async-circuits](indexes/hardware--async-circuits.md) — 2 pages")
      expect(text).toContain("# Mechanisms\n\n- [[event-driven-computing]] — Event-driven computing\n")
      expect(text).toContain("# hardware/async-circuits\n\n## Entity")
      expect(text).toContain("- [[handshake]] — Handshake")
      // The pages of another domain are not listed.
      expect(text).not.toContain("[[spikes]]")
    })

    it("has no domain index without a domain", async () => {
      await addSamplePages()
      const ctx = await load()

      const text = await buildScopedIndexText(project, ctx, null)

      expect(text).toContain("# Mechanisms")
      expect(text).not.toContain("[[handshake]]")
      expect(text).not.toContain("## Concept")
    })

    it("builds from the pages, not from the wiki/index.md that is on disk", async () => {
      await addSamplePages()
      await addPage("wiki/index.md", "# Old index\n\n- [[stale-page]]\n")
      const ctx = await load()

      const text = await buildScopedIndexText(project, ctx, null)

      expect(text).not.toContain("stale-page")
      expect(text).toContain("# Wiki Index")
    })

    it("scoped text includes the library mechanisms for a work wiki", async () => {
      const library = `${tmp.path}/reading-wiki`
      await materializeSampleWiki(library)
      await addPage("wiki/mechanisms/event-driven-computing.md", pageText({ type: "mechanism", title: "Event-driven computing" }), library)
      await addPage("wiki/mechanisms/backpressure.md", pageText({ type: "mechanism", title: "Backpressure" }), library)
      await addPage("wiki/concepts/library-only-concept.md", pageText({ type: "concept", title: "Library only", domain: "ai/architecture" }), library)
      await addSamplePages()
      await addPage("wiki.yaml", `version: 1\nid: work\nrole: work\nmechanism_library: ${library}\n`)
      const ctx = await load()
      expect(ctx.mechanismLibraryPath).toBe(library)

      const text = await buildScopedIndexText(project, ctx, "hardware/async-circuits")

      expect(text).toContain("# Mechanisms\n\n- [[backpressure]] — Backpressure\n- [[event-driven-computing]] — Event-driven computing\n")
      // The root index counts the mechanisms of the library, not the ones of the work wiki.
      expect(text).toContain("- [Mechanisms](indexes/_mechanisms.md) — 2 pages")
      // The work wiki's own pages fill the domain parts. The library's other pages do not.
      expect(text).toContain("- [[handshake]] — Handshake")
      expect(text).not.toContain("library-only-concept")
    })

    it("has an empty mechanism section when the library folder does not exist", async () => {
      await addSamplePages()
      const ctx = { ...(await load()), mechanismLibraryPath: `${tmp.path}/no-such-library` }

      const text = await buildScopedIndexText(project, ctx, "ai/architecture")

      expect(text).toContain("# Mechanisms\n\n# ai/architecture")
      expect(text).toContain("- [Mechanisms](indexes/_mechanisms.md) — 0 pages")
      // The pages of the project itself are still indexed.
      expect(text).toContain("- [[spikes]] — Spikes")
    })

    it("has an empty mechanism section when listing the library folder fails", async () => {
      await addSamplePages()
      const library = `${tmp.path}/unreadable-library`
      const ctx = { ...(await load()), mechanismLibraryPath: library }
      // The app's list_directory fails for a folder that does not exist.
      mockListDirectory.mockImplementation(async (path) => {
        if (path.startsWith(library)) throw new Error(`Path does not exist: '${path}'`)
        return realFs.listDirectory(path)
      })

      const text = await buildScopedIndexText(project, ctx, null)

      expect(text).toContain("# Mechanisms\n")
      expect(text).toContain("- [Mechanisms](indexes/_mechanisms.md) — 0 pages")
    })

    it("cuts the unassigned list at 200 lines in the prompt text, and only there", async () => {
      for (let i = 0; i < 205; i += 1) {
        const slug = `loose-${String(i).padStart(3, "0")}`
        await addPage(`wiki/concepts/${slug}.md`, pageText({ type: "concept", title: slug }))
      }
      const ctx = await load()

      const text = await buildScopedIndexText(project, ctx, null)

      expect(text).toContain("- Unassigned — 205 pages")
      expect(text.match(/^ {2}- \[\[loose-/gm)).toHaveLength(200)
      expect(text).toContain("  - [[loose-199]]\n  - … 5 more unassigned pages\n")
      expect(text).not.toContain("[[loose-200]]")

      // The index file that is written stays complete: nothing is hidden.
      await rebuildDomainIndex(project, ctx)
      const root = await readFileRaw(`${project}/wiki/index.md`)
      expect(root).toContain("- Unassigned — 205 pages")
      expect(root.match(/^ {2}- \[\[loose-/gm)).toHaveLength(205)
      expect(root).not.toContain("more unassigned")
    })

    it("adds no extra line when exactly 200 pages are unassigned", async () => {
      for (let i = 0; i < 200; i += 1) {
        const slug = `loose-${String(i).padStart(3, "0")}`
        await addPage(`wiki/concepts/${slug}.md`, pageText({ type: "concept", title: slug }))
      }

      const text = await buildScopedIndexText(project, await load(), null)

      expect(text.match(/^ {2}- \[\[loose-/gm)).toHaveLength(200)
      expect(text).not.toContain("more unassigned")
    })

    it("has an empty mechanism index when a work wiki has no library path", async () => {
      await addSamplePages()
      const ctx = { ...(await load()), mechanismLibraryPath: null }

      const text = await buildScopedIndexText(project, ctx, null)

      expect(text).toContain("# Mechanisms\n")
      expect(text).not.toContain("[[event-driven-computing]]")
    })
  })

  describe("listMechanismSlugs", () => {
    it("returns the stems of the markdown files in wiki/mechanisms of the library", async () => {
      await addPage("wiki/mechanisms/event-driven-computing.md", "x")
      await addPage("wiki/mechanisms/事件驅動.md", "x")
      await addPage("wiki/mechanisms/notes.txt", "x")
      await addPage("wiki/mechanisms/archive/old.md", "x")

      const slugs = await listMechanismSlugs(project)

      expect([...slugs].sort()).toEqual(["event-driven-computing", "事件驅動"])
    })

    it("does not mind a trailing slash on the library path", async () => {
      await addPage("wiki/mechanisms/backpressure.md", "x")

      expect([...(await listMechanismSlugs(`${project}/`))]).toEqual(["backpressure"])
    })

    it("returns an empty set without a library path or without the folder", async () => {
      expect((await listMechanismSlugs(null)).size).toBe(0)
      expect((await listMechanismSlugs(`${tmp.path}/missing`)).size).toBe(0)
    })
  })
})
