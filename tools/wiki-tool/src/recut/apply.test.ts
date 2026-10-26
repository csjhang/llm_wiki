/**
 * apply.test.ts - tests for `wiki-tool recut apply`.
 *
 * The tests run the command through runCli on a wiki that is a real temporary git repository (see recut-fixture.ts).
 * They check the files, the git history, and the output, not the internals. Domains, slugs, and titles are
 * placeholders.
 */
import { existsSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { parseDomainsYaml } from "@/lib/wiki-config/domains"
import { commitPathsLocked } from "../git"
import { GIT_LOCK_BUSY_MESSAGE } from "../git-lock"
import { commit, git, head } from "../lint/lint-fixture"
import { removeProjects } from "../test-project"
import {
  ALPHA,
  applyPlan,
  BETA,
  CHILD,
  DOMAINS_YAML,
  FOUR,
  HANDSHAKE,
  IDEA,
  indexFiles,
  lastBody,
  lastCommitFiles,
  lastSubject,
  makeRecutRepo,
  ONE,
  read,
  runRecut,
  status,
  THREE,
  TWO,
  ZETA,
} from "./recut-fixture"

// The real helper, except in the tests that make the commit fail.
vi.mock("../git", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../git")>()
  return { ...actual, commitPathsLocked: vi.fn(actual.commitPathsLocked) }
})

// Each test starts several git processes; a busy machine needs more than the default 5 s.
vi.setConfig({ testTimeout: 30_000 })

afterEach(() => {
  removeProjects()
  vi.mocked(commitPathsLocked).mockClear()
})

const GAMMA = "example/gamma"
const INTO = (domain: string, lens = "ai") => ({ domain, lens, description: `About ${domain}` })

function domainNames(project: string): string[] {
  const parsed = parseDomainsYaml(read(project, "domains.yaml"))
  if (!parsed.ok) throw new Error(`domains.yaml is not valid: ${JSON.stringify(parsed.issues)}`)
  return Object.keys(parsed.value.domains)
}

