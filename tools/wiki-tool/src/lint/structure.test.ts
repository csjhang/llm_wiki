/**
 * structure.test.ts - tests for `wiki-tool lint structure`.
 *
 * The checks themselves are tested with `checkStructure` (src/lib/mechanism-wiki/lint-structure.test.ts). These tests
 * cover what the command adds: it reads the files of a project and fills the input of `checkStructure`. They run the
 * command through runCli on small wiki projects (see lint-fixture.ts). Slugs, domains, and titles are placeholders.
 */
import { rmSync } from "node:fs"
import { basename, join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { runCli } from "../cli"
import { removeProjects } from "../test-project"
import {
  BUSINESS,
  conceptPage,
  DOMAINS,
  git,
  HARDWARE,
  hypothesisPage,
  initRepo,
  makeWiki,
  mechanismPage,
  PHYSICS,
  page,
  runLint,
} from "./lint-fixture"

afterEach(removeProjects)

interface Finding {
  check: string
  page: string | null
  message: string
  domains?: string[]
}

interface StructureOutput {
  ok: boolean
  findings?: Finding[]
  problems?: string[]
}

const structure = (project: string) => runLint<StructureOutput>("structure", project)

/** A reading wiki whose thresholds let one page per domain pass. */
const LENIENT_WIKI_YAML = "version: 1\nid: test\nrole: reading\nlint:\n  min_domain_pages: 1\n"

/** One concept page in each domain: a wiki with no finding when the thresholds are lenient. */
function cleanFiles(): Record<string, string> {
  return {
    "wiki.yaml": LENIENT_WIKI_YAML,
    "wiki/concepts/a.md": conceptPage(HARDWARE),
    "wiki/concepts/b.md": conceptPage(BUSINESS),
    "wiki/concepts/c.md": conceptPage(PHYSICS),
  }
}

const checks = (findings: Finding[] | undefined): string[] => (findings ?? []).map((finding) => finding.check)

describe("lint structure", () => {
  it("a clean wiki has no finding", async () => {
    const project = makeWiki(cleanFiles())
    const { exitCode, output } = await structure(project)
    expect(exitCode).toBe(0)
    expect(output).toEqual({ ok: true, findings: [] })
  })

  it("lint structure finds an unknown domain", async () => {
    const project = makeWiki({ ...cleanFiles(), "wiki/concepts/stray.md": conceptPage("not/listed") })
    const { exitCode, output } = await structure(project)
    expect(exitCode).toBe(0)
    expect(output.ok).toBe(true)
    expect(output.findings).toHaveLength(1)
    expect(output.findings?.[0]).toMatchObject({
      check: "domain-unknown",
      page: "wiki/concepts/stray.md",
      domains: ["not/listed"],
    })
    expect(output.findings?.[0].message).toContain("not/listed")
  })

  it("finds a page without a domain", async () => {
    const project = makeWiki({ ...cleanFiles(), "wiki/concepts/stray.md": page({ type: "concept", title: "No domain" }) })
    const { output } = await structure(project)
    expect(output.findings).toMatchObject([{ check: "domain-missing", page: "wiki/concepts/stray.md" }])
  })

  it("uses the thresholds of wiki.yaml", async () => {
    // The default minimum is 3 pages; the wiki has one page in each domain.
    const files = cleanFiles()
    const lenient = makeWiki(files)
    expect(checks((await structure(lenient)).output.findings)).toEqual([])

    const strict = makeWiki({ ...files, "wiki.yaml": "version: 1\nid: test\nrole: reading\n" })
    const { output } = await structure(strict)
    expect(checks(output.findings)).toEqual(["domain-too-small", "domain-too-small", "domain-too-small"])
    expect(output.findings?.map((finding) => finding.domains?.[0]).sort()).toEqual([...DOMAINS].sort())

    const tight = makeWiki({ ...files, "wiki.yaml": "version: 1\nid: test\nrole: reading\nlint:\n  min_domain_pages: 2\n" })
    expect(checks((await structure(tight)).output.findings)).toEqual(["domain-too-small", "domain-too-small", "domain-too-small"])

    const small = makeWiki({
      ...files,
      "wiki.yaml": "version: 1\nid: test\nrole: reading\nlint:\n  max_domain_pages: 1\n  min_domain_pages: 1\n",
      "wiki/concepts/a2.md": conceptPage(HARDWARE),
    })
    expect((await structure(small)).output.findings).toMatchObject([{ check: "domain-too-large", domains: [HARDWARE] }])
  })

  it("ages a draft hypothesis by the date of today", async () => {
    const project = makeWiki({
      ...cleanFiles(),
      "wiki/hypotheses/old.md": hypothesisPage(HARDWARE, BUSINESS, { updated: "2020-01-01" }),
      "wiki/hypotheses/new.md": hypothesisPage(HARDWARE, BUSINESS),
    })
    const { output } = await structure(project)
    expect(output.findings).toMatchObject([{ check: "hypothesis-stale-draft", page: "wiki/hypotheses/old.md" }])
  })

  it("finds a mechanism with no instance in a reading wiki", async () => {
    const project = makeWiki({ ...cleanFiles(), "wiki/mechanisms/handshake.md": mechanismPage() })
    const { output } = await structure(project)
    expect(output.findings).toMatchObject([{ check: "mechanism-no-instance", page: "wiki/mechanisms/handshake.md" }])
  })

  it("leaves out the pages of the app", async () => {
    const project = makeWiki({
      ...cleanFiles(),
      "wiki/index.md": "# Index\n",
      "wiki/log.md": "# Log\n",
      "wiki/overview.md": "# Overview\n",
      "wiki/indexes/hardware--async-circuits.md": "# Index of a domain\n",
    })
    const { output } = await structure(project)
    expect(output).toEqual({ ok: true, findings: [] })
  })

  it("a project with no wiki folder has no page", async () => {
    const project = makeWiki({ "wiki.yaml": LENIENT_WIKI_YAML })
    const { exitCode, output } = await structure(project)
    expect(exitCode).toBe(0)
    // Every domain is empty.
    expect(checks(output.findings)).toEqual(["domain-too-small", "domain-too-small", "domain-too-small"])
  })

  it("does not change the project", async () => {
    const project = makeWiki(cleanFiles())
    initRepo(project)
    git(project, "add", "-A")
    git(project, "commit", "--quiet", "-m", "init")
    await structure(project)
    expect(git(project, "status", "--porcelain")).toBe("")
  })
})

describe("lint structure: the card map", () => {
  const CARD = "00000000-0000-4000-8000-000000000001"

  function cardMap(pages: Record<string, { status: string; card_id: string }>): string {
    return JSON.stringify({ version: 1, pages, sources: {}, whiteboards_cache: { updated_at: "", items: [] } })
  }

  it("finds a retired card and a card of a page that is gone", async () => {
    const project = makeWiki({
      ...cleanFiles(),
      "heptabase-map.json": cardMap({
        "wiki/concepts/a.md": { status: "retired", card_id: CARD },
        "wiki/concepts/gone.md": { status: "active", card_id: CARD },
        "wiki/concepts/b.md": { status: "active", card_id: CARD },
      }),
    })
    const { output } = await structure(project)
    expect(output.findings).toMatchObject([
      { check: "map-missing-page", page: "wiki/concepts/gone.md" },
      { check: "mirror-retired", page: "wiki/concepts/a.md" },
    ])
  })

  it("a project without a card map gets no card map finding", async () => {
    const project = makeWiki(cleanFiles())
    const { output } = await structure(project)
    expect(output.findings).toEqual([])
  })

  it.each([
    ["is not JSON", "not json"],
    ["is not a card map of version 1", JSON.stringify({ version: 2, pages: {} })],
    ["has no pages", JSON.stringify({ version: 1 })],
  ])("a card map that %s is left out of the checks", async (_name, text) => {
    const project = makeWiki({ ...cleanFiles(), "heptabase-map.json": text })
    const { exitCode, output } = await structure(project)
    expect(exitCode).toBe(0)
    expect(output).toEqual({ ok: true, findings: [] })
  })

  it("leaves out an entry without a status and a card id", async () => {
    const project = makeWiki({
      ...cleanFiles(),
      "heptabase-map.json": JSON.stringify({
        version: 1,
        pages: { "wiki/concepts/a.md": { status: "retired" }, "wiki/concepts/gone.md": 5 },
      }),
    })
    const { output } = await structure(project)
    expect(output.findings).toEqual([])
  })
})

describe("lint structure: config problems (ruling U14)", () => {
  it("a broken domains.yaml gives one config-invalid finding and no flood", async () => {
    const project = makeWiki({
      ...cleanFiles(),
      // One problem: the lens of a domain is not a lens.
      "domains.yaml": "version: 1\ndomains:\n  hardware/async-circuits:\n    lens: nonsense\n    description: x\n",
    })
    const { exitCode, output } = await structure(project)
    expect(exitCode).toBe(0)
    expect(output.findings).toHaveLength(1)
    expect(output.findings?.[0]).toMatchObject({ check: "config-invalid", page: null })
    // The problem names its file and the key.
    expect(output.findings?.[0].message).toContain("domains.yaml:domains.hardware/async-circuits.lens")
  })

  it("every problem of domains.yaml is a finding", async () => {
    const project = makeWiki({
      ...cleanFiles(),
      "domains.yaml": "version: 1\ndomains:\n  hardware/async-circuits:\n    lens: nonsense\n    description: ''\n",
    })
    const { output } = await structure(project)
    expect(checks(output.findings)).toEqual(["config-invalid", "config-invalid"])
    expect(output.findings?.every((finding) => finding.message.includes("domains.yaml:"))).toBe(true)
  })

  it("a domains.yaml that cannot be read as YAML gives one finding", async () => {
    const project = makeWiki({ ...cleanFiles(), "domains.yaml": "version: [1\n" })
    const { output } = await structure(project)
    expect(checks(output.findings)).toEqual(["config-invalid"])
    expect(output.findings?.[0].message).toContain("domains.yaml")
  })

  it("a lens file makes its stem a known lens", async () => {
    const project = makeWiki({
      ...cleanFiles(),
      "lenses/custom.md": "# Custom lens\n\n## Fields\n\nNone.\n",
      "domains.yaml": "version: 1\ndomains:\n  hardware/async-circuits:\n    lens: custom\n    description: x\n",
      "wiki/concepts/a.md": conceptPage(HARDWARE),
    })
    const { output } = await structure(project)
    // The domain list is valid; the other two domains are unknown to it.
    expect(checks(output.findings)).toEqual(["domain-unknown", "domain-unknown"])
  })

  it("a broken wiki.yaml gives a config-invalid finding that names the file", async () => {
    const project = makeWiki({ ...cleanFiles(), "wiki.yaml": "version: 1\nid: test\nrole: nonsense\n" })
    const { output } = await structure(project)
    const found = (output.findings ?? []).filter((finding) => finding.check === "config-invalid")
    expect(found).toHaveLength(1)
    expect(found[0].message).toContain("wiki.yaml:role")
  })

  it("a missing wiki.yaml gives a config-invalid finding", async () => {
    const project = makeWiki(cleanFiles())
    rmSync(join(project, "wiki.yaml"))
    const { output } = await structure(project)
    const found = (output.findings ?? []).filter((finding) => finding.check === "config-invalid")
    expect(found).toHaveLength(1)
    expect(found[0].message).toContain("wiki.yaml")
    expect(found[0].message).toContain("the file is missing")
  })
})

describe("lint structure: a work wiki", () => {
  const LIBRARY_DOMAINS_YAML = "version: 1\ndomains:\n  ai/agents:\n    lens: ai\n    description: Placeholder library domain\n"

  /** A work wiki whose reading wiki is at `library` (a path; absolute or relative to the work wiki). */
  function workWiki(library: string, files: Record<string, string> = {}): string {
    return makeWiki({
      ...cleanFiles(),
      "wiki.yaml": `version: 1\nid: work\nrole: work\nmechanism_library: ${library}\nlint:\n  min_domain_pages: 1\n`,
      ...files,
    })
  }

  it("knows a domain of the reading wiki as the to_domain of a hypothesis", async () => {
    const library = makeWiki({ "domains.yaml": LIBRARY_DOMAINS_YAML })
    const project = workWiki(library, { "wiki/hypotheses/h.md": hypothesisPage(HARDWARE, "ai/agents") })
    const { exitCode, output } = await structure(project)
    expect(exitCode).toBe(0)
    expect(output.findings).toEqual([])
  })

  it("reads the library path relative to the project", async () => {
    // Both folders are in the temporary folder, so `../<name of the library>` leads from one to the other.
    const library = makeWiki({ "domains.yaml": LIBRARY_DOMAINS_YAML })
    const project = workWiki(`../${basename(library)}`, { "wiki/hypotheses/h.md": hypothesisPage(HARDWARE, "ai/agents") })
    const { output } = await structure(project)
    expect(output.findings).toEqual([])
  })

  it("a domain that neither wiki lists is unknown", async () => {
    const library = makeWiki({ "domains.yaml": LIBRARY_DOMAINS_YAML })
    const project = workWiki(library, { "wiki/hypotheses/h.md": hypothesisPage(HARDWARE, "ai/nothing") })
    const { output } = await structure(project)
    expect(output.findings).toMatchObject([{ check: "domain-unknown", page: "wiki/hypotheses/h.md", domains: ["ai/nothing"] }])
  })

  it("a library domain is not a domain of an ordinary page", async () => {
    const library = makeWiki({ "domains.yaml": LIBRARY_DOMAINS_YAML })
    const project = workWiki(library, { "wiki/concepts/stray.md": conceptPage("ai/agents") })
    const { output } = await structure(project)
    expect(output.findings).toMatchObject([{ check: "domain-unknown", page: "wiki/concepts/stray.md" }])
  })

  it("a broken domains.yaml of the reading wiki gives one finding that says so", async () => {
    const library = makeWiki({
      "domains.yaml": "version: 1\ndomains:\n  ai/agents:\n    lens: nonsense\n    description: x\n",
    })
    const project = workWiki(library, { "wiki/hypotheses/h.md": hypothesisPage(HARDWARE, "ai/agents") })
    const { output } = await structure(project)
    // The hypothesis domain is not judged, because the list that holds it cannot be read.
    expect(output.findings).toHaveLength(1)
    expect(output.findings?.[0]).toMatchObject({ check: "config-invalid", page: null })
    expect(output.findings?.[0].message).toContain("reading wiki domains.yaml:domains.ai/agents.lens")
  })

  it("a reading wiki with no domains.yaml gives one finding that names the path", async () => {
    const library = makeWiki({ "domains.yaml": LIBRARY_DOMAINS_YAML })
    rmSync(join(library, "domains.yaml"))
    const project = workWiki(library)
    const { output } = await structure(project)
    expect(output.findings).toHaveLength(1)
    expect(output.findings?.[0].check).toBe("config-invalid")
    expect(output.findings?.[0].message).toContain("reading wiki domains.yaml: the file is missing at")
    expect(output.findings?.[0].message).toContain(library.replace(/\\/g, "/"))
  })

  it("a work wiki has no mechanism-no-instance finding", async () => {
    const library = makeWiki({ "domains.yaml": LIBRARY_DOMAINS_YAML })
    const project = workWiki(library, { "wiki/mechanisms/handshake.md": mechanismPage() })
    const { output } = await structure(project)
    expect(output.findings).toEqual([])
  })
})

describe("lint structure: handled problems", () => {
  it("a project without domains.yaml exits 2", async () => {
    const project = makeWiki(cleanFiles())
    rmSync(join(project, "domains.yaml"))
    const { exitCode, output } = await structure(project)
    expect(exitCode).toBe(2)
    expect(output.ok).toBe(false)
    expect(output.problems?.join("\n")).toMatch(/domains\.yaml/)
  })

  it("a missing --project exits 2", async () => {
    const result = await runCli(["lint", "structure"])
    expect(result.exitCode).toBe(2)
    expect(result.output.problems).toContain("missing option: --project")
  })

  it("a project folder that does not exist exits 2", async () => {
    const { exitCode, output } = await structure("/nonexistent/wiki-tool-lint-project")
    expect(exitCode).toBe(2)
    expect(output.problems?.join("\n")).toMatch(/project folder not found/)
  })

  it("an unknown option exits 2", async () => {
    const project = makeWiki(cleanFiles())
    const { exitCode, output } = await runLint<StructureOutput>("structure", project, "--fix")
    expect(exitCode).toBe(2)
    expect(output.problems?.join("\n")).toMatch(/unknown option: --fix/)
  })

  it("an unknown lint command exits 2", async () => {
    const result = await runCli(["lint", "nonsense"])
    expect(result.exitCode).toBe(2)
    expect(result.output.problems).toEqual(["unknown command: lint nonsense"])
  })
})
