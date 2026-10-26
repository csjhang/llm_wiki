/**
 * domains-file.test.ts - tests for the text edit of domains.yaml.
 *
 * The edit works on text, like the writer of `mech:approve-domain`, so comments and blank lines stay. Every result is
 * also read back with the real parser. Domains are placeholders.
 */
import { describe, expect, it } from "vitest"
import { parseDomainsYaml } from "@/lib/wiki-config/domains"
import { editDomainsYaml, type GeneratedDomain } from "./domains-file"

const WHITEBOARD = "00000000-0000-4000-8000-000000000001"

const FILE = [
  "# Domain list of the test wiki.",
  "version: 1",
  "domains:",
  "  # Hardware first.",
  "  example/alpha:",
  "    lens: hardware",
  "    description: Alpha domain # kept",
  "    whiteboards: []",
  "",
  "  example/alpha/child:",
  "    lens: hardware",
  "    description: >",
  "      Child of alpha, with a",
  "      folded description",
  `    whiteboards: [${WHITEBOARD}]`,
  "  # A note between entries.",
  '  "example/beta":',
  "    lens: business",
  "    description: Beta domain",
  "",
].join("\n")

function entry(name: string, extra: Partial<GeneratedDomain> = {}): GeneratedDomain {
  return { name, lens: "physics", description: `Description of ${name}`, whiteboards: [], ...extra }
}

function read(text: string) {
  const parsed = parseDomainsYaml(text)
  if (!parsed.ok) throw new Error(`not valid: ${JSON.stringify(parsed.issues)}`)
  return parsed.value.domains
}

describe("editDomainsYaml: renames", () => {
  it("changes the key lines and nothing else", () => {
    const renames = new Map([
      ["example/alpha", "example/gamma"],
      ["example/alpha/child", "example/gamma/child"],
      ["example/beta", "example/delta"],
    ])
    const next = editDomainsYaml(FILE, { renames })
    expect(next).toBe(
      FILE.replace("  example/alpha:\n", "  example/gamma:\n")
        .replace("  example/alpha/child:\n", "  example/gamma/child:\n")
        .replace('  "example/beta":\n', '  "example/delta":\n'),
    )
    expect(Object.keys(read(next))).toEqual(["example/gamma", "example/gamma/child", "example/delta"])
    expect(read(next)["example/gamma/child"].whiteboards).toEqual([WHITEBOARD])
  })

  it("throws for a domain that the file does not hold", () => {
    expect(() => editDomainsYaml(FILE, { renames: new Map([["example/missing", "example/other"]]) })).toThrow(/example\/missing/)
  })
})

describe("editDomainsYaml: replacements", () => {
  it("removes an entry with its block and keeps the comments around it", () => {
    const next = editDomainsYaml(FILE, { replacements: new Map([["example/alpha/child", []]]) })
    expect(next).toBe(
      FILE.replace(
        [
          "  example/alpha/child:",
          "    lens: hardware",
          "    description: >",
          "      Child of alpha, with a",
          "      folded description",
          `    whiteboards: [${WHITEBOARD}]`,
          "",
        ].join("\n"),
        "",
      ),
    )
    expect(Object.keys(read(next))).toEqual(["example/alpha", "example/beta"])
  })

  it("replaces an entry by new entries at its place, in the style of the file", () => {
    const next = editDomainsYaml(FILE, {
      replacements: new Map([["example/alpha", [entry("example/one"), entry("example/two", { lens: "ai", whiteboards: [WHITEBOARD] })]]]),
    })
    expect(next).toBe(
      [
        "# Domain list of the test wiki.",
        "version: 1",
        "domains:",
        "  # Hardware first.",
        "  example/one:",
        "    lens: physics",
        "    description: Description of example/one",
        "    whiteboards: []",
        "  example/two:",
        "    lens: ai",
        "    description: Description of example/two",
        "    whiteboards:",
        `      - ${WHITEBOARD}`,
        "",
        ...FILE.split("\n").slice(9),
      ].join("\n"),
    )
    const domains = read(next)
    expect(Object.keys(domains)).toEqual(["example/one", "example/two", "example/alpha/child", "example/beta"])
    expect(domains["example/two"]).toEqual({ lens: "ai", description: "Description of example/two", whiteboards: [WHITEBOARD] })
  })

  it("writes a description that needs quotes as a double-quoted string", () => {
    const next = editDomainsYaml(FILE, {
      replacements: new Map([["example/beta", [entry("example/beta", { description: 'Uses: a colon, "quotes", and # a hash' })]]]),
    })
    expect(read(next)["example/beta"].description).toBe('Uses: a colon, "quotes", and # a hash')
    expect(next).toContain('    description: "Uses: a colon, \\"quotes\\", and # a hash"\n')
  })

  it("keeps the indent of a file with four spaces", () => {
    const file = "version: 1\ndomains:\n    example/alpha:\n        lens: hardware\n        description: A\n    example/beta:\n        lens: business\n        description: B\n"
    const next = editDomainsYaml(file, { replacements: new Map([["example/alpha", [entry("example/one"), entry("example/two")]]]) })
    expect(next).toBe(
      "version: 1\ndomains:\n    example/one:\n        lens: physics\n        description: Description of example/one\n        whiteboards: []\n" +
        "    example/two:\n        lens: physics\n        description: Description of example/two\n        whiteboards: []\n" +
        "    example/beta:\n        lens: business\n        description: B\n",
    )
    expect(Object.keys(read(next))).toEqual(["example/one", "example/two", "example/beta"])
  })

  it("keeps CRLF line breaks and handles a last entry without a final line break", () => {
    const file = "version: 1\r\ndomains:\r\n  example/alpha:\r\n    lens: hardware\r\n    description: A\r\n  example/beta:\r\n    lens: business\r\n    description: B"
    const next = editDomainsYaml(file, { replacements: new Map([["example/beta", [entry("example/one")]]]) })
    expect(next).toBe(
      "version: 1\r\ndomains:\r\n  example/alpha:\r\n    lens: hardware\r\n    description: A\r\n" +
        "  example/one:\r\n    lens: physics\r\n    description: Description of example/one\r\n    whiteboards: []\r\n",
    )
  })

  it("combines renames and replacements", () => {
    const next = editDomainsYaml(FILE, {
      renames: new Map([["example/alpha/child", "example/moved"]]),
      replacements: new Map([["example/beta", []]]),
    })
    expect(Object.keys(read(next))).toEqual(["example/alpha", "example/moved"])
  })
})

describe("editDomainsYaml: forms it cannot edit", () => {
  it("throws for a domains value written inline", () => {
    expect(() => editDomainsYaml("version: 1\ndomains: {example/alpha: {lens: hardware, description: A}}\n", { renames: new Map([["example/alpha", "example/x"]]) })).toThrow(/cannot/)
  })

  it("throws when the file has no domains block", () => {
    expect(() => editDomainsYaml("version: 1\n", { replacements: new Map([["example/alpha", []]]) })).toThrow(/domains/)
  })
})