describe("recut apply: rename", () => {
  const plan = { op: "rename", from: ALPHA, to: GAMMA }

  it("rename moves child domains", async () => {
    const project = makeRecutRepo()
    const result = await applyPlan(project, plan)
    expect(result.exitCode).toBe(0)
    expect(result.output.ok).toBe(true)

    // domains.yaml: the key lines changed, the comments and every other entry stayed.
    expect(read(project, "domains.yaml")).toBe(
      DOMAINS_YAML.replace(`  ${ALPHA}:\n`, `  ${GAMMA}:\n`).replace(`  ${CHILD}:\n`, `  ${GAMMA}/child:\n`),
    )
    expect(domainNames(project)).toEqual([GAMMA, `${GAMMA}/child`, BETA, ZETA])

    // Pages: domain, also, hypothesis keys, and the instance line of the mechanism page.
    expect(read(project, "wiki/concepts/one.md")).toBe(ONE.replace(`domain: ${ALPHA}   #`, `domain: ${GAMMA}   #`))
    expect(read(project, "wiki/concepts/two.md")).toBe(TWO.replace(CHILD, `${GAMMA}/child`))
    expect(read(project, "wiki/entities/three.md")).toBe(THREE.replace(`also: [${ALPHA}]`, `also: [${GAMMA}]`))
    expect(read(project, "wiki/hypotheses/idea.md")).toBe(IDEA.replace(`from_domain: ${ALPHA}`, `from_domain: ${GAMMA}`))
    expect(read(project, "wiki/mechanisms/handshake.md")).toBe(
      HANDSHAKE.replace(`- [[one]] (${ALPHA}): request`, `- [[one]] (${GAMMA}): request`),
    )
    expect(read(project, "wiki/concepts/four.md")).toBe(FOUR)

    expect(result.output.pages).toEqual([
      "wiki/concepts/one.md",
      "wiki/concepts/two.md",
      "wiki/entities/three.md",
      "wiki/hypotheses/idea.md",
      "wiki/mechanisms/handshake.md",
    ])
    expect(result.output.sha).toBe(head(project))
    expect(result.output.mergeCandidates).toBeUndefined()
    expect(status(project)).toBe("")
  })

  it("rebuilds the domain index and removes the index of a domain that is gone", async () => {
    const project = makeRecutRepo()
    await applyPlan(project, plan)
    expect(read(project, "wiki/indexes/example--gamma.md")).toBe("# example/gamma\n\n## Concept\n\n- [[one]] — One: a placeholder\n")
    expect(read(project, "wiki/indexes/example--gamma--child.md")).toBe("# example/gamma/child\n\n## Concept\n\n- [[two]] — Two\n")
    expect(read(project, "wiki/index.md")).toBe(
      [
        "# Wiki Index",
        "",
        "- [example/beta](indexes/example--beta.md) — 2 pages",
        "- [example/gamma](indexes/example--gamma.md) — 1 pages",
        "- [example/gamma/child](indexes/example--gamma--child.md) — 1 pages",
        "- [example/zeta](indexes/example--zeta.md) — 1 pages",
        "- [Mechanisms](indexes/_mechanisms.md) — 1 pages",
        "- Unassigned — 0 pages",
        "",
      ].join("\n"),
    )
    expect(existsSync(join(project, "wiki/indexes/example--alpha.md"))).toBe(false)
    expect(existsSync(join(project, "wiki/indexes/example--alpha--child.md"))).toBe(false)
    // The index files of the other domains did not change, so they are not in the commit.
    expect(lastCommitFiles(project)).toEqual([
      "M domains.yaml",
      "M wiki/concepts/one.md",
      "M wiki/concepts/two.md",
      "M wiki/entities/three.md",
      "M wiki/hypotheses/idea.md",
      "M wiki/index.md",
      "D wiki/indexes/example--alpha--child.md",
      "D wiki/indexes/example--alpha.md",
      "A wiki/indexes/example--gamma--child.md",
      "A wiki/indexes/example--gamma.md",
      "M wiki/mechanisms/handshake.md",
    ])
  })

  it("commit subject format", async () => {
    const project = makeRecutRepo()
    await applyPlan(project, plan)
    expect(lastSubject(project)).toBe(`recut: rename ${ALPHA} → ${GAMMA} (5 pages)`)
    // The body lists the changed wiki pages, not domains.yaml or the index files.
    expect(lastBody(project).split("\n")).toEqual([
      "- wiki/concepts/one.md",
      "- wiki/concepts/two.md",
      "- wiki/entities/three.md",
      "- wiki/hypotheses/idea.md",
      "- wiki/mechanisms/handshake.md",
    ])
  })

  it("cuts a long subject to 72 characters and keeps the count", async () => {
    const project = makeRecutRepo()
    const target = `example/${"a-very-long-name-".repeat(5)}end`
    await applyPlan(project, { op: "rename", from: ALPHA, to: target })
    const subject = lastSubject(project)
    expect(subject.length).toBeLessThanOrEqual(72)
    expect(subject.startsWith("recut: rename example/alpha → example/a-very-long-name-")).toBe(true)
    expect(subject.endsWith("… (5 pages)")).toBe(true)
  })

  it("keeps other frontmatter bytes", async () => {
    const project = makeRecutRepo()
    await applyPlan(project, plan)
    const diff = git(project, "diff", "--unified=0", "HEAD~1", "HEAD", "--", "wiki/concepts/one.md")
    const changed = diff.split("\n").filter((line) => /^[-+]/.test(line) && !/^(---|\+\+\+)/.test(line))
    expect(changed).toEqual([`-domain: ${ALPHA}   # the domain`, `+domain: ${GAMMA}   # the domain`])
  })

  it("also moves a domain below another parent", async () => {
    const project = makeRecutRepo()
    const result = await applyPlan(project, { op: "move", from: ALPHA, to: `${ZETA}/alpha` })
    expect(result.exitCode).toBe(0)
    expect(domainNames(project)).toEqual([`${ZETA}/alpha`, `${ZETA}/alpha/child`, BETA, ZETA])
    expect(read(project, "wiki/concepts/one.md")).toContain(`domain: ${ZETA}/alpha   # the domain`)
    expect(lastSubject(project)).toBe(`recut: move ${ALPHA} → ${ZETA}/alpha (5 pages)`)
  })

  it("makes a commit when no page changes, for a domain nobody uses", async () => {
    const project = makeRecutRepo({ "wiki/concepts/four.md": FOUR.replace(ZETA, BETA) })
    const result = await applyPlan(project, { op: "rename", from: ZETA, to: "example/omega" })
    expect(result.output.pages).toEqual([])
    expect(lastSubject(project)).toBe(`recut: rename ${ZETA} → example/omega (0 pages)`)
    expect(domainNames(project)).toContain("example/omega")
  })
})

