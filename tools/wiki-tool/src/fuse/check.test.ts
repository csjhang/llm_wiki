/**
 * check.test.ts - tests for `wiki-tool fuse check`.
 *
 * The tests run the command through runCli on small wiki projects (see hypothesis-fixture.ts). Slugs, domains, and
 * titles are placeholders. The rule-file example of `hypothesis.md` is read from the template and must pass.
 */
import { readFileSync } from "node:fs"
import { join, relative } from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, describe, expect, it } from "vitest"
import { runCli } from "../cli"
import { removeProjects, writeProjectFile } from "../test-project"
import {
  DOMAINS_YAML,
  EVIDENCE_PAGE,
  hypothesisPage,
  makeWiki,
  makeWorkWiki,
  mappingTable,
  type PageOptions,
  QUERY_PAGE,
  VALID_VERIFY_ROWS,
  verifyTable,
} from "./hypothesis-fixture"

const RULE_FILE = fileURLToPath(new URL("../../../../templates/mechanism-wiki/schema/page-types/hypothesis.md", import.meta.url))
const FILE = "wiki/hypotheses/threshold-restocking.md"

afterEach(removeProjects)

interface CheckOutput {
  ok: boolean
  problems?: string[]
}

async function checkFile(project: string, file: string = FILE) {
  const result = await runCli(["fuse", "check", "--project", project, "--file", file])
  return { exitCode: result.exitCode, output: result.output as CheckOutput }
}

/** Write a page into a fresh wiki and check it. */
async function checkPage(options: PageOptions = {}, project = makeWiki()) {
  writeProjectFile(project, FILE, hypothesisPage(options))
  return checkFile(project)
}

async function expectPasses(options: PageOptions = {}, project = makeWiki()) {
  const { exitCode, output } = await checkPage(options, project)
  expect(output).toEqual({ ok: true, problems: [] })
  expect(exitCode).toBe(0)
}

async function expectFails(options: PageOptions, problem: RegExp, project = makeWiki()) {
  const { exitCode, output } = await checkPage(options, project)
  expect(output.ok).toBe(false)
  expect(output.problems?.some((text) => problem.test(text)), JSON.stringify(output.problems)).toBe(true)
  expect(exitCode).toBe(2)
}

/** The first markdown fence under `## Example` in the rule file. */
function ruleFileExample(): string {
  const text = readFileSync(RULE_FILE, "utf8")
  const example = text.slice(text.indexOf("\n## Example"))
  const match = /```markdown\n([\s\S]*?)\n```/.exec(example)
  if (!match) throw new Error("the rule file has no example")
  return `${match[1]}\n`
}

const link = (slug: string): string => `[[${slug}]]`

describe("fuse check: a valid page", () => {
  it("valid page passes", async () => {
    await expectPasses()
  })

  it("the hypothesis rule-file example passes", async () => {
    // The example names two domains of its own; the wiki lists them.
    const project = makeWiki({
      "wiki/concepts/restock-policy.md": "---\ntype: concept\n---\n# Restock policy\n",
      "wiki/concepts/stock-count-process.md": "---\ntype: concept\n---\n# Stock count process\n",
    })
    writeProjectFile(project, FILE, ruleFileExample())
    const { exitCode, output } = await checkFile(project)
    expect(output).toEqual({ ok: true, problems: [] })
    expect(exitCode).toBe(0)
  })

  it("claim section without a link passes", async () => {
    await expectPasses({ sections: { claim: "A plain sentence with no link at all." } })
  })

  it("draft with zero verify rows passes", async () => {
    await expectPasses({ sections: { verify: verifyTable([]) } })
  })

  it("accepts Traditional Chinese headings", async () => {
    await expectPasses({ headings: "zhHant" })
  })

  it("accepts Simplified Chinese headings", async () => {
    await expectPasses({ headings: "zhHans" })
  })

  it("accepts English headings in any letter case", async () => {
    const page = hypothesisPage()
      .replace("## One-line hypothesis", "## ONE-LINE HYPOTHESIS")
      .replace("## Role mapping", "## role mapping")
      .replace("## What to verify", "## What To Verify:")
    const project = makeWiki()
    writeProjectFile(project, FILE, page)
    expect((await checkFile(project)).output).toEqual({ ok: true, problems: [] })
  })

  it("does not split a table row at the pipe of a wiki link", async () => {
    const rows = [["A claim", `Pages ${link(`${EVIDENCE_PAGE}|the policy`)} and ${link(EVIDENCE_PAGE)}`, "A result that disproves it"]]
    await expectPasses({ sections: { verify: verifyTable(rows) } })
    const escaped = [["A claim", `The page [[${EVIDENCE_PAGE}\\|policy]]`, "A result that disproves it"]]
    await expectPasses({ sections: { verify: verifyTable(escaped) } })
  })

  it("reads a page with a byte order mark and Windows line breaks", async () => {
    const project = makeWiki()
    writeProjectFile(project, FILE, `\uFEFF${hypothesisPage().replace(/\n/g, "\r\n")}`)
    expect((await checkFile(project)).output).toEqual({ ok: true, problems: [] })
  })

  it("reads a table row without the closing pipe", async () => {
    const verify = "| Claim | Evidence needed | How to refute |\n|---|---|---|\n| A claim | Some records | A result that disproves it"
    await expectPasses({ sections: { verify } })
  })
})

