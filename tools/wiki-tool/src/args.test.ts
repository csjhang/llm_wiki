/**
 * args.test.ts - tests for the option parser shared by the wiki-tool commands.
 */
import { describe, expect, it } from "vitest"
import { parseArgs, parseNowOption } from "./args"

const SPEC = { values: ["project", "database"], lists: ["root"], flags: ["force"] } as const

describe("parseArgs", () => {
  it("reads values, repeated options, and flags", () => {
    const { parsed, problems } = parseArgs(
      ["--project", "/p", "--root", "a", "--force", "--root", "b", "--database", "d.json"],
      SPEC,
    )
    expect(problems).toEqual([])
    expect(parsed.values).toEqual({ project: "/p", database: "d.json" })
    expect(parsed.lists).toEqual({ root: ["a", "b"] })
    expect(parsed.flags).toEqual({ force: true })
  })

  it("gives an empty list and a false flag for an option that is absent", () => {
    const { parsed, problems } = parseArgs([], SPEC)
    expect(problems).toEqual([])
    expect(parsed.values).toEqual({})
    expect(parsed.lists).toEqual({ root: [] })
    expect(parsed.flags).toEqual({ force: false })
  })

  it("reports an unknown option, a stray argument, and a repeated single option", () => {
    const { problems } = parseArgs(["--nope", "x", "stray", "--project", "a", "--project", "b"], SPEC)
    expect(problems).toEqual([
      "unknown option: --nope",
      "unexpected argument: stray",
      "option given more than once: --project",
    ])
  })

  it("reports an option without a value", () => {
    expect(parseArgs(["--project"], SPEC).problems).toEqual(["missing value for --project"])
    expect(parseArgs(["--project", "--force"], SPEC).problems).toEqual(["missing value for --project"])
    expect(parseArgs(["--root"], SPEC).problems).toEqual(["missing value for --root"])
  })

  it("does not find options through the prototype chain", () => {
    expect(parseArgs(["--constructor", "x"], SPEC).problems).toEqual(["unknown option: --constructor"])
  })
})

describe("parseNowOption", () => {
  it("reads the clock when the option is not given", () => {
    const problems: string[] = []
    const before = Date.now()
    const now = parseNowOption(undefined, problems)
    expect(problems).toEqual([])
    expect(now?.getTime()).toBeGreaterThanOrEqual(before)
    expect(now?.getTime()).toBeLessThanOrEqual(Date.now())
  })

  it("reads an ISO date and time", () => {
    const problems: string[] = []
    expect(parseNowOption("2026-10-24T08:00:00Z", problems)?.toISOString()).toBe("2026-10-24T08:00:00.000Z")
    expect(parseNowOption("2026-10-24T08:00:00+08:00", problems)?.toISOString()).toBe("2026-10-24T00:00:00.000Z")
    expect(problems).toEqual([])
  })

  it("reports anything else", () => {
    for (const value of ["yesterday", "", "10/24/2026", "2026-13-45T00:00:00Z"]) {
      const problems: string[] = []
      expect(parseNowOption(value, problems)).toBeNull()
      expect(problems).toEqual([expect.stringContaining("--now must be an ISO date and time")])
    }
  })
})
