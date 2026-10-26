/**
 * use-existing-domain.test.ts - the plan of "Use an existing domain" for a new-domain review item (spec 6.6).
 *
 * The plan reads pages as text and returns the new text of the pages that change. It writes nothing. Domains, slugs,
 * and raw names are placeholders.
 */
import { describe, expect, it } from "vitest"
import { pageOfMarkdown, planUseExistingDomain } from "./use-existing-domain"

const PROPOSED = "example/proposed"
const CHOSEN = "example/chosen"

function page(path: string, frontmatter: string[], body = "Body."): ReturnType<typeof pageOfMarkdown> {
  return pageOfMarkdown(path, ["---", ...frontmatter, "---", "", body, ""].join("\n"))
}

function plan(pages: ReturnType<typeof pageOfMarkdown>[], source = "raw/sources/note.md") {
  return planUseExistingDomain(pages, { source, proposed: PROPOSED, chosen: CHOSEN })
}

describe("planUseExistingDomain: which pages", () => {
  it("rewrites domain and also of the pages whose sources name the item's source, and no other page", () => {
    const mine = page("wiki/concepts/alpha.md", ["type: concept", `domain: ${PROPOSED}`, 'sources: ["note.md"]', "also: [example/other]"])
    const alsoOnly = page("wiki/entities/beta.md", ["type: entity", "domain: example/other", 'sources: ["note.md"]', `also: [${PROPOSED}]`])
    const other = page("wiki/concepts/gamma.md", ["type: concept", `domain: ${PROPOSED}`, 'sources: ["elsewhere.md"]'])
    const unrelated = page("wiki/concepts/delta.md", ["type: concept", "domain: example/other", 'sources: ["note.md"]'])

    const result = plan([mine, alsoOnly, other, unrelated])

    expect(result.problems).toEqual([])
    expect(result.edits.map((edit) => edit.path)).toEqual(["wiki/concepts/alpha.md", "wiki/entities/beta.md"])
    expect(result.edits[0].after).toBe(mine.markdown.replace(`domain: ${PROPOSED}`, `domain: ${CHOSEN}`))
    expect(result.edits[1].after).toBe(alsoOnly.markdown.replace(`also: [${PROPOSED}]`, `also: [${CHOSEN}]`))
  })

  it("keeps every other byte: quotes, comments, and CRLF line breaks", () => {
    const text = [
      "---",
      "type: concept",
      `domain: "${PROPOSED}"   # the proposed one`,
      "sources:",
      "  - note.md",
      "---",
      "",
      "Body.",
      "",
    ].join("\r\n")
    const result = plan([pageOfMarkdown("wiki/concepts/alpha.md", text)])
    expect(result.edits).toHaveLength(1)
    expect(result.edits[0].after).toBe(text.replace(`"${PROPOSED}"`, `"${CHOSEN}"`))
  })

  it("matches the source by the rule of the structure lint: prefix, folders, letter case, and a bare base name", () => {
    const names = ["note.md", "raw/sources/note.md", "./Note.MD", "C:/proj/raw/sources/note.md"]
    for (const name of names) {
      const p = page("wiki/concepts/alpha.md", ["type: concept", `domain: ${PROPOSED}`, `sources: ["${name}"]`])
      expect(plan([p]).edits, name).toHaveLength(1)
    }
    const nested = page("wiki/concepts/alpha.md", ["type: concept", `domain: ${PROPOSED}`, 'sources: ["web/note.md"]'])
    expect(plan([nested], "raw/sources/web/note.md").edits).toHaveLength(1)
    expect(plan([nested], "/home/user/proj/raw/sources/web/note.md").edits).toHaveLength(1)
    expect(plan([nested], "raw/sources/note.md").edits).toHaveLength(0)
  })

  it("matches a bare name to a source in a folder only when no other source with that name is named in the wiki", () => {
    const bare = page("wiki/concepts/alpha.md", ["type: concept", `domain: ${PROPOSED}`, 'sources: ["note.md"]'])
    expect(plan([bare], "raw/sources/web/note.md").edits).toHaveLength(1)

    const rival = page("wiki/concepts/rival.md", ["type: concept", "domain: example/other", 'sources: ["pdf/note.md"]'])
    expect(plan([bare, rival], "raw/sources/web/note.md").edits).toHaveLength(0)
    // The exact name still matches.
    const exact = page("wiki/concepts/beta.md", ["type: concept", `domain: ${PROPOSED}`, 'sources: ["web/note.md"]'])
    expect(plan([bare, rival, exact], "raw/sources/web/note.md").edits.map((edit) => edit.path)).toEqual(["wiki/concepts/beta.md"])
  })

  it("rewrites nothing for a hypothesis page", () => {
    const hypothesis = page("wiki/hypotheses/h.md", ["type: hypothesis", `to_domain: ${PROPOSED}`, "from_domain: example/other", 'sources: ["note.md"]'])
    expect(plan([hypothesis]).edits).toEqual([])
  })
})

