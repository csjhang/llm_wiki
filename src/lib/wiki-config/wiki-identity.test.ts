import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { describe, it, expect } from "vitest"
import { parseWikiYaml } from "./wiki-identity"
import type { ConfigIssue, ParseResult } from "./types"

function valueOf<T>(result: ParseResult<T>): T {
  if (!result.ok) throw new Error(`expected ok, got ${JSON.stringify(result.issues)}`)
  return result.value
}

function pathsOf<T>(result: ParseResult<T>): string[] {
  if (result.ok) throw new Error("expected issues, got ok")
  return result.issues.map((issue: ConfigIssue) => issue.path)
}

const TEMPLATE = readFileSync(
  fileURLToPath(new URL("../../../templates/mechanism-wiki/wiki.yaml", import.meta.url)),
  "utf8",
)

/** A minimal valid reading wiki file; each test overrides one part. */
function build(parts: { id?: string; role?: string; library?: string | null } = {}): string {
  const lines = ["version: 1", `id: ${parts.id ?? "reading"}`, `role: ${parts.role ?? "reading"}`]
  if (parts.library !== null) lines.push(`mechanism_library: ${parts.library ?? "null"}`)
  return `${lines.join("\n")}\n`
}

describe("parseWikiYaml", () => {
  it("parses the template wiki.yaml", () => {
    expect(valueOf(parseWikiYaml(TEMPLATE))).toEqual({
      version: 1,
      id: "reading",
      role: "reading",
      mechanism_library: null,
    })
  })

  it("parses a valid reading wiki", () => {
    expect(valueOf(parseWikiYaml(build()))).toEqual({
      version: 1,
      id: "reading",
      role: "reading",
      mechanism_library: null,
    })
  })

  it("parses a valid work wiki", () => {
    const config = valueOf(parseWikiYaml(build({ id: "work", role: "work", library: "../reading-wiki" })))
    expect(config).toEqual({
      version: 1,
      id: "work",
      role: "work",
      mechanism_library: "../reading-wiki",
    })
  })

  it("defaults a missing mechanism_library to null for a reading wiki", () => {
    expect(valueOf(parseWikiYaml(build({ library: null }))).mechanism_library).toBeNull()
  })

  it("rejects a work wiki without a mechanism library", () => {
    for (const library of ["null", '""', '"   "', "42", "[a]"]) {
      const result = parseWikiYaml(build({ role: "work", library }))
      expect(pathsOf(result), library).toEqual(["mechanism_library"])
    }
    expect(pathsOf(parseWikiYaml(build({ role: "work", library: null })))).toEqual(["mechanism_library"])
  })

  it("rejects a reading wiki that has a mechanism library", () => {
    const result = parseWikiYaml(build({ library: "../other" }))
    expect(pathsOf(result)).toEqual(["mechanism_library"])
    if (result.ok) throw new Error("expected issues")
    expect(result.issues[0].message).toContain("reading")
  })

  it("rejects a mechanism_library that is neither null nor a string, whatever the role", () => {
    expect(pathsOf(parseWikiYaml(build({ library: "42" })))).toEqual(["mechanism_library"])
    expect(pathsOf(parseWikiYaml(build({ role: "bogus", library: "42" })))).toEqual(["role", "mechanism_library"])
  })

  it("rejects bad ids", () => {
    // A bare 123 is a number in YAML, not a string, so it fails too.
    for (const id of ['"Reading Wiki"', "Reading", '"a_b"', '""', "123", '"-a"', '"a--b"']) {
      expect(pathsOf(parseWikiYaml(build({ id }))), id).toEqual(["id"])
    }
  })

  it("accepts slug ids", () => {
    for (const id of ["reading", "work", "my-research-2", "2026"]) {
      // A bare 2026 is a number, so quote every id here.
      expect(valueOf(parseWikiYaml(build({ id: `"${id}"` }))).id).toBe(id)
    }
  })

  it("requires id and role", () => {
    expect(pathsOf(parseWikiYaml("version: 1\n"))).toEqual(["id", "role"])
  })

  it("rejects an unknown or non-string role", () => {
    for (const role of ["library", "Reading", '""', "1", "[reading]"]) {
      expect(pathsOf(parseWikiYaml(build({ role }))), role).toEqual(["role"])
    }
  })

  it("rejects wrong version and unknown keys", () => {
    const text = build().replace("version: 1", "version: 2") + "extra: 1\nwiki_id: reading\n"
    expect(pathsOf(parseWikiYaml(text))).toEqual(["version", "extra", "wiki_id"])
  })

  it("reports every problem together", () => {
    const text = 'version: 3\nid: "Bad Id"\nrole: other\nmechanism_library: 7\nlint: {}\n'
    expect(pathsOf(parseWikiYaml(text))).toEqual(["version", "lint", "id", "role", "mechanism_library"])
  })

  it("reports duplicate keys", () => {
    const result = parseWikiYaml(build() + "id: work\n")
    if (result.ok) throw new Error("expected issues")
    expect(result.issues).toHaveLength(1)
    expect(result.issues[0].path).toBe("")
    expect(result.issues[0].message).toContain("id")
    expect(result.issues[0].message).toMatch(/duplicate/i)
  })

  it("reports YAML syntax errors and non-mapping files", () => {
    for (const text of ["id: [unclosed\n", "", "- a\n"]) {
      expect(pathsOf(parseWikiYaml(text)), JSON.stringify(text)).toEqual([""])
    }
  })
})