describe("recut apply: split", () => {
  const LEFT = "example/left"
  const RIGHT = "example/right"
  const assignments = {
    "wiki/concepts/one.md": LEFT,
    "wiki/entities/three.md": RIGHT,
    "wiki/hypotheses/idea.md": RIGHT,
  }
  const plan = { op: "split", from: ALPHA, into: [INTO(LEFT), INTO(RIGHT, "physics")], assignments }

  it("split assigns pages", async () => {
    const project = makeRecutRepo()
    const result = await applyPlan(project, plan)
    expect(result.exitCode).toBe(0)

    expect(read(project, "wiki/concepts/one.md")).toBe(ONE.replace(`domain: ${ALPHA}   #`, `domain: ${LEFT}   #`))
    expect(read(project, "wiki/entities/three.md")).toBe(THREE.replace(`also: [${ALPHA}]`, `also: [${RIGHT}]`))
    expect(read(project, "wiki/hypotheses/idea.md")).toBe(IDEA.replace(`from_domain: ${ALPHA}`, `from_domain: ${RIGHT}`))
    // The instance line takes the domain that its page was assigned.
    expect(read(project, "wiki/mechanisms/handshake.md")).toBe(
      HANDSHAKE.replace(`- [[one]] (${ALPHA}): request`, `- [[one]] (${LEFT}): request`),
    )
    expect(read(project, "wiki/concepts/two.md")).toBe(TWO)

    // domains.yaml: the new entries stand where the old one stood; the comment above it stays.
    expect(read(project, "domains.yaml")).toBe(
      [
        "# Domain list of the recut test wiki.",
        "version: 1",
        "domains:",
        "  # The first domain.",
        `  ${LEFT}:`,
        "    lens: ai",
        `    description: About ${LEFT}`,
        "    whiteboards: []",
        `  ${RIGHT}:`,
        "    lens: physics",
        `    description: About ${RIGHT}`,
        "    whiteboards: []",
        `  ${CHILD}:`,
        "    lens: hardware",
        "    description: Child of alpha",
        `  ${BETA}:`,
        "    lens: business",
        "    description: Beta domain",
        `  ${ZETA}:`,
        "    lens: physics",
        "    description: Zeta domain",
        "",
      ].join("\n"),
    )
    expect(result.output.pages).toEqual(["wiki/concepts/one.md", "wiki/entities/three.md", "wiki/hypotheses/idea.md", "wiki/mechanisms/handshake.md"])
    expect(result.output.notes).toEqual([`These child domains stay as they are: ${CHILD}.`, expect.stringContaining(`${ALPHA} → ${LEFT} or ${RIGHT}`)])
    expect(lastSubject(project)).toBe(`recut: split ${ALPHA} → ${LEFT}+${RIGHT} (4 pages)`)
    expect(read(project, "wiki/indexes/example--left.md")).toBe("# example/left\n\n## Concept\n\n- [[one]] — One: a placeholder\n")
    expect(existsSync(join(project, "wiki/indexes/example--alpha.md"))).toBe(false)
    expect(status(project)).toBe("")
  })

  it("rejects unassigned pages", async () => {
    const project = makeRecutRepo()
    const before = head(project)
    const { "wiki/entities/three.md": _left, ...partial } = assignments
    const result = await applyPlan(project, { ...plan, assignments: partial })
    expect(result.exitCode).toBe(2)
    expect(result.output.ok).toBe(false)
    expect(result.output.problems).toEqual(["the split leaves 1 page without a new domain: wiki/entities/three.md"])
    expect(head(project)).toBe(before)
    expect(status(project)).toBe("")
  })

  it("rejects an assignment to a domain that the split does not make", async () => {
    const project = makeRecutRepo()
    const result = await applyPlan(project, { ...plan, assignments: { ...assignments, "wiki/concepts/one.md": BETA } })
    expect(result.exitCode).toBe(2)
    expect(result.output.problems).toEqual([`the assignment of wiki/concepts/one.md names ${BETA}, which is not in "into"`])
  })

  it("applies the assignment of a hypothesis to the key that names the domain", async () => {
    const both = IDEA.replace(`to_domain: ${BETA}`, `to_domain: ${ALPHA}`)
    const project = makeRecutRepo({ "wiki/hypotheses/idea.md": both })
    await applyPlan(project, plan)
    expect(read(project, "wiki/hypotheses/idea.md")).toBe(both.split(ALPHA).join(RIGHT))
  })

  it("leaves a dismissed fusion pair alone", async () => {
    const project = makeRecutRepo()
    const dismissed = `[\n  { "mechanism": "wiki/mechanisms/handshake.md", "targetDomain": "${ALPHA}" }\n]\n`
    writeFile(project, ".llm-wiki/fusion-dismissed.json", dismissed)
    await applyPlan(project, plan)
    expect(read(project, ".llm-wiki/fusion-dismissed.json")).toBe(dismissed)
  })
})