describe("fuse check: frontmatter", () => {
  it.each(["mechanism", "from_domain", "to_domain", "relation", "strength", "status", "type"])(
    "missing field fails: %s",
    async (field) => {
      await expectFails({ fields: { [field]: null } }, new RegExp(`\\b${field}\\b`))
    },
  )

  it("an empty field fails", async () => {
    await expectFails({ fields: { mechanism: "  " } }, /mechanism/)
  })

  it("a page of another type fails", async () => {
    await expectFails({ fields: { type: "concept" } }, /type/)
  })

  it.each([
    ["relation", "mirror"],
    ["strength", "strong"],
    ["status", "done"],
  ])("a bad %s fails: %s", async (field, value) => {
    await expectFails({ fields: { [field]: value } }, new RegExp(`${field}.*${value}`))
  })

  it.each(["analogy", "stack"])("accepts relation %s", async (relation) => {
    await expectPasses({ fields: { relation } })
  })

  it.each(["surface", "structural", "mathematical"])("accepts strength %s", async (strength) => {
    await expectPasses({ fields: { strength } })
  })

  it("accepts a mechanism of the reading wiki", async () => {
    await expectPasses({ fields: { mechanism: "reading:event-driven" } })
  })

  it("refuses a reading: mechanism without a slug", async () => {
    await expectFails({ fields: { mechanism: "reading:" } }, /mechanism/)
  })

  it("a page without frontmatter fails", async () => {
    const project = makeWiki()
    writeProjectFile(project, FILE, "# Title\n\n## One-line hypothesis\n\nText.\n")
    const { output } = await checkFile(project)
    expect(output.ok).toBe(false)
    expect(output.problems?.join("\n")).toMatch(/frontmatter/)
  })
})

describe("fuse check: domains", () => {
  it("unknown domain fails", async () => {
    await expectFails({ fields: { to_domain: "business/unknown" } }, /to_domain.*business\/unknown/)
    await expectFails({ fields: { from_domain: "hardware/unknown" } }, /from_domain.*hardware\/unknown/)
  })

  it("reports both domains when both are unknown", async () => {
    const { output } = await checkPage({ fields: { from_domain: "a/one", to_domain: "b/two" } })
    expect(output.problems?.filter((text) => /domain/.test(text))).toHaveLength(2)
  })

  it("a wiki with no domain accepts none", async () => {
    const project = makeWiki()
    writeProjectFile(project, "domains.yaml", "version: 1\ndomains: {}\n")
    await expectFails({}, /from_domain/, project)
  })

  it("a domains.yaml that is not valid is a problem", async () => {
    const project = makeWiki()
    writeProjectFile(project, "domains.yaml", "version: 2\ndomains: {}\n")
    await expectFails({}, /domains\.yaml/, project)
  })

  it("accepts a lens that the wiki defines itself", async () => {
    const project = makeWiki({
      "domains.yaml": DOMAINS_YAML.replace("lens: hardware", "lens: custom-lens"),
      "lenses/custom-lens.md": "# Custom lens\n",
    })
    await expectPasses({}, project)
  })

  describe("in a work wiki", () => {
    const LIBRARY_DOMAINS = [
      "version: 1",
      "domains:",
      "  physics/thermal:",
      "    lens: physics",
      "    description: Heat flow",
      "",
    ].join("\n")

    /** A work wiki whose `mechanism_library` is `library`. */
    function workWiki(library: string) {
      const work = makeWiki()
      makeWorkWiki(work, library)
      return work
    }

    it("takes a domain from the domains.yaml of the library (an absolute path)", async () => {
      const library = makeWiki()
      writeProjectFile(library, "domains.yaml", LIBRARY_DOMAINS)
      const work = workWiki(library)
      await expectPasses({ fields: { from_domain: "physics/thermal" } }, work)
    })

    it("takes a domain from the domains.yaml of the library (a path relative to the project)", async () => {
      const library = makeWiki()
      writeProjectFile(library, "domains.yaml", LIBRARY_DOMAINS)
      const work = makeWiki()
      makeWorkWiki(work, relative(work, library))
      await expectPasses({ fields: { from_domain: "physics/thermal" } }, work)
    })

    it("still takes a domain of this wiki", async () => {
      const library = makeWiki()
      writeProjectFile(library, "domains.yaml", LIBRARY_DOMAINS)
      await expectPasses({}, workWiki(library))
    })

    it("a domain in neither list fails and the problem names the library", async () => {
      const library = makeWiki()
      writeProjectFile(library, "domains.yaml", LIBRARY_DOMAINS)
      await expectFails({ fields: { from_domain: "physics/unknown" } }, /from_domain.*physics\/unknown.*library/s, workWiki(library))
    })

    it("a library without domains.yaml is not a problem by itself", async () => {
      const library = makeWiki()
      writeProjectFile(library, "domains.yaml", LIBRARY_DOMAINS)
      const work = workWiki(library)
      // Another library path that does not exist: only the domains of this wiki are known.
      makeWorkWiki(work, `${library}-missing`)
      await expectPasses({}, work)
      await expectFails({ fields: { from_domain: "physics/thermal" } }, /from_domain.*physics\/thermal/s, work)
    })

    it("a domains.yaml of the library that is not valid is a problem", async () => {
      const library = makeWiki()
      writeProjectFile(library, "domains.yaml", "version: 9\n")
      // The domains of this wiki are still enough for a page that uses them.
      await expectPasses({}, workWiki(library))
      await expectFails({ fields: { from_domain: "physics/thermal" } }, /physics\/thermal.*library.*not valid/s, workWiki(library))
    })

  })
})

