import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { describe, it, expect } from "vitest"
import { defaultIdentity, parseWikiYaml, type WikiIdentity, type WikiParseResult } from "./wiki-identity"
import type { ConfigIssue } from "./types"

function valueOf(result: WikiParseResult): WikiIdentity {
  if (!result.ok) throw new Error(`expected ok, got ${JSON.stringify(result.issues)}`)
  return result.value
}

/** The paths of the issues of a file that is not valid. */
function pathsOf(result: WikiParseResult): string[] {
  if (result.ok) throw new Error("expected issues, got ok")
  return result.issues.map((issue: ConfigIssue) => issue.path)
}

/** The paths of the problems of a file that is valid: a threshold took its default (ruling M2 of the final review). */
function softPathsOf(result: WikiParseResult): string[] {
  if (!result.ok) throw new Error(`expected ok, got ${JSON.stringify(result.issues)}`)
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
      lint: { draft_days: 30, max_domain_pages: 200, min_domain_pages: 3, semantic_reminder_ingests: 10 },
    })
  })

  it("parses a valid reading wiki", () => {
    expect(valueOf(parseWikiYaml(build()))).toEqual({
      version: 1,
      id: "reading",
      role: "reading",
      mechanism_library: null,
      lint: { draft_days: 30, max_domain_pages: 200, min_domain_pages: 3, semantic_reminder_ingests: 10 },
    })
  })

  it("parses a valid work wiki", () => {
    const config = valueOf(parseWikiYaml(build({ id: "work", role: "work", library: "../reading-wiki" })))
    expect(config).toEqual({
      version: 1,
      id: "work",
      role: "work",
      mechanism_library: "../reading-wiki",
      lint: { draft_days: 30, max_domain_pages: 200, min_domain_pages: 3, semantic_reminder_ingests: 10 },
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
    const text = 'version: 3\nid: "Bad Id"\nrole: other\nmechanism_library: 7\nextra: {}\nlint:\n  draft_days: 0\n'
    expect(pathsOf(parseWikiYaml(text))).toEqual(["version", "extra", "id", "role", "mechanism_library", "lint.draft_days"])
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

  describe("lint thresholds", () => {
    const DEFAULTS = { draft_days: 30, max_domain_pages: 200, min_domain_pages: 3, semantic_reminder_ingests: 10 }

    it("gives the defaults when there is no lint block", () => {
      expect(valueOf(parseWikiYaml(build())).lint).toEqual(DEFAULTS)
    })

    it("gives the defaults for an empty lint block", () => {
      expect(valueOf(parseWikiYaml(build() + "lint:\n")).lint).toEqual(DEFAULTS)
      expect(valueOf(parseWikiYaml(build() + "lint: {}\n")).lint).toEqual(DEFAULTS)
    })

    it("reads the keys that the file sets and defaults the others", () => {
      const text = build() + "lint:\n  draft_days: 14\n  min_domain_pages: 5\n"
      expect(valueOf(parseWikiYaml(text)).lint).toEqual({ ...DEFAULTS, draft_days: 14, min_domain_pages: 5 })
    })

    it("reads all four keys", () => {
      const text =
        build() + "lint:\n  draft_days: 7\n  max_domain_pages: 50\n  min_domain_pages: 1\n  semantic_reminder_ingests: 4\n"
      expect(valueOf(parseWikiYaml(text)).lint).toEqual({
        draft_days: 7,
        max_domain_pages: 50,
        min_domain_pages: 1,
        semantic_reminder_ingests: 4,
      })
    })

    // A bad threshold does not make the file invalid. The key takes its default and the problem is reported, so
    // `id` and `role` stay usable and sync and ingest go on (final review, M2).
    it("takes the default for a value that is not a positive integer, and names the key", () => {
      for (const key of ["draft_days", "max_domain_pages", "min_domain_pages", "semantic_reminder_ingests"]) {
        for (const value of ["0", "-3", "1.5", '"10"', "null", "[10]", ".inf", "true"]) {
          const result = parseWikiYaml(build() + `lint:\n  ${key}: ${value}\n`)
          expect(softPathsOf(result), `${key}: ${value}`).toEqual([`lint.${key}`])
          expect(valueOf(result).lint, `${key}: ${value}`).toEqual(DEFAULTS)
          expect(result.issues[0].message).toContain("positive integer")
        }
      }
    })

    it("keeps id and role and the other thresholds when one threshold is bad", () => {
      const text = build({ id: "work", role: "work", library: "../reading" }) + "lint:\n  draft_days: 0\n  max_domain_pages: 50\n"
      const result = parseWikiYaml(text)
      expect(softPathsOf(result)).toEqual(["lint.draft_days"])
      expect(valueOf(result)).toEqual({
        version: 1,
        id: "work",
        role: "work",
        mechanism_library: "../reading",
        lint: { ...DEFAULTS, max_domain_pages: 50 },
      })
    })

    it("reports every bad key together, and each takes its default", () => {
      const text = build() + "lint:\n  draft_days: 0\n  max_domain_pages: x\n  min_domain_pages: 4\n"
      const result = parseWikiYaml(text)
      expect(softPathsOf(result)).toEqual(["lint.draft_days", "lint.max_domain_pages"])
      expect(valueOf(result).lint).toEqual({ ...DEFAULTS, min_domain_pages: 4 })
    })

    it("takes no problem for a file without a bad threshold", () => {
      expect(softPathsOf(parseWikiYaml(build() + "lint:\n  draft_days: 14\n"))).toEqual([])
    })

    it("reports an unknown key inside lint and goes on", () => {
      const result = parseWikiYaml(build() + "lint:\n  draft_day: 3\n  max_domain_pages: 50\n")
      expect(softPathsOf(result)).toEqual(["lint.draft_day"])
      expect(valueOf(result).lint).toEqual({ ...DEFAULTS, max_domain_pages: 50 })
    })

    it("takes the defaults for a lint block that is not a mapping", () => {
      for (const value of ["3", "[a]", '"text"']) {
        const result = parseWikiYaml(build() + `lint: ${value}\n`)
        expect(softPathsOf(result), value).toEqual(["lint"])
        expect(valueOf(result).lint, value).toEqual(DEFAULTS)
      }
    })

    it("takes both defaults for min_domain_pages greater than max_domain_pages and names the key of the file", () => {
      const result = parseWikiYaml(build() + "lint:\n  min_domain_pages: 10\n  max_domain_pages: 5\n")
      expect(softPathsOf(result)).toEqual(["lint.min_domain_pages"])
      expect(result.issues[0].message).toBe("min_domain_pages (10) must not be greater than max_domain_pages (5)")
      expect(valueOf(result).lint).toEqual(DEFAULTS)
    })

    it("compares min_domain_pages with the default max_domain_pages when only min is set", () => {
      const result = parseWikiYaml(build() + "lint:\n  min_domain_pages: 201\n")
      expect(softPathsOf(result)).toEqual(["lint.min_domain_pages"])
      expect(result.issues[0].message).toBe("min_domain_pages (201) must not be greater than max_domain_pages (200)")
      expect(valueOf(result).lint).toEqual(DEFAULTS)
    })

    it("compares max_domain_pages with the default min_domain_pages when only max is set", () => {
      const result = parseWikiYaml(build() + "lint:\n  max_domain_pages: 2\n")
      // The file sets max, so the issue points at max.
      expect(softPathsOf(result)).toEqual(["lint.max_domain_pages"])
      expect(result.issues[0].message).toBe("min_domain_pages (3) must not be greater than max_domain_pages (2)")
      expect(valueOf(result).lint).toEqual(DEFAULTS)
    })

    it("accepts min_domain_pages equal to max_domain_pages", () => {
      const text = build() + "lint:\n  min_domain_pages: 7\n  max_domain_pages: 7\n"
      expect(valueOf(parseWikiYaml(text)).lint).toMatchObject({ min_domain_pages: 7, max_domain_pages: 7 })
      expect(softPathsOf(parseWikiYaml(text))).toEqual([])
    })

    it("does not compare the two keys when one of them is not a positive integer", () => {
      const text = build() + "lint:\n  min_domain_pages: 10\n  max_domain_pages: 0\n"
      const result = parseWikiYaml(text)
      expect(softPathsOf(result)).toEqual(["lint.max_domain_pages"])
      expect(valueOf(result).lint).toEqual({ ...DEFAULTS, min_domain_pages: 10 })
    })

    it("still rejects the file when a field other than lint is wrong, and lists the lint problems with the others", () => {
      const result = parseWikiYaml(build({ role: "other" }) + "lint:\n  draft_days: 0\n")
      expect(pathsOf(result)).toEqual(["role", "lint.draft_days"])
    })

    it("accepts a lint block in a work wiki", () => {
      const text = build({ id: "work", role: "work", library: "../reading" }) + "lint:\n  draft_days: 60\n"
      expect(valueOf(parseWikiYaml(text)).lint.draft_days).toBe(60)
    })
  })
})

// Final review, M8: the app and the wiki-tool CLI share one default identity.
describe("defaultIdentity", () => {
  it("is a reading wiki with the id reading and the default thresholds", () => {
    expect(defaultIdentity()).toEqual({
      version: 1,
      id: "reading",
      role: "reading",
      mechanism_library: null,
      lint: { draft_days: 30, max_domain_pages: 200, min_domain_pages: 3, semantic_reminder_ingests: 10 },
    })
  })

  it("is what the template wiki.yaml gives", () => {
    expect(defaultIdentity()).toEqual(valueOf(parseWikiYaml(TEMPLATE)))
  })

  it("gives a new object each time, so a caller cannot change the default of another", () => {
    const first = defaultIdentity()
    first.lint.draft_days = 1
    expect(defaultIdentity().lint.draft_days).toBe(30)
  })
})
