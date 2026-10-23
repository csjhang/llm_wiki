import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { describe, it, expect } from "vitest"
import {
  OPTIONAL_PROPERTY_KEYS,
  REQUIRED_PROPERTY_KEYS,
  parseHeptabaseYaml,
} from "./heptabase-config"
import type { ConfigIssue, ParseResult } from "./types"

const id = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`

function valueOf<T>(result: ParseResult<T>): T {
  if (!result.ok) throw new Error(`expected ok, got ${JSON.stringify(result.issues)}`)
  return result.value
}

function pathsOf<T>(result: ParseResult<T>): string[] {
  if (result.ok) throw new Error("expected issues, got ok")
  return result.issues.map((issue: ConfigIssue) => issue.path)
}

const EXAMPLE = readFileSync(
  fileURLToPath(new URL("../../../templates/mechanism-wiki/heptabase.example.yaml", import.meta.url)),
  "utf8",
)

/** A minimal valid file; each test overrides one part. */
function build(
  parts: { wikiId?: string; library?: string; roots?: string; whiteboards?: string; tags?: string; properties?: string } = {},
): string {
  return `version: 1
wiki_id: ${parts.wikiId ?? "reading"}
mechanism_library: ${parts.library ?? "null"}
roots:
${parts.roots ?? `  - ${id(1)}`}
whiteboards:
${parts.whiteboards ?? `  ${id(2)}: { kind: topic }`}
tags:
${parts.tags ?? `  ingest: ${id(6)}\n  mirror: ${id(7)}`}
properties:
${
  parts.properties ??
  `  domain: ${id(8)}\n  page_type: ${id(9)}\n  wiki: ${id(10)}\n  status: ${id(11)}`
}
`
}

describe("parseHeptabaseYaml", () => {
  it("parses the template example", () => {
    const config = valueOf(parseHeptabaseYaml(EXAMPLE))
    expect(config.version).toBe(1)
    expect(config.wiki_id).toBe("reading")
    expect(config.mechanism_library).toBeNull()
    expect(config.roots).toEqual([id(1)])
    expect(config.whiteboards).toEqual({
      [id(2)]: { kind: "topic", auto_ingest: false },
      [id(3)]: { kind: "source", auto_ingest: false },
      [id(4)]: { kind: "project", auto_ingest: false },
      [id(5)]: { kind: "archive", auto_ingest: false },
    })
    expect(config.tags).toEqual({ ingest: id(6), mirror: id(7) })
    expect(Object.keys(config.properties).sort()).toEqual(
      [...REQUIRED_PROPERTY_KEYS, ...OPTIONAL_PROPERTY_KEYS].sort(),
    )
    expect(config.properties.status).toBe(id(11))
    expect(config.properties.strength).toBe(id(15))
  })

  it("accepts only the four required properties", () => {
    const config = valueOf(parseHeptabaseYaml(build()))
    expect(Object.keys(config.properties).sort()).toEqual([...REQUIRED_PROPERTY_KEYS].sort())
  })

  it("requires required properties", () => {
    const properties = `  domain: ${id(8)}\n  page_type: ${id(9)}\n  wiki: ${id(10)}`
    expect(pathsOf(parseHeptabaseYaml(build({ properties })))).toEqual(["properties.status"])
  })

  it("rejects unknown property keys", () => {
    const properties = `  domain: ${id(8)}\n  page_type: ${id(9)}\n  wiki: ${id(10)}\n  status: ${id(11)}\n  color: ${id(12)}`
    expect(pathsOf(parseHeptabaseYaml(build({ properties })))).toEqual(["properties.color"])
  })

  it("rejects auto_ingest on non-source whiteboards", () => {
    for (const kind of ["topic", "project", "archive"]) {
      const whiteboards = `  ${id(2)}: { kind: ${kind}, auto_ingest: true }`
      expect(pathsOf(parseHeptabaseYaml(build({ whiteboards }))), kind).toEqual([
        `whiteboards.${id(2)}.auto_ingest`,
      ])
    }
  })

  it("accepts auto_ingest true on a source whiteboard", () => {
    const whiteboards = `  ${id(2)}: { kind: source, auto_ingest: true }`
    const config = valueOf(parseHeptabaseYaml(build({ whiteboards })))
    expect(config.whiteboards[id(2)]).toEqual({ kind: "source", auto_ingest: true })
  })

  it("defaults auto_ingest to false", () => {
    const whiteboards = `  ${id(2)}: { kind: source }`
    const config = valueOf(parseHeptabaseYaml(build({ whiteboards })))
    expect(config.whiteboards[id(2)].auto_ingest).toBe(false)
  })

  it("rejects an unknown whiteboard kind, a missing kind, and unknown whiteboard keys", () => {
    const whiteboards = [
      `  ${id(2)}: { kind: inbox }`,
      `  ${id(3)}: { auto_ingest: false }`,
      `  ${id(4)}: { kind: topic, color: red }`,
      `  ${id(5)}: { kind: source, auto_ingest: "yes" }`,
    ].join("\n")
    expect(pathsOf(parseHeptabaseYaml(build({ whiteboards })))).toEqual([
      `whiteboards.${id(2)}.kind`,
      `whiteboards.${id(3)}.kind`,
      `whiteboards.${id(4)}.color`,
      `whiteboards.${id(5)}.auto_ingest`,
    ])
  })

  it("treats empty whiteboards as none", () => {
    const text = build().replace(`  ${id(2)}: { kind: topic }\n`, "")
    expect(valueOf(parseHeptabaseYaml(text)).whiteboards).toEqual({})
  })

  it("rejects bad wiki_id", () => {
    // A bare 123 is a number in YAML, not a string, so it fails too.
    for (const wikiId of ['"Reading Wiki"', "Reading", '"a_b"', '""', "123"]) {
      expect(pathsOf(parseHeptabaseYaml(build({ wikiId }))), wikiId).toEqual(["wiki_id"])
    }
  })

  it("accepts slug wiki ids", () => {
    for (const wikiId of ["reading", "work", "my-research-2"]) {
      expect(valueOf(parseHeptabaseYaml(build({ wikiId }))).wiki_id).toBe(wikiId)
    }
  })

  it("requires at least one root", () => {
    const text = build().replace(`roots:\n  - ${id(1)}`, "roots: []")
    expect(pathsOf(parseHeptabaseYaml(text))).toEqual(["roots"])
  })

  it("requires roots to be a list", () => {
    const text = build().replace(`roots:\n  - ${id(1)}`, `roots: ${id(1)}`)
    expect(pathsOf(parseHeptabaseYaml(text))).toEqual(["roots"])
  })

  it("requires UUIDs", () => {
    const result = parseHeptabaseYaml(
      build({
        roots: "  - not-a-uuid",
        whiteboards: "  board-one: { kind: topic }",
        tags: `  ingest: ${id(6)}\n  mirror: tag-two`,
        properties: `  domain: ${id(8)}\n  page_type: ${id(9)}\n  wiki: ${id(10)}\n  status: prop-four`,
      }),
    )
    expect(pathsOf(result)).toEqual([
      "roots[0]",
      "whiteboards.board-one",
      "tags.mirror",
      "properties.status",
    ])
  })

  it("rejects uppercase UUIDs", () => {
    const upper = "AAAAAAAA-0000-4000-8000-000000000001"
    const tags = `  ingest: ${upper}\n  mirror: ${id(7)}`
    expect(pathsOf(parseHeptabaseYaml(build({ tags })))).toEqual(["tags.ingest"])
  })

  it("requires both tags", () => {
    expect(pathsOf(parseHeptabaseYaml(build({ tags: `  ingest: ${id(6)}` })))).toEqual(["tags.mirror"])
    const noTags = build().replace(/tags:\n {2}ingest: .*\n {2}mirror: .*\n/, "")
    expect(pathsOf(parseHeptabaseYaml(noTags))).toEqual(["tags"])
  })

  it("rejects unknown tag keys", () => {
    const tags = `  ingest: ${id(6)}\n  mirror: ${id(7)}\n  extra: ${id(8)}`
    expect(pathsOf(parseHeptabaseYaml(build({ tags })))).toEqual(["tags.extra"])
  })

  it("accepts null mechanism_library and a string path", () => {
    expect(valueOf(parseHeptabaseYaml(build({ library: "null" }))).mechanism_library).toBeNull()
    expect(valueOf(parseHeptabaseYaml(build({ library: "../reading-wiki" }))).mechanism_library).toBe(
      "../reading-wiki",
    )
  })

  it("defaults a missing mechanism_library to null", () => {
    const text = build().replace("mechanism_library: null\n", "")
    expect(valueOf(parseHeptabaseYaml(text)).mechanism_library).toBeNull()
  })

  it("rejects an empty or non-string mechanism_library", () => {
    for (const library of ['""', "42", "[a]"]) {
      expect(pathsOf(parseHeptabaseYaml(build({ library }))), library).toEqual(["mechanism_library"])
    }
  })

  it("rejects wrong version and unknown top-level keys", () => {
    const text = build().replace("version: 1", "version: 2") + "extra: 1\n"
    expect(pathsOf(parseHeptabaseYaml(text))).toEqual(["version", "extra"])
  })

  it("reports every missing section", () => {
    expect(pathsOf(parseHeptabaseYaml("version: 1\n"))).toEqual([
      "wiki_id",
      "roots",
      "tags",
      "properties",
    ])
  })

  it("reports duplicate keys", () => {
    const text = build() + `wiki_id: work\n`
    const result = parseHeptabaseYaml(text)
    if (result.ok) throw new Error("expected issues")
    expect(result.issues).toHaveLength(1)
    expect(result.issues[0].path).toBe("")
    expect(result.issues[0].message).toContain("wiki_id")
    expect(result.issues[0].message).toMatch(/duplicate/i)
  })

  it("reports YAML syntax errors and non-mapping files", () => {
    for (const text of ["wiki_id: [unclosed\n", "", "- a\n"]) {
      expect(pathsOf(parseHeptabaseYaml(text)), JSON.stringify(text)).toEqual([""])
    }
  })
})