// Final review, I3 (ruling U21): a work wiki that reads this wiki names its domains in hypothesis pages. A recut here
// cannot change those pages, so the output must say that they need the new names.
describe("recut apply: the reading wiki is the library of work wikis", () => {
  const WORK_NOTE_START = "This is a reading wiki. A work wiki whose mechanism_library is this wiki keeps the old names in the from_domain and to_domain of its hypothesis pages."

  it("lists the old and new name of every renamed domain, child domains included", async () => {
    const project = makeRecutRepo()
    const result = await applyPlan(project, { op: "rename", from: ALPHA, to: GAMMA })
    expect(result.exitCode).toBe(0)
    expect(result.output.notes).toEqual([
      `${WORK_NOTE_START} Those pages need the new names: ${ALPHA} → ${GAMMA}; ${CHILD} → ${GAMMA}/child. Until then, fuse check and the lint of that work wiki report them.`,
    ])
  })

  it("lists the new domains of a split", async () => {
    const project = makeRecutRepo()
    const into = [{ domain: "example/alpha-1", lens: "hardware", description: "One" }, { domain: "example/alpha-2", lens: "hardware", description: "Two" }]
    const listed = await runRecut<{ pages: Array<{ path: string }> }>("pages", project, "--domain", ALPHA)
    const assignments = Object.fromEntries(listed.output.pages.map((entry) => [entry.path, "example/alpha-1"]))
    const result = await applyPlan(project, { op: "split", from: ALPHA, into, assignments })
    expect(result.exitCode).toBe(0)
    expect(result.output.notes).toContain(
      `${WORK_NOTE_START} Those pages need the new names: ${ALPHA} → example/alpha-1 or example/alpha-2. Until then, fuse check and the lint of that work wiki report them.`,
    )
  })

  it("lists each merged domain that gets another name, and not the target that keeps its name", async () => {
    const project = makeRecutRepo()
    const result = await applyPlan(project, { op: "merge", from: [ALPHA, BETA], into: INTO(BETA, "business") })
    expect(result.exitCode).toBe(0)
    expect(result.output.notes).toContain(
      `${WORK_NOTE_START} Those pages need the new names: ${ALPHA} → ${BETA}. Until then, fuse check and the lint of that work wiki report them.`,
    )
    const both = makeRecutRepo()
    const merged = await applyPlan(both, { op: "merge", from: [BETA, ALPHA], into: INTO(GAMMA) })
    expect(merged.output.notes).toContain(
      `${WORK_NOTE_START} Those pages need the new names: ${BETA} → ${GAMMA}; ${ALPHA} → ${GAMMA}. Until then, fuse check and the lint of that work wiki report them.`,
    )
  })

  it("adds no note in a work wiki", async () => {
    const library = makeRecutRepo()
    const project = makeRecutRepo({ "wiki.yaml": `version: 1\nid: work\nrole: work\nmechanism_library: ${library}\n` })
    const result = await applyPlan(project, { op: "rename", from: ALPHA, to: GAMMA })
    expect(result.exitCode).toBe(0)
    expect(result.output.notes ?? []).toEqual([])
  })

  it("gives the note for a missing wiki.yaml too, which reads as a reading wiki", async () => {
    const project = makeRecutRepo()
    rmFile(project, "wiki.yaml")
    git(project, "add", "-A")
    git(project, "commit", "--quiet", "--no-verify", "-m", "remove wiki.yaml")
    const result = await applyPlan(project, { op: "rename", from: ALPHA, to: GAMMA })
    expect(result.exitCode).toBe(0)
    expect(result.output.notes?.[0]).toContain("This is a reading wiki.")
  })
})

