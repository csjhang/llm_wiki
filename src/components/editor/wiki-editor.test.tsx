/**
 * wiki-editor.test.tsx - the editor opens the pages of a mechanism wiki read-only.
 *
 * The editor renders to static markup: the tests need no DOM. The check "is this project a
 * mechanism wiki" is a hook with an effect, so the tests replace it with a fixed answer.
 */
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { beforeEach, describe, expect, it, vi } from "vitest"

const mechanismAnswer = vi.hoisted(() => ({ value: true as boolean | null }))
vi.mock("@/hooks/use-mechanism-wiki", () => ({ useMechanismWiki: () => mechanismAnswer.value }))

import i18n from "@/i18n"
import { useWikiStore } from "@/stores/wiki-store"
import { READ_ONLY_NOTICE } from "@/lib/mechanism-wiki/read-only"
import type { WikiProject } from "@/types/wiki"
import { WikiEditor } from "./wiki-editor"

/**
 * Sets the open project. A static render reads the initial state of a zustand store (React's server
 * snapshot), not the current state, so the initial state object gets the project too.
 */
function setProject(project: WikiProject | null): void {
  Object.assign(useWikiStore.getInitialState(), { project })
  useWikiStore.setState({ project })
}

const PROJECT_PATH = "/home/example/my-wiki"
const PAGE = `---\ntype: mechanism\ntitle: Example\n---\n\n# Example\n\nBody text of the page.\n`

function render(filePath: string | undefined): string {
  return renderToStaticMarkup(createElement(WikiEditor, { content: PAGE, onSave: () => {}, filePath }))
}

/** The edit button has this marker. The page links button is always there. */
const EDIT_BUTTON = 'data-action="edit-toggle"'
const NOTICE = "data-read-only-notice"

describe("WikiEditor in a mechanism wiki", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en")
    mechanismAnswer.value = true
    setProject({ id: "p1", name: "my-wiki", path: PROJECT_PATH })
  })

  it("opens a page under wiki/ read-only: the notice, the text, and no edit button", () => {
    const html = render(`${PROJECT_PATH}/wiki/mechanisms/example.md`)

    expect(html).toContain(NOTICE)
    expect(html).toContain(READ_ONLY_NOTICE)
    expect(html).toContain("Body text of the page.")
    expect(html).not.toContain(EDIT_BUTTON)
    expect(html).not.toContain("<textarea")
  })

  it("shows the notice as one line of text", () => {
    const html = render(`${PROJECT_PATH}/wiki/log.md`)

    const notice = /<[^>]*data-read-only-notice[^>]*>([\s\S]*?)<\/div>/.exec(html)
    expect(notice).not.toBeNull()
    const text = notice![1].replace(/<[^>]+>/g, "").trim()
    expect(text).toBe(READ_ONLY_NOTICE)
  })

  it("keeps a page outside wiki/ editable, without a notice", () => {
    for (const path of [`${PROJECT_PATH}/raw/sources/example.md`, `${PROJECT_PATH}/purpose.md`]) {
      const html = render(path)
      expect(html, path).toContain(EDIT_BUTTON)
      expect(html, path).not.toContain(NOTICE)
      expect(html, path).not.toContain(READ_ONLY_NOTICE)
    }
  })

  it("shows the same notice in every UI language", async () => {
    for (const language of ["en", "it", "ru", "zh"]) {
      await i18n.changeLanguage(language)
      expect(render(`${PROJECT_PATH}/wiki/mechanisms/example.md`), language).toContain(READ_ONLY_NOTICE)
    }
  })
})

describe("WikiEditor in a plain wiki", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en")
    mechanismAnswer.value = false
    setProject({ id: "p1", name: "my-wiki", path: PROJECT_PATH })
  })

  it("keeps a page under wiki/ editable, without a notice", () => {
    const html = render(`${PROJECT_PATH}/wiki/concepts/example.md`)

    expect(html).toContain(EDIT_BUTTON)
    expect(html).not.toContain(NOTICE)
    expect(html).not.toContain(READ_ONLY_NOTICE)
  })
})

describe("WikiEditor while the check runs", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en")
    mechanismAnswer.value = null
    setProject({ id: "p1", name: "my-wiki", path: PROJECT_PATH })
  })

  it("offers no edit under wiki/ yet, and shows no notice that a plain wiki would have to take back", () => {
    const html = render(`${PROJECT_PATH}/wiki/concepts/example.md`)

    expect(html).not.toContain(EDIT_BUTTON)
    expect(html).not.toContain(NOTICE)
  })

  it("offers the edit at once outside wiki/", () => {
    expect(render(`${PROJECT_PATH}/raw/sources/example.md`)).toContain(EDIT_BUTTON)
  })
})

describe("WikiEditor without a project", () => {
  it("keeps the page editable", () => {
    mechanismAnswer.value = true
    setProject(null)

    const html = render(`${PROJECT_PATH}/wiki/mechanisms/example.md`)

    expect(html).toContain(EDIT_BUTTON)
    expect(html).not.toContain(NOTICE)
  })
})
