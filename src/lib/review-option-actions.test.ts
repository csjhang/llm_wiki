/**
 * review-option-actions.test.ts - which actions a review option may carry (ruling S17), and where the view may delete.
 *
 * The same rule is in three places: this module (the app), `review_action_allowed` in `src-tauri/src/api_server.rs`
 * (the API route), and `isAllowedReviewAction` in `mcp-server/src/review-tools.ts` (the MCP tool). The parity tests
 * read the other two files, so a change in one place fails until the others follow.
 */
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { describe, expect, it, vi } from "vitest"
import {
  API_MECHANISM_ACTIONS,
  DISMISSAL_ACTION_WORDS,
  deleteReviewTarget,
  isAllowedApiReviewAction,
  isDismissalAction,
  resolveDeletePath,
} from "./review-option-actions"

function read(relative: string): string {
  return readFileSync(fileURLToPath(new URL(`../../${relative}`, import.meta.url)), "utf8")
}

describe("isDismissalAction", () => {
  it("takes the words of the old view, in any letter case", () => {
    for (const word of ["skip", "Skip", "DISMISS", "Ignore", "跳过", "忽略", "approve", "Keep Existing", "no", "No"]) {
      expect(isDismissalAction(word), word).toBe(true)
    }
  })

  it("takes no other text", () => {
    for (const text of ["", "skip it", "Create page X", "delete:/x", "open", "mech:start-fusion", " skip"]) {
      expect(isDismissalAction(text), text).toBe(false)
    }
  })
})

describe("isAllowedApiReviewAction", () => {
  it("allows the dismissal words, the three mech actions, and open:wiki paths", () => {
    for (const action of [
      "Skip", "dismiss", "Keep existing", "跳过",
      "mech:propose-mechanism", "mech:start-fusion", "mech:dismiss-fusion",
      "open:wiki/mechanisms/attention.md", "open:wiki/a b/c.md",
    ]) {
      expect(isAllowedApiReviewAction(action), action).toBe(true)
    }
  })

  it("refuses an action that deletes, writes, researches, or creates", () => {
    for (const action of [
      "delete:/home/user", "delete:wiki/a.md", "save:SGVsbG8=", "__deep_research__", "__create_page__:Attention",
      "mech:replace-source", "mech:approve-domain", "mech:accept-research", "mech:unknown",
      "Create page X", "research attention", "open", "view page",
    ]) {
      expect(isAllowedApiReviewAction(action), action).toBe(false)
    }
  })

  it("refuses an open: path outside wiki/", () => {
    for (const action of [
      "open:../x", "open:/etc/x", "open:raw/x", "open:wiki/../raw/x", "open:wiki/..", "open:wiki\\a.md",
      "open:C:/x", "open:C:\\x", "open:", "open:wiki/", "open:Wiki/a.md",
    ]) {
      expect(isAllowedApiReviewAction(action), action).toBe(false)
    }
  })

  it("keeps API mechanism actions to the three that write no file by themselves", () => {
    expect([...API_MECHANISM_ACTIONS]).toEqual(["mech:propose-mechanism", "mech:start-fusion", "mech:dismiss-fusion"])
  })
})