describe("recut apply: merge", () => {
  const SHARED_ALPHA = ["---", "type: concept", "title: Shared", `domain: ${ALPHA}`, "---", "", "# Shared", ""].join("\n")
  const SHARED_BETA = ["---", "type: entity", "title: Shared", `domain: ${BETA}`, "---", "", "# Shared", ""].join("\n")
  const extra = { "wiki/concepts/shared.md": SHARED_ALPHA, "wiki/entities/shared.md": SHARED_BETA }
  const plan = { op: "merge", from: [ALPHA, BETA], into: INTO(GAMMA) }

  it("merge reports same-slug pairs", async () => {
    const project = makeRecutRepo(extra)
    const result = await applyPlan(project, plan)
    expect(result.exitCode).toBe(0)
    expect(result.output.mergeCandidates).toEqual([{ a: "wiki/concepts/shared.md", b: "wiki/entities/shared.md" }])
    expect(lastSubject(project)).toBe(`recut: merge ${ALPHA}+${BETA} → ${GAMMA} (6 pages)`)
  })

  it("reports the pair that the app made with a domain suffix", async () => {
    const attention = (domain: string) => ["---", "type: concept", "title: Attention", `domain: ${domain}`, "---", "", "# Attention", ""].join("\n")
    const project = makeRecutRepo({
      "wiki/concepts/attention.md": attention(ALPHA),
      "wiki/concepts/attention--beta.md": attention(BETA),
    })
    const result = await applyPlan(project, plan)
    expect(result.exitCode).toBe(0)
    expect(result.output.mergeCandidates).toEqual([{ a: "wiki/concepts/attention--beta.md", b: "wiki/concepts/attention.md" }])
  })

  // Final review, M1.
  it("refuses a merge that gives a stack hypothesis one domain, and writes nothing", async () => {
    const stack = IDEA.replace("type: hypothesis", "type: hypothesis\nrelation: stack")
    const project = makeRecutRepo({ "wiki/hypotheses/idea.md": stack })
    const result = await applyPlan(project, plan)
    expect(result.exitCode).toBe(2)
    expect(result.output.problems).toEqual([expect.stringMatching(/^wiki\/hypotheses\/idea\.md: relation stack needs two domains/)])
    expect(status(project)).toBe("")
  })

  it("names an analogy hypothesis that the merge gives one domain", async () => {
    const analogy = IDEA.replace("type: hypothesis", "type: hypothesis\nrelation: analogy")
    const project = makeRecutRepo({ "wiki/hypotheses/idea.md": analogy })
    const result = await applyPlan(project, plan)
    expect(result.exitCode).toBe(0)
    expect(result.output.notes).toContain(
      `wiki/hypotheses/idea.md: this analogy now has the same domain ${GAMMA} in from_domain and to_domain. Check if it still makes sense.`,
    )
  })

  it("rewrites the pages and the domain list of a merge", async () => {
    const project = makeRecutRepo(extra)
    await applyPlan(project, plan)
    expect(domainNames(project)).toEqual([GAMMA, CHILD, ZETA])
    expect(read(project, "domains.yaml")).toContain(`  # The first domain.\n  ${GAMMA}:\n    lens: ai\n    description: About ${GAMMA}\n    whiteboards: []\n  ${CHILD}:\n`)
    expect(read(project, "wiki/concepts/one.md")).toContain(`domain: ${GAMMA}   # the domain`)
    // The also item repeats the new domain of the page, so it goes.
    expect(read(project, "wiki/entities/three.md")).toBe(THREE.replace(`domain: ${BETA}`, `domain: ${GAMMA}`).replace(`also: [${ALPHA}]`, "also: []"))
    expect(read(project, "wiki/hypotheses/idea.md")).toContain(`from_domain: ${GAMMA}\nto_domain: ${GAMMA}\n`)
    expect(read(project, "wiki/mechanisms/handshake.md")).toContain(`- [[one]] (${GAMMA}): request and acknowledge\n- [[three]] (${GAMMA}): order and delivery\n`)
    expect(read(project, "wiki/indexes/example--gamma.md")).toBe(
      "# example/gamma\n\n## Entity\n\n- [[shared]] — Shared\n- [[three]] — Three\n\n## Concept\n\n- [[one]] — One: a placeholder\n- [[shared]] — Shared\n\n## Hypothesis\n\n- [[idea]] — Idea\n",
    )
    expect(existsSync(join(project, "wiki/indexes/example--beta.md"))).toBe(false)
  })

  it("merges into one of the merged domains, and into another domain that exists", async () => {
    const intoOne = makeRecutRepo()
    const merged = await applyPlan(intoOne, { op: "merge", from: [ALPHA, BETA], into: INTO(BETA, "business") })
    expect(merged.output.mergeCandidates).toEqual([])
    expect(domainNames(intoOne)).toEqual([CHILD, BETA, ZETA])
    expect(read(intoOne, "wiki/concepts/one.md")).toContain(`domain: ${BETA}   # the domain`)

    const intoOther = makeRecutRepo()
    await applyPlan(intoOther, { op: "merge", from: [ALPHA, BETA], into: INTO(ZETA, "physics") })
    expect(domainNames(intoOther)).toEqual([CHILD, ZETA])
    expect(read(intoOther, "domains.yaml")).toContain(`  ${ZETA}:\n    lens: physics\n    description: About ${ZETA}\n`)
  })

  it("rewrites and merges the dismissed fusion pairs", async () => {
    const project = makeRecutRepo()
    const pair = (targetDomain: string) => ({ mechanism: "wiki/mechanisms/handshake.md", targetDomain })
    writeFile(project, ".llm-wiki/fusion-dismissed.json", JSON.stringify([pair(ALPHA), pair(BETA), pair(ZETA), "not a pair", { unrelated: 1 }], null, 2))
    await applyPlan(project, plan)
    expect(JSON.parse(read(project, ".llm-wiki/fusion-dismissed.json"))).toEqual([pair(GAMMA), pair(ZETA), "not a pair", { unrelated: 1 }])
    expect(read(project, ".llm-wiki/fusion-dismissed.json").endsWith("\n")).toBe(true)
  })
})

describe("recut apply: dismissed fusion pairs", () => {
  const FILE = ".llm-wiki/fusion-dismissed.json"
  const plan = { op: "rename", from: ALPHA, to: GAMMA }

  it("rewrites the target domain of a pair, also below the domain, and writes the file as the app does", async () => {
    const project = makeRecutRepo()
    const pair = (targetDomain: string) => ({ mechanism: "wiki/mechanisms/handshake.md", targetDomain })
    writeFile(project, FILE, JSON.stringify([pair(ALPHA), pair(CHILD), pair(BETA)]))
    await applyPlan(project, plan)
    expect(read(project, FILE)).toBe(`${JSON.stringify([pair(GAMMA), pair(`${GAMMA}/child`), pair(BETA)], null, 2)}\n`)
    // The file is a local one: it is not in the commit.
    expect(lastCommitFiles(project).some((line) => line.includes(".llm-wiki"))).toBe(false)
  })

  it("leaves a file that is not a list of pairs, a file that is not JSON, and a missing file alone", async () => {
    for (const text of ['{"a":1}', "not json {", null]) {
      const project = makeRecutRepo()
      if (text !== null) writeFile(project, FILE, text)
      const result = await applyPlan(project, plan)
      expect(result.exitCode).toBe(0)
      if (text === null) expect(existsSync(join(project, FILE))).toBe(false)
      else expect(read(project, FILE)).toBe(text)
    }
  })
})