describe("planUseExistingDomain: the also list", () => {
  it("removes an item that now repeats the domain of the page or an item before it", () => {
    const p = page("wiki/concepts/alpha.md", [
      "type: concept",
      `domain: ${PROPOSED}`,
      'sources: ["note.md"]',
      "also:",
      `  - ${CHOSEN}`,
      "  - example/other",
      `  - ${PROPOSED}`,
    ])
    const [edit] = plan([p]).edits
    expect(edit.after).toBe(
      ["---", "type: concept", `domain: ${CHOSEN}`, 'sources: ["note.md"]', "also:", "  - example/other", "---", "", "Body.", ""].join("\n"),
    )
  })

  it("leaves an also list alone when no item names the proposed domain and the page domain is not changed", () => {
    const p = page("wiki/concepts/alpha.md", ["type: concept", "domain: example/other", 'sources: ["note.md"]', `also: [${CHOSEN}, example/other]`])
    expect(plan([p]).edits).toEqual([])
  })
})

describe("planUseExistingDomain: Known instances lines", () => {
  const mechanism = (lines: string[]) =>
    pageOfMarkdown(
      "wiki/mechanisms/handshake.md",
      ["---", "type: mechanism", "title: Handshake", "---", "", "# Handshake", "", "## Known instances", "", ...lines, ""].join("\n"),
    )

  it("changes a line when its slug is a page of this ingest, and no other line", () => {
    const mine = page("wiki/concepts/alpha.md", ["type: concept", `domain: ${PROPOSED}`, 'sources: ["note.md"]'])
    const stranger = page("wiki/concepts/gamma.md", ["type: concept", `domain: ${PROPOSED}`, 'sources: ["elsewhere.md"]'])
    const m = mechanism([
      `- [[alpha]] (${PROPOSED}): in this ingest`,
      `- [[gamma]] (${PROPOSED}): in another ingest`,
      "- [[alpha]] (example/other): same slug, other domain",
      `- [[Alpha|the alpha]] (${PROPOSED}): different letter case and an alias`,
    ])
    const result = plan([mine, stranger, m])
    expect(result.problems).toEqual([])
    const edit = result.edits.find((candidate) => candidate.path === m.path)
    expect(edit?.after).toBe(
      m.markdown
        .replace(`- [[alpha]] (${PROPOSED}): in this ingest`, `- [[alpha]] (${CHOSEN}): in this ingest`)
        .replace(`- [[Alpha|the alpha]] (${PROPOSED})`, `- [[Alpha|the alpha]] (${CHOSEN})`),
    )
  })

  it("changes no line when no page of the ingest names the proposed domain", () => {
    const quiet = page("wiki/concepts/alpha.md", ["type: concept", "domain: example/other", 'sources: ["note.md"]'])
    expect(plan([quiet, mechanism([`- [[alpha]] (${PROPOSED}): x`])]).edits).toEqual([])
  })
})

describe("planUseExistingDomain: a page that cannot be edited", () => {
  it("reports the page by path and returns the pages that can be edited", () => {
    const flow = page("wiki/concepts/flow.md", ["{type: concept, domain: example/proposed, sources: [note.md]}"])
    const indented = pageOfMarkdown(
      "wiki/concepts/indented.md",
      `---\n  type: concept\n  domain: ${PROPOSED}\n  sources: [note.md]\n---\n\nBody.\n`,
    )
    const fine = page("wiki/concepts/fine.md", ["type: concept", `domain: ${PROPOSED}`, 'sources: ["note.md"]'])

    const result = plan([flow, indented, fine])

    expect(result.problems).toHaveLength(2)
    expect(result.problems[0]).toMatch(/^wiki\/concepts\/flow\.md: /)
    expect(result.problems[1]).toMatch(/^wiki\/concepts\/indented\.md: /)
    expect(result.edits.map((edit) => edit.path)).toEqual(["wiki/concepts/fine.md"])
  })

  it("reports a block scalar and a value over several lines", () => {
    const folded = page("wiki/concepts/folded.md", ["type: concept", "domain: >-", `  ${PROPOSED}`, 'sources: ["note.md"]'])
    expect(plan([folded]).problems).toEqual([expect.stringMatching(/^wiki\/concepts\/folded\.md: /)])
  })
})