describe("the three copies of the rule", () => {
  const quoted = (text: string): string[] => [...text.matchAll(/"([^"]+)"/g)].map((match) => match[1])

  function rustList(name: string): string[] {
    const source = read("src-tauri/src/api_server.rs")
    const start = source.indexOf(`const ${name}`)
    expect(start, name).toBeGreaterThan(-1)
    return quoted(source.slice(source.indexOf("&[", start), source.indexOf("];", start)))
  }

  function mcpList(name: string): string[] {
    const source = read("mcp-server/src/review-tools.ts")
    const start = source.indexOf(`export const ${name}`)
    expect(start, name).toBeGreaterThan(-1)
    return quoted(source.slice(source.indexOf("[", start), source.indexOf("] as const", start)))
  }

  it("has the same dismissal words in the API route and the MCP tool", () => {
    expect(rustList("DISMISSAL_ACTION_WORDS")).toEqual([...DISMISSAL_ACTION_WORDS])
    expect(mcpList("DISMISSAL_ACTION_WORDS")).toEqual([...DISMISSAL_ACTION_WORDS])
  })

  it("has the same mech actions in the API route and the MCP tool", () => {
    expect(rustList("API_MECHANISM_ACTIONS")).toEqual([...API_MECHANISM_ACTIONS])
    expect(mcpList("MECHANISM_ACTIONS")).toEqual([...API_MECHANISM_ACTIONS])
  })

  it("has the view use this module for a dismissal, with no list of its own", () => {
    const view = read("src/components/review/review-view.tsx")
    expect(view).toContain('from "@/lib/review-option-actions"')
    expect(view).not.toMatch(/lower === "keep existing"/)
  })

  it("has the delete: branch of the view go through deleteReviewTarget, never straight to deleteFile", () => {
    const view = read("src/components/review/review-view.tsx")
    expect(view).toContain("deleteReviewTarget(pp, action.slice(7), deleteFile)")
    expect(view).not.toMatch(/await deleteFile\(/)
  })
})

describe("resolveDeletePath", () => {
  const project = "/home/user/proj"

  it("takes a file inside <project>/wiki/", () => {
    expect(resolveDeletePath(project, `${project}/wiki/concepts/a.md`)).toBe(`${project}/wiki/concepts/a.md`)
    expect(resolveDeletePath(`${project}/`, `${project}/wiki/a.md`)).toBe(`${project}/wiki/a.md`)
  })

  it("takes a Windows path with backslashes and any letter case of the drive", () => {
    const windows = "C:\\Users\\Me\\proj"
    expect(resolveDeletePath(windows, "C:\\Users\\Me\\proj\\wiki\\a.md")).toBe("C:/Users/Me/proj/wiki/a.md")
    expect(resolveDeletePath(windows, "c:/users/me/proj/wiki/a.md")).toBe("c:/users/me/proj/wiki/a.md")
  })

  it("refuses a path outside wiki/", () => {
    for (const path of [
      "/home/user",
      "/",
      project,
      `${project}/`,
      `${project}/wiki`,
      `${project}/wiki/`,
      `${project}/raw/sources/a.md`,
      `${project}/.llm-wiki/review.json`,
      `${project}-other/wiki/a.md`,
      `${project}/wikis/a.md`,
      "/etc/passwd",
      "wiki/a.md",
      "a.md",
      "",
    ]) {
      expect(() => resolveDeletePath(project, path), path).toThrow(/inside .*wiki/)
    }
  })

  it("refuses a .. segment, however it is written", () => {
    for (const path of [
      `${project}/wiki/../raw/a.md`,
      `${project}/wiki/../../x`,
      `${project}/wiki/sub/../../raw/a.md`,
      `${project}/wiki/..`,
      `${project}\\wiki\\..\\raw\\a.md`,
    ]) {
      expect(() => resolveDeletePath(project, path), path).toThrow(/inside .*wiki/)
    }
  })

  it("refuses everything when there is no project path", () => {
    expect(() => resolveDeletePath("", "/wiki/a.md")).toThrow(/inside .*wiki/)
  })
})

describe("deleteReviewTarget", () => {
  const project = "/home/user/proj"

  it("deletes a file inside wiki/ once", async () => {
    const remove = vi.fn(async (_path: string) => {})
    await deleteReviewTarget(project, `${project}/wiki/a.md`, remove)
    expect(remove).toHaveBeenCalledTimes(1)
    expect(remove).toHaveBeenCalledWith(`${project}/wiki/a.md`)
  })

  it("refuses a path outside wiki/ and deletes nothing", async () => {
    const remove = vi.fn(async (_path: string) => {})
    for (const path of ["/home/user", project, `${project}/raw/a.md`, `${project}/wiki/../raw/a.md`]) {
      await expect(deleteReviewTarget(project, path, remove), path).rejects.toThrow(/inside .*wiki/)
    }
    expect(remove).not.toHaveBeenCalled()
  })
})