describe("recut apply: the work tree", () => {
  const plan = { op: "rename", from: ALPHA, to: GAMMA }

  it("refuses a dirty tree", async () => {
    const dirty: Array<[string, (project: string) => void]> = [
      ["an edited page", (p) => writeFile(p, "wiki/concepts/four.md", `${FOUR}Edited.\n`)],
      ["an edited domains.yaml", (p) => writeFile(p, "domains.yaml", `${DOMAINS_YAML}# edited\n`)],
      ["a new file under wiki/", (p) => writeFile(p, "wiki/concepts/new.md", "New.\n")],
      ["a staged file", (p) => { writeFile(p, "notes.txt", "Staged.\n"); git(p, "add", "notes.txt") }],
      ["a deleted page", (p) => rmFile(p, "wiki/concepts/four.md")],
    ]
    for (const [name, make] of dirty) {
      const project = makeRecutRepo()
      make(project)
      const before = head(project)
      const state = status(project)
      const result = await applyPlan(project, plan)
      expect(result.exitCode, name).toBe(2)
      expect(result.output.problems?.[0], name).toMatch(/uncommitted changes/)
      expect(head(project), name).toBe(before)
      expect(status(project), name).toBe(state)
      expect(read(project, "wiki/concepts/one.md"), name).toBe(ONE)
    }
  })

  it("names the changed files in the message", async () => {
    const project = makeRecutRepo()
    writeFile(project, "wiki/concepts/four.md", `${FOUR}Edited.\n`)
    writeFile(project, "wiki/concepts/new.md", "New.\n")
    const result = await applyPlan(project, plan)
    expect(result.output.problems).toEqual([
      "the working tree has uncommitted changes: wiki/concepts/four.md, wiki/concepts/new.md. Commit or stash them, then run the recut again.",
    ])
  })

  it("ignores the card map and everything under .llm-wiki/", async () => {
    const project = makeRecutRepo({ "heptabase-map.json": '{"version":1,"pages":{}}\n' })
    writeFile(project, "heptabase-map.json", '{"version":1,"pages":{"wiki/concepts/four.md":{}}}\n')
    writeFile(project, ".llm-wiki/semantic-lint.json", "{}")
    writeFile(project, ".llm-wiki/hepta/outbox/x.md", "text")
    const result = await applyPlan(project, plan)
    expect(result.exitCode).toBe(0)
    // The card map is the user's own work: it stays as it was, and it is not in the commit.
    expect(read(project, "heptabase-map.json")).toBe('{"version":1,"pages":{"wiki/concepts/four.md":{}}}\n')
    expect(lastCommitFiles(project).some((line) => line.includes("heptabase-map.json") || line.includes(".llm-wiki"))).toBe(false)
    expect(status(project)).toBe(" M heptabase-map.json\n")
  })

  it("ignores an untracked card map and a staged card map", async () => {
    const untracked = makeRecutRepo()
    writeFile(untracked, "heptabase-map.json", "{}\n")
    expect((await applyPlan(untracked, plan)).exitCode).toBe(0)

    const staged = makeRecutRepo()
    writeFile(staged, "heptabase-map.json", "{}\n")
    git(staged, "add", "heptabase-map.json")
    expect((await applyPlan(staged, plan)).exitCode).toBe(0)
    expect(status(staged)).toBe("A  heptabase-map.json\n")
  })

  it("never commits .llm-wiki/, also when git does not ignore it", async () => {
    const project = makeRecutRepo({}, { ignoreLlmWiki: false })
    writeFile(project, ".llm-wiki/fusion-dismissed.json", "[]")
    const result = await applyPlan(project, plan)
    expect(result.exitCode).toBe(0)
    expect(lastCommitFiles(project).some((line) => line.includes(".llm-wiki"))).toBe(false)
  })

  it("works for a wiki that is a folder of a larger repository", async () => {
    const project = makeRecutRepo({}, { prefix: "wikis/main" })
    const result = await applyPlan(project, plan)
    expect(result.exitCode).toBe(0)
    expect(result.output.pages).toHaveLength(5)
    expect(read(project, "wiki/concepts/one.md")).toContain(`domain: ${GAMMA}`)
    expect(lastCommitFiles(project)).toContain("M wikis/main/domains.yaml")
    expect(status(project)).toBe("")
  })

  it("does not count a change outside the wiki folder of a larger repository", async () => {
    const project = makeRecutRepo({}, { prefix: "wikis/main" })
    writeFile(dirname(dirname(project)), "other/notes.txt", "Elsewhere.\n")
    expect((await applyPlan(project, plan)).exitCode).toBe(0)
    expect(status(project)).toBe("?? other/\n")
  })

  it("refuses a folder that is no git repository", async () => {
    const project = makeRecutRepo()
    rmFile(project, ".git")
    const result = await applyPlan(project, plan)
    expect(result.exitCode).toBe(2)
    expect(result.output.problems).toEqual([`not inside a git work tree: ${project}`])
  })
})

