/**
 * read-only.test.ts - which pages the editor shows read-only in a mechanism wiki.
 */
import { describe, expect, it } from "vitest"
import { READ_ONLY_NOTICE, isReadOnlyPage, isWikiPagePath } from "./read-only"

const PROJECT = "/home/example/my-wiki"

describe("READ_ONLY_NOTICE", () => {
  it("is the exact notice of the brief", () => {
    expect(READ_ONLY_NOTICE).toBe("此頁由 AI 維護。要修改，請在 Heptabase 寫一張想法卡片。")
  })
})

describe("isWikiPagePath", () => {
  it("is true for a file under wiki/", () => {
    expect(isWikiPagePath(PROJECT, `${PROJECT}/wiki/mechanisms/example.md`)).toBe(true)
    expect(isWikiPagePath(PROJECT, `${PROJECT}/wiki/log.md`)).toBe(true)
    expect(isWikiPagePath(PROJECT, `${PROJECT}/wiki/a/b/c/d.md`)).toBe(true)
  })

  it("is false for a file outside wiki/", () => {
    expect(isWikiPagePath(PROJECT, `${PROJECT}/raw/sources/example.md`)).toBe(false)
    expect(isWikiPagePath(PROJECT, `${PROJECT}/purpose.md`)).toBe(false)
    expect(isWikiPagePath(PROJECT, `${PROJECT}/schema/writing-rules.md`)).toBe(false)
    expect(isWikiPagePath(PROJECT, `${PROJECT}/lenses/ai.md`)).toBe(false)
  })

  it("is false for a folder whose name only starts with wiki", () => {
    expect(isWikiPagePath(PROJECT, `${PROJECT}/wiki-notes/example.md`)).toBe(false)
    expect(isWikiPagePath(PROJECT, `${PROJECT}/wikis/example.md`)).toBe(false)
  })

  it("is false for a wiki/ folder deeper in the tree", () => {
    expect(isWikiPagePath(PROJECT, `${PROJECT}/raw/wiki/example.md`)).toBe(false)
  })

  it("is false for the wiki/ folder itself and for a file of another project", () => {
    expect(isWikiPagePath(PROJECT, `${PROJECT}/wiki`)).toBe(false)
    expect(isWikiPagePath(PROJECT, `${PROJECT}/wiki/`)).toBe(false)
    expect(isWikiPagePath(PROJECT, "/home/example/other-wiki/wiki/example.md")).toBe(false)
    expect(isWikiPagePath(PROJECT, "/home/example/my-wiki-2/wiki/example.md")).toBe(false)
  })

  it("accepts backslashes, a trailing slash on the project, and doubled slashes", () => {
    expect(isWikiPagePath("C:\\Users\\example\\my-wiki", "C:\\Users\\example\\my-wiki\\wiki\\mechanisms\\example.md")).toBe(true)
    expect(isWikiPagePath("C:\\Users\\example\\my-wiki", "C:\\Users\\example\\my-wiki\\raw\\example.md")).toBe(false)
    expect(isWikiPagePath(`${PROJECT}/`, `${PROJECT}/wiki/example.md`)).toBe(true)
    expect(isWikiPagePath(PROJECT, `${PROJECT}//wiki//example.md`)).toBe(true)
  })

  it("ignores the case of a Windows drive and folder, like the file system does", () => {
    expect(isWikiPagePath("C:/Users/Example/my-wiki", "c:/users/example/my-wiki/wiki/example.md")).toBe(true)
  })

  it("applies . and .. segments before it decides", () => {
    expect(isWikiPagePath(PROJECT, `${PROJECT}/./wiki/./example.md`)).toBe(true)
    expect(isWikiPagePath(PROJECT, `${PROJECT}/wiki/../raw/example.md`)).toBe(false)
    expect(isWikiPagePath(PROJECT, `${PROJECT}/raw/../wiki/example.md`)).toBe(true)
    expect(isWikiPagePath(PROJECT, `${PROJECT}/wiki/../../other/wiki/example.md`)).toBe(false)
  })

  it("is false when there is no project or no file", () => {
    expect(isWikiPagePath("", `${PROJECT}/wiki/example.md`)).toBe(false)
    expect(isWikiPagePath(PROJECT, "")).toBe(false)
    expect(isWikiPagePath(null, `${PROJECT}/wiki/example.md`)).toBe(false)
    expect(isWikiPagePath(PROJECT, undefined)).toBe(false)
  })
})

describe("isReadOnlyPage", () => {
  const page = `${PROJECT}/wiki/mechanisms/example.md`

  it("is read-only in a mechanism wiki", () => {
    expect(isReadOnlyPage(PROJECT, page, true)).toBe(true)
  })

  it("stays read-only while the check runs, so a quick click cannot start an edit", () => {
    expect(isReadOnlyPage(PROJECT, page, null)).toBe(true)
  })

  it("is editable in a project that is not a mechanism wiki", () => {
    expect(isReadOnlyPage(PROJECT, page, false)).toBe(false)
  })

  it("is editable outside wiki/ at once, without waiting for the check", () => {
    for (const mechanism of [true, false, null]) {
      expect(isReadOnlyPage(PROJECT, `${PROJECT}/raw/sources/example.md`, mechanism), String(mechanism)).toBe(false)
      expect(isReadOnlyPage(PROJECT, `${PROJECT}/purpose.md`, mechanism), String(mechanism)).toBe(false)
    }
  })

  it("is editable when the project or the file is unknown", () => {
    expect(isReadOnlyPage(null, page, true)).toBe(false)
    expect(isReadOnlyPage(PROJECT, undefined, true)).toBe(false)
  })
})
