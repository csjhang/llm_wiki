/**
 * Where a finished deep research page goes. A mechanism wiki (a project with `domains.yaml`) keeps it
 * in `.llm-wiki/research-staging/` and asks for approval in a `research-result` review item. Every
 * other wiki gets the page in `wiki/queries/` at once, as upstream does.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createTempProject, fileExists, readFileRaw, realFs, writeFileRaw } from "@/test-helpers/fs-temp"
import { useReviewStore } from "@/stores/review-store"
import { useWikiStore } from "@/stores/wiki-store"

vi.mock("@/commands/fs", () => realFs)

import { saveResearchPage } from "./deep-research"

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

let project = ""
let cleanup: () => Promise<void> = async () => {}

beforeEach(async () => {
  const temp = await createTempProject("deep-research-staging")
  project = temp.path
  cleanup = temp.cleanup
  useReviewStore.setState({ items: [] })
  useWikiStore.setState({ project: { id: "p1", name: "wiki", path: project } })
})

afterEach(async () => {
  useReviewStore.setState({ items: [] })
  useWikiStore.setState({ project: null })
  await cleanup()
})

describe("saveResearchPage", () => {
  it("deep research stages in a mechanism wiki and writes directly otherwise", async () => {
    // A mechanism wiki: staged, with a review item, and nothing in wiki/queries.
    await writeFileRaw(`${project}/domains.yaml`, "version: 1\ndomains: {}\n")

    const staged = await saveResearchPage(project, FILE, PAGE)

    expect(staged.staged).toBe(true)
    expect(staged.savedPath).toBe(`.llm-wiki/research-staging/${FILE}`)
    expect(staged.filePath).toBe(`${project}/.llm-wiki/research-staging/${FILE}`)
    expect(await readFileRaw(staged.filePath)).toBe(PAGE)
    expect(await fileExists(`${project}/wiki/queries/${FILE}`)).toBe(false)
    const items = useReviewStore.getState().items
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({
      type: "research-result",
      resolved: false,
      sourcePath: staged.savedPath,
      affectedPages: [`wiki/queries/${FILE}`],
    })
    expect(items[0].options.map((option) => option.action)).toContain("mech:accept-research")

    // A plain wiki: written to wiki/queries at once, and no review item.
    useReviewStore.setState({ items: [] })
    const plain = await createTempProject("deep-research-plain")
    try {
      useWikiStore.setState({ project: { id: "p2", name: "plain", path: plain.path } })

      const direct = await saveResearchPage(plain.path, FILE, PAGE)

      expect(direct.staged).toBe(false)
      expect(direct.savedPath).toBe(`wiki/queries/${FILE}`)
      expect(direct.filePath).toBe(`${plain.path}/wiki/queries/${FILE}`)
      expect(await readFileRaw(direct.filePath)).toBe(PAGE)
      expect(await fileExists(`${plain.path}/.llm-wiki/research-staging`)).toBe(false)
      expect(useReviewStore.getState().items).toEqual([])
    } finally {
      await plain.cleanup()
    }
  })

  it("keeps the numbered file name in a plain wiki", async () => {
    await writeFileRaw(`${project}/wiki/queries/${FILE}`, "An earlier page.\n")

    const saved = await saveResearchPage(project, FILE, PAGE)

    expect(saved.savedPath).toBe(`wiki/queries/${FILE.replace(/\.md$/, "-2.md")}`)
    expect(await readFileRaw(`${project}/wiki/queries/${FILE}`)).toBe("An earlier page.\n")
  })

  it("stages two results with the same file name as two review items", async () => {
    await writeFileRaw(`${project}/domains.yaml`, "version: 1\ndomains: {}\n")

    const first = await saveResearchPage(project, FILE, "first\n")
    const second = await saveResearchPage(project, FILE, "second\n")

    expect(second.savedPath).not.toBe(first.savedPath)
    expect(useReviewStore.getState().items).toHaveLength(2)
    expect(await readFileRaw(first.filePath)).toBe("first\n")
    expect(await readFileRaw(second.filePath)).toBe("second\n")
  })

  it("leaves the review list alone when the project is no longer open", async () => {
    await writeFileRaw(`${project}/domains.yaml`, "version: 1\ndomains: {}\n")
    useWikiStore.setState({ project: { id: "p9", name: "other", path: `${project}-other` } })

    const staged = await saveResearchPage(project, FILE, PAGE)

    expect(await fileExists(staged.filePath)).toBe(true)
    expect(useReviewStore.getState().items).toEqual([])
  })
})