describe("recut apply: the plan", () => {
  it("reads the plan from a file", async () => {
    const project = makeRecutRepo()
    writeFile(project, ".llm-wiki/recut-plan.json", JSON.stringify({ op: "rename", from: ALPHA, to: GAMMA }))
    const result = await runRecut("apply", project, "--plan", join(project, ".llm-wiki/recut-plan.json"))
    expect(result.exitCode).toBe(0)
    expect(domainNames(project)[0]).toBe(GAMMA)
  })

  it("names a file that cannot be read", async () => {
    const project = makeRecutRepo()
    const result = await runRecut("apply", project, "--plan", join(project, "missing-plan.json"))
    expect(result.exitCode).toBe(2)
    expect(result.output.problems).toEqual([`cannot read the plan file: ${join(project, "missing-plan.json")}`])
  })

  it("names every problem of a plan that is wrong, and changes nothing", async () => {
    const project = makeRecutRepo()
    const before = head(project)
    const cases: Array<[unknown, RegExp]> = [
      [{ op: "rename", from: "example/missing", to: GAMMA }, /example\/missing is not in domains.yaml/],
      [{ op: "rename", from: ALPHA, to: BETA }, /example\/beta already exists/],
      [{ op: "rename", from: ALPHA, to: "Not A Name" }, /not a domain name/],
      [{ op: "merge", from: [ALPHA], into: INTO(GAMMA) }, /at least two domains/],
      [{ op: "split", from: ALPHA, into: [INTO(GAMMA, "cooking")], assignments: {} }, /lens "cooking"/],
      [{ op: "rename", from: ALPHA }, /needs "to"/],
    ]
    for (const [plan, pattern] of cases) {
      const result = await applyPlan(project, plan)
      expect(result.exitCode).toBe(2)
      expect(result.output.problems?.join("\n")).toMatch(pattern)
    }
    expect((await runRecut("apply", project, "--plan", "{not json")).output.problems?.[0]).toMatch(/not valid JSON/)
    expect(head(project)).toBe(before)
    expect(status(project)).toBe("")
  })

  it("needs --project and --plan, and a project that is a mechanism wiki", async () => {
    const project = makeRecutRepo()
    expect((await runRecut("apply", project)).output.problems).toEqual(["missing option: --plan"])
    expect((await runRecut("apply", project, "--plan", "{}", "--other", "x")).output.problems).toEqual(["unknown option: --other"])
    expect((await runRecut("apply", "/nonexistent/project", "--plan", "{}")).output.problems).toEqual(["project folder not found: /nonexistent/project"])
    rmFile(project, "domains.yaml")
    git(project, "add", "-A")
    git(project, "commit", "--quiet", "--no-verify", "-m", "remove domains.yaml")
    expect((await applyPlan(project, { op: "rename", from: ALPHA, to: GAMMA })).output.problems).toEqual([
      `not a mechanism wiki: domains.yaml is missing in ${project}`,
    ])
  })

  it("stops on a domains.yaml that is not valid", async () => {
    const project = makeRecutRepo()
    commit(project, "break domains.yaml", { "domains.yaml": "version: 1\ndomains:\n  example/alpha:\n    lens: cooking\n    description: Bad lens\n" })
    const result = await applyPlan(project, { op: "rename", from: ALPHA, to: GAMMA })
    expect(result.exitCode).toBe(2)
    expect(result.output.problems?.[0]).toMatch(/^domains\.yaml:domains\.example\/alpha\.lens/)
  })

  it("leaves the domains of the reading wiki alone in a work wiki", async () => {
    const library = makeRecutRepo()
    const hypothesis = ["---", "type: hypothesis", "title: Cross", `from_domain: ${ALPHA}`, "to_domain: library/topic", "---", "", "# Cross", ""].join("\n")
    const project = makeRecutRepo({
      "wiki.yaml": `version: 1\nid: work\nrole: work\nmechanism_library: ${library}\n`,
      "wiki/hypotheses/cross.md": hypothesis,
    })
    const result = await applyPlan(project, { op: "rename", from: ALPHA, to: GAMMA })
    expect(result.exitCode).toBe(0)
    expect(read(project, "wiki/hypotheses/cross.md")).toBe(hypothesis.replace(`from_domain: ${ALPHA}`, `from_domain: ${GAMMA}`))
  })

  it("keeps a byte order mark and the line breaks of domains.yaml", async () => {
    const crlf = `\uFEFF${DOMAINS_YAML.replace(/\n/g, "\r\n")}`
    const project = makeRecutRepo()
    commit(project, "windows domains.yaml", { "domains.yaml": crlf })
    const result = await applyPlan(project, { op: "rename", from: ALPHA, to: GAMMA })
    expect(result.exitCode).toBe(0)
    expect(read(project, "domains.yaml")).toBe(crlf.replace(`  ${ALPHA}:`, `  ${GAMMA}:`).replace(`  ${CHILD}:`, `  ${GAMMA}/child:`))
  })

  it("accepts a lens that has a file in lenses/", async () => {
    const project = makeRecutRepo({ "lenses/cooking.md": "# Cooking\n" })
    const result = await applyPlan(project, { op: "merge", from: [ALPHA, BETA], into: { domain: GAMMA, lens: "cooking", description: "Cooking" } })
    expect(result.exitCode).toBe(0)
  })
})

