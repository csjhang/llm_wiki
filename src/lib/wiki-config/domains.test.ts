import { describe, it, expect } from "vitest"
import { DOMAIN_NAME_PATTERN, KNOWN_LENSES, domainParent, parseDomainsYaml } from "./domains"
import type { ConfigIssue, ParseResult } from "./types"

const WB_1 = "00000000-0000-4000-8000-000000000001"

function valueOf<T>(result: ParseResult<T>): T {
  if (!result.ok) throw new Error(`expected ok, got ${JSON.stringify(result.issues)}`)
  return result.value
}

function issuesOf<T>(result: ParseResult<T>): ConfigIssue[] {
  if (result.ok) throw new Error("expected issues, got ok")
  return result.issues
}

const VALID = `version: 1
domains:
  hardware/async-circuits:
    lens: hardware
    description: Digital circuits without a global clock
  ai/architecture:
    lens: ai
    description: Model architectures and training methods
`

function singleDomain(key: string, body: string): string {
  return `version: 1\ndomains:\n  ${key}:\n${body
    .split("\n")
    .map((line) => `    ${line}`)
    .join("\n")}\n`
}

describe("parseDomainsYaml", () => {
  it("parses a valid file", () => {
    const config = valueOf(parseDomainsYaml(VALID))
    expect(config.version).toBe(1)
    expect(Object.keys(config.domains)).toEqual(["hardware/async-circuits", "ai/architecture"])
    expect(config.domains["hardware/async-circuits"]).toEqual({
      lens: "hardware",
      description: "Digital circuits without a global clock",
      whiteboards: [],
    })
    expect(config.domains["ai/architecture"].lens).toBe("ai")
  })

  it("keeps whiteboard ids when given", () => {
    const text = singleDomain("ai/agents", `lens: ai\ndescription: Agents\nwhiteboards: [${WB_1}]`)
    expect(valueOf(parseDomainsYaml(text)).domains["ai/agents"].whiteboards).toEqual([WB_1])
  })

  it("treats null domains as empty", () => {
    const config = valueOf(parseDomainsYaml("version: 1\ndomains:\n"))
    expect(config.domains).toEqual({})
  })

  it("treats a missing domains key as empty", () => {
    expect(valueOf(parseDomainsYaml("version: 1\n")).domains).toEqual({})
  })

  it("rejects bad domain names", () => {
    for (const key of ["Hardware/X", "hardware//x", "hardware/", "硬體"]) {
      const text = singleDomain(`"${key}"`, "lens: hardware\ndescription: x")
      const issues = issuesOf(parseDomainsYaml(text))
      expect(issues.map((i) => i.path), key).toEqual([`domains.${key}`])
    }
  })

  it("rejects unknown lens", () => {
    const text = singleDomain("music/jazz", "lens: music\ndescription: Jazz")
    const issues = issuesOf(parseDomainsYaml(text))
    expect(issues.map((i) => i.path)).toEqual(["domains.music/jazz.lens"])
  })

  it("accepts custom lens list", () => {
    const text = singleDomain("music/jazz", "lens: music\ndescription: Jazz")
    const config = valueOf(parseDomainsYaml(text, [...KNOWN_LENSES, "music"]))
    expect(config.domains["music/jazz"].lens).toBe("music")
  })

  it("requires lens", () => {
    const text = singleDomain("ai/agents", "description: Agents")
    const issues = issuesOf(parseDomainsYaml(text))
    expect(issues.map((i) => i.path)).toEqual(["domains.ai/agents.lens"])
  })

  it("requires description", () => {
    for (const body of ["lens: ai\ndescription: ''", "lens: ai\ndescription: '  '", "lens: ai"]) {
      const issues = issuesOf(parseDomainsYaml(singleDomain("ai/agents", body)))
      expect(issues.map((i) => i.path), body).toEqual(["domains.ai/agents.description"])
    }
  })

  it("requires whiteboard ids to be UUIDs", () => {
    const text = singleDomain("ai/agents", `lens: ai\ndescription: Agents\nwhiteboards: [abc, ${WB_1}]`)
    const issues = issuesOf(parseDomainsYaml(text))
    expect(issues.map((i) => i.path)).toEqual(["domains.ai/agents.whiteboards[0]"])
  })

  it("rejects whiteboards that is not a list", () => {
    const text = singleDomain("ai/agents", `lens: ai\ndescription: Agents\nwhiteboards: ${WB_1}`)
    const issues = issuesOf(parseDomainsYaml(text))
    expect(issues.map((i) => i.path)).toEqual(["domains.ai/agents.whiteboards"])
  })

  it("rejects unknown keys", () => {
    const text = singleDomain("ai/agents", "lens: ai\ndescription: Agents\ncolor: red")
    const issues = issuesOf(parseDomainsYaml(text))
    expect(issues.map((i) => i.path)).toEqual(["domains.ai/agents.color"])
  })

  it("rejects unknown top-level keys", () => {
    const issues = issuesOf(parseDomainsYaml("version: 1\ndomains: {}\nextra: 1\n"))
    expect(issues.map((i) => i.path)).toEqual(["extra"])
  })

  it("rejects a domain entry that is not a mapping", () => {
    const issues = issuesOf(parseDomainsYaml("version: 1\ndomains:\n  ai/agents:\n"))
    expect(issues.map((i) => i.path)).toEqual(["domains.ai/agents"])
  })

  it("rejects domains that is not a mapping", () => {
    const issues = issuesOf(parseDomainsYaml("version: 1\ndomains:\n  - ai/agents\n"))
    expect(issues.map((i) => i.path)).toEqual(["domains"])
  })

  it("rejects wrong version", () => {
    const issues = issuesOf(parseDomainsYaml("version: 2\ndomains: {}\n"))
    expect(issues.map((i) => i.path)).toEqual(["version"])
  })

  it("rejects a missing version", () => {
    const issues = issuesOf(parseDomainsYaml("domains: {}\n"))
    expect(issues.map((i) => i.path)).toEqual(["version"])
  })

  it("rejects an empty file and a non-mapping top level", () => {
    for (const text of ["", "- a\n- b\n", "just text\n"]) {
      const issues = issuesOf(parseDomainsYaml(text))
      expect(issues.map((i) => i.path), JSON.stringify(text)).toEqual([""])
    }
  })

  it("collects every issue instead of stopping at the first", () => {
    const text = `version: 2
domains:
  Bad/Name:
    lens: music
    description: ""
`
    const paths = issuesOf(parseDomainsYaml(text)).map((i) => i.path)
    expect(paths).toEqual([
      "version",
      "domains.Bad/Name",
      "domains.Bad/Name.lens",
      "domains.Bad/Name.description",
    ])
  })

  it("reports duplicate keys", () => {
    const text = `version: 1
domains:
  hardware/async-circuits:
    lens: hardware
    description: First
  hardware/async-circuits:
    lens: hardware
    description: Second
`
    const issues = issuesOf(parseDomainsYaml(text))
    expect(issues).toHaveLength(1)
    expect(issues[0].message).toContain("hardware/async-circuits")
    expect(issues[0].message).toMatch(/duplicate/i)
  })

  it("reports YAML syntax errors", () => {
    const issues = issuesOf(parseDomainsYaml("version: 1\ndomains: [unclosed\n"))
    expect(issues).toHaveLength(1)
    expect(issues[0].path).toBe("")
    expect(issues[0].message).not.toBe("")
  })
})

describe("domainParent", () => {
  it("returns the parent path", () => {
    expect(domainParent("a/b/c")).toBe("a/b")
    expect(domainParent("a/b")).toBe("a")
  })

  it("returns null for a top-level domain", () => {
    expect(domainParent("a")).toBeNull()
  })
})

describe("DOMAIN_NAME_PATTERN", () => {
  it("accepts lowercase words joined by dashes and slashes", () => {
    for (const name of ["a", "hardware/async-circuits", "ai/architecture/moe", "x1/y-2"]) {
      expect(DOMAIN_NAME_PATTERN.test(name), name).toBe(true)
    }
  })

  it("rejects everything else", () => {
    for (const name of ["", "A", "a b", "a_b", "a//b", "/a", "a/", "a-", "-a", "a--b", "硬體"]) {
      expect(DOMAIN_NAME_PATTERN.test(name), name).toBe(false)
    }
  })
})