describe("fuse check: sections", () => {
  it.each([
    ["claim", /One-line hypothesis/],
    ["mapping", /Role mapping/],
    ["gaps", /Gaps and impact/],
    ["verify", /What to verify/],
    ["search", /Search keywords/],
    ["related", /Related pages/],
  ] as const)("missing section fails: %s", async (key, name) => {
    await expectFails({ sections: { [key]: null } }, name)
  })

  it("reports every missing section", async () => {
    const { output } = await checkPage({ sections: { gaps: null, search: null } })
    expect(output.problems?.filter((text) => /missing section/.test(text))).toHaveLength(2)
  })

  it("a heading of another level or another wording is not a section", async () => {
    const page = hypothesisPage().replace("## Search keywords", "### Search keywords")
    const project = makeWiki()
    writeProjectFile(project, FILE, page)
    const { output } = await checkFile(project)
    expect(output.problems?.join("\n")).toMatch(/Search keywords/)
  })

  it("a section that is present but empty is present", async () => {
    await expectPasses({ sections: { search: "", related: "" } })
  })
})

describe("fuse check: the role mapping", () => {
  it("a role mapping without a table fails", async () => {
    await expectFails({ sections: { mapping: `Only prose, with a link ${link(EVIDENCE_PAGE)}.` } }, /Role mapping.*table/)
  })

  it("claim without link fails: a role mapping that cites no page", async () => {
    const mapping = mappingTable([["Event", "Stock below the threshold", "fits", "Nobody says so."]])
    await expectFails({ sections: { mapping } }, /Role mapping.*\[\[/)
  })

  it("an image embed is not a link", async () => {
    const mapping = mappingTable([["Event", "Stock", "fits", `![[${EVIDENCE_PAGE}]]`]])
    await expectFails({ sections: { mapping } }, /Role mapping.*\[\[/)
  })

  it("a link to the heading of the same page is not a citation", async () => {
    const mapping = mappingTable([["Event", "Stock", "fits", "[[#reason]]"]])
    await expectFails({ sections: { mapping } }, /Role mapping.*\[\[/)
  })

  it("a link inside inline code is not a link", async () => {
    const mapping = mappingTable([["Event", "Stock", "fits", `\`[[${EVIDENCE_PAGE}]]\``]])
    await expectFails({ sections: { mapping } }, /Role mapping.*\[\[/)
  })

  it("one link anywhere in the section is enough", async () => {
    const mapping = mappingTable([
      ["Event", "Stock below the threshold", "unknown", "No page yet."],
      ["Channel", "Purchase notice", "fits", `[[${EVIDENCE_PAGE}|the policy]]`],
    ])
    await expectPasses({ sections: { mapping } })
  })
})

describe("fuse check: what to verify", () => {
  it("a verify section without a table fails", async () => {
    await expectFails({ sections: { verify: "- A claim\n- Another claim" } }, /What to verify.*table/)
  })

  it("empty refute cell fails and names the row", async () => {
    const verify = verifyTable([
      ["First claim", "Some records", "A result that disproves it"],
      ["Second claim", "Other records", ""],
    ])
    await expectFails({ sections: { verify } }, /What to verify.*row 2.*Second claim.*How to refute/s)
  })

  it("a refute cell that is only a dash is empty", async () => {
    const verify = verifyTable([["A claim", "Some records", "-"]])
    await expectFails({ sections: { verify } }, /row 1/)
    await expectFails({ sections: { verify: verifyTable([["A claim", "Some records", "<br>"]]) } }, /row 1/)
  })

  it("a row with too few cells has an empty refute cell", async () => {
    const verify = "| Claim | Evidence needed | How to refute |\n|---|---|---|\n| A claim | Some records |"
    await expectFails({ sections: { verify } }, /row 1/)
  })

  it("reports every row with an empty refute cell", async () => {
    const verify = verifyTable([
      ["First claim", "Some records", ""],
      ["Second claim", "Other records", ""],
    ])
    const { output } = await checkPage({ sections: { verify } })
    expect(output.problems?.filter((text) => /How to refute/.test(text))).toHaveLength(2)
  })

  it("the verify table is not read past the end of the table", async () => {
    // The cell of a text line after the table is not a row.
    const verify = `${verifyTable(VALID_VERIFY_ROWS)}\n\nA closing remark | with a pipe`
    await expectPasses({ sections: { verify } })
  })

  it("reads the table of the verify section, not the table of the role mapping", async () => {
    const mapping = mappingTable([["Event", "Stock", "fits", `${link(EVIDENCE_PAGE)}`]])
    await expectPasses({ sections: { mapping, verify: verifyTable([]) } })
  })

  describe("status supported", () => {
    const LINKED_ROWS = [
      ["A claim", `Records in ${link(EVIDENCE_PAGE)}`, "A result that disproves it"],
      ["Another claim", `Records in ${link(QUERY_PAGE)}`, "Another result"],
    ]

    it("supported with zero verify rows fails", async () => {
      await expectFails({ fields: { status: "supported" }, sections: { verify: verifyTable([]) } }, /supported.*at least one row/)
    })

    it("supported passes when every row links a wiki page", async () => {
      await expectPasses({ fields: { status: "supported" }, sections: { verify: verifyTable(LINKED_ROWS) } })
    })

    it("supported fails for a row that links no page", async () => {
      const rows = [...LINKED_ROWS, ["A claim with no page", "Some records", "A result that disproves it"]]
      await expectFails({ fields: { status: "supported" }, sections: { verify: verifyTable(rows) } }, /row 3.*A claim with no page.*evidence/s)
    })

    it("supported fails for a row that links a page that does not exist", async () => {
      const rows = [["A claim", `Records in ${link("no-such-page")}`, "A result that disproves it"]]
      await expectFails({ fields: { status: "supported" }, sections: { verify: verifyTable(rows) } }, /row 1.*no-such-page/s)
    })

    it("a link may name the page by its path", async () => {
      const rows = [["A claim", `Records in ${link(`wiki/concepts/${EVIDENCE_PAGE}.md`)}`, "A result that disproves it"]]
      await expectPasses({ fields: { status: "supported" }, sections: { verify: verifyTable(rows) } })
    })

    it("a link may name the page in another letter case, with an anchor", async () => {
      const rows = [["A claim", `Records in ${link("Restock-Policy#part")}`, "A result that disproves it"]]
      await expectPasses({ fields: { status: "supported" }, sections: { verify: verifyTable(rows) } })
    })
  })

  describe("status refuted", () => {
    it("refuted passes when every row links a wiki page", async () => {
      const rows = [["A claim", `Records in ${link(EVIDENCE_PAGE)}`, "A result that disproves it"]]
      await expectPasses({ fields: { status: "refuted" }, sections: { verify: verifyTable(rows) } })
    })

    it("refuted fails for a row that links no page", async () => {
      await expectFails({ fields: { status: "refuted" } }, /row 1.*evidence/s)
    })

    it("refuted with zero verify rows fails", async () => {
      await expectFails({ fields: { status: "refuted" }, sections: { verify: verifyTable([]) } }, /refuted.*at least one row/)
    })
  })

  describe("status testing", () => {
    it("testing without a linked query page fails", async () => {
      await expectFails({ fields: { status: "testing" } }, /testing.*wiki\/queries/)
    })

    it("testing with zero verify rows fails", async () => {
      await expectFails({ fields: { status: "testing" }, sections: { verify: verifyTable([]) } }, /testing.*wiki\/queries/)
    })

    it("testing fails when the row links a page that is not a query page", async () => {
      const rows = [["A claim", `Records in ${link(EVIDENCE_PAGE)}`, "A result that disproves it"]]
      await expectFails({ fields: { status: "testing" }, sections: { verify: verifyTable(rows) } }, /testing.*wiki\/queries/)
    })

    it("testing passes when one row links a query page", async () => {
      const rows = [
        ["A claim", `Tracked in ${link(QUERY_PAGE)}`, "A result that disproves it"],
        ["Another claim", "Some records", "Another result"],
      ]
      await expectPasses({ fields: { status: "testing" }, sections: { verify: verifyTable(rows) } })
    })

    it("a query page in a subfolder counts", async () => {
      const project = makeWiki({ "wiki/queries/deep/nested-question.md": "---\ntype: query\n---\n# Nested\n" })
      const rows = [["A claim", `Tracked in ${link("nested-question")}`, "A result that disproves it"]]
      await expectPasses({ fields: { status: "testing" }, sections: { verify: verifyTable(rows) } }, project)
    })
  })

  describe("status draft", () => {
    it("draft does not need evidence links", async () => {
      await expectPasses({ fields: { status: "draft" } })
    })
  })
})

describe("fuse check: relation stack", () => {
  it("a stack with two domains passes", async () => {
    await expectPasses({ fields: { relation: "stack" } })
  })

  it("a stack needs a base layer other than its upper layer", async () => {
    await expectFails(
      { fields: { relation: "stack", from_domain: "business/inventory", to_domain: "business/inventory" } },
      /stack.*from_domain.*base layer/s,
    )
  })

  it("an analogy within one domain is not refused", async () => {
    await expectPasses({ fields: { relation: "analogy", from_domain: "business/inventory", to_domain: "business/inventory" } })
  })
})

describe("fuse check: arguments", () => {
  it("lists every problem of a page, each once", async () => {
    const { output } = await checkPage({ fields: { relation: null, strength: "weak" }, sections: { gaps: null } })
    const problems = output.problems ?? []
    expect(problems.length).toBeGreaterThanOrEqual(3)
    expect(new Set(problems).size).toBe(problems.length)
  })

  it("requires --project and --file", async () => {
    const result = await runCli(["fuse", "check"])
    expect(result.exitCode).toBe(2)
    expect((result.output.problems as string[]).join("\n")).toMatch(/--project/)
    expect((result.output.problems as string[]).join("\n")).toMatch(/--file/)
  })

  it("refuses a project folder that is not there", async () => {
    const project = makeWiki()
    const { exitCode, output } = await checkFile(join(project, "missing"))
    expect(exitCode).toBe(2)
    expect(output.problems?.join("\n")).toMatch(/project folder not found/)
  })

  it("refuses a file that is not there", async () => {
    const { exitCode, output } = await checkFile(makeWiki())
    expect(exitCode).toBe(2)
    expect(output.problems?.join("\n")).toMatch(/cannot read/)
  })

  it("refuses a file outside the project", async () => {
    const { exitCode, output } = await checkFile(makeWiki(), "../outside.md")
    expect(exitCode).toBe(2)
    expect(output.problems?.join("\n")).toMatch(/outside the project/)
  })

  it("refuses a page that is not in wiki/hypotheses/", async () => {
    const project = makeWiki()
    writeProjectFile(project, "wiki/concepts/not-a-hypothesis.md", hypothesisPage())
    const { exitCode, output } = await checkFile(project, "wiki/concepts/not-a-hypothesis.md")
    expect(exitCode).toBe(2)
    expect(output.problems?.join("\n")).toMatch(/wiki\/hypotheses\//)
  })

  it("accepts a path with ./ and .. segments", async () => {
    const project = makeWiki()
    writeProjectFile(project, FILE, hypothesisPage())
    const { output } = await checkFile(project, "./wiki/concepts/../hypotheses/threshold-restocking.md")
    expect(output).toEqual({ ok: true, problems: [] })
  })

  it("rejects an option it does not know", async () => {
    const result = await runCli(["fuse", "check", "--project", "p", "--file", "f", "--bogus", "x"])
    expect(result.exitCode).toBe(2)
  })

  it("does not change the wiki", async () => {
    const project = makeWiki()
    writeProjectFile(project, FILE, hypothesisPage())
    const before = readFileSync(join(project, FILE), "utf8")
    await checkFile(project)
    expect(readFileSync(join(project, FILE), "utf8")).toBe(before)
  })
})