describe("recut apply: a page that cannot be edited, and a failed commit", () => {
  const plan = { op: "rename", from: ALPHA, to: GAMMA }

  it("names the page and changes nothing", async () => {
    const project = makeRecutRepo({ "wiki/concepts/one.md": ONE.replace(`domain: ${ALPHA}   # the domain`, `domain: |\n  ${ALPHA}`) })
    const before = head(project)
    const result = await applyPlan(project, plan)
    expect(result.exitCode).toBe(2)
    expect(result.output.problems).toEqual([expect.stringMatching(/^wiki\/concepts\/one\.md: domain /)])
    expect(head(project)).toBe(before)
    expect(status(project)).toBe("")
    expect(read(project, "domains.yaml")).toBe(DOMAINS_YAML)
  })

  it("refuses a page that is a link, and a page that is not valid UTF-8", async () => {
    const linked = makeRecutRepo()
    symlinkSync("one.md", join(linked, "wiki/concepts/alias.md"))
    commit(linked, "add a link")
    const link = await applyPlan(linked, plan)
    expect(link.exitCode).toBe(2)
    expect(link.output.problems).toEqual(["wiki/concepts/alias.md: the file is a link, so a recut cannot edit it safely"])
    expect(status(linked)).toBe("")

    const broken = makeRecutRepo()
    writeFileSync(join(broken, "wiki/concepts/one.md"), Buffer.concat([Buffer.from(ONE), Buffer.from([0xff, 0xfe, 0x0a])]))
    commit(broken, "add bytes that are not UTF-8")
    const bytes = await applyPlan(broken, plan)
    expect(bytes.exitCode).toBe(2)
    expect(bytes.output.problems).toEqual(["wiki/concepts/one.md: the file is not valid UTF-8, so a recut cannot edit it safely"])
  })

  it("leaves a page alone that it does not need to edit, whatever its form", async () => {
    // The page of beta has a form that the editor refuses, but a rename of alpha does not touch it.
    const odd = "---\ntype: concept\ndomain: |\n  example/beta\n---\nBody\n"
    const project = makeRecutRepo({ "wiki/concepts/odd.md": odd })
    const result = await applyPlan(project, plan)
    expect(result.exitCode).toBe(0)
    expect(read(project, "wiki/concepts/odd.md")).toBe(odd)
  })

  it("puts every file back when the commit fails", async () => {
    const project = makeRecutRepo()
    vi.mocked(commitPathsLocked).mockResolvedValueOnce({ ok: false, problem: "Cannot commit while a rebase is in progress." })
    const before = head(project)
    const result = await applyPlan(project, plan)
    expect(result.exitCode).toBe(2)
    expect(result.output.problems).toEqual(["Cannot commit while a rebase is in progress."])
    expect(head(project)).toBe(before)
    expect(status(project)).toBe("")
    expect(read(project, "domains.yaml")).toBe(DOMAINS_YAML)
    expect(read(project, "wiki/index.md")).toBe(indexFiles(project)["wiki/index.md"])
    expect(existsSync(join(project, "wiki/indexes/example--gamma.md"))).toBe(false)
  })

  it("puts every file back and says so when another tool holds the git lock", async () => {
    const project = makeRecutRepo()
    vi.mocked(commitPathsLocked).mockRejectedValueOnce(new Error(GIT_LOCK_BUSY_MESSAGE))
    const result = await applyPlan(project, plan)
    expect(result.exitCode).toBe(2)
    expect(result.output.problems).toEqual([GIT_LOCK_BUSY_MESSAGE])
    expect(status(project)).toBe("")
  })

  it("does not change the dismissed pairs when the commit fails", async () => {
    const project = makeRecutRepo()
    const text = `[{"mechanism":"wiki/mechanisms/handshake.md","targetDomain":"${ALPHA}"}]`
    writeFile(project, ".llm-wiki/fusion-dismissed.json", text)
    vi.mocked(commitPathsLocked).mockResolvedValueOnce({ ok: false, problem: "no" })
    await applyPlan(project, plan)
    expect(read(project, ".llm-wiki/fusion-dismissed.json")).toBe(text)
  })

  it("commits through the shared git helper with the changed files", async () => {
    const project = makeRecutRepo()
    await applyPlan(project, plan)
    expect(commitPathsLocked).toHaveBeenCalledTimes(1)
    const [folder, paths, message] = vi.mocked(commitPathsLocked).mock.calls[0]
    expect(folder).toBe(project)
    expect([...paths].sort()).toEqual(
      [
        "domains.yaml",
        "wiki/concepts/one.md",
        "wiki/concepts/two.md",
        "wiki/entities/three.md",
        "wiki/hypotheses/idea.md",
        "wiki/index.md",
        "wiki/indexes/example--alpha--child.md",
        "wiki/indexes/example--alpha.md",
        "wiki/indexes/example--gamma--child.md",
        "wiki/indexes/example--gamma.md",
        "wiki/mechanisms/handshake.md",
      ].sort(),
    )
    expect(message.split("\n")[0]).toBe(`recut: rename ${ALPHA} → ${GAMMA} (5 pages)`)
  })
})

function writeFile(project: string, path: string, text: string): void {
  mkdirSync(dirname(join(project, path)), { recursive: true })
  writeFileSync(join(project, path), text)
}

function rmFile(project: string, path: string): void {
  rmSync(join(project, path), { recursive: true, force: true })
}
