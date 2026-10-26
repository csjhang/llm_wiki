/**
 * apply-safety.test.ts - tests for the data-safety rules of `wiki-tool recut apply` (fix round 1 of Task 4):
 * a recut writes only inside the project, never skips a reference silently, leaves nothing staged when git refuses
 * the commit, counts an untracked project folder as a dirty tree, and never overwrites a page that another tool wrote
 * after the recut read it.
 *
 * Real temporary git repositories. Domains, slugs, and titles are placeholders.
 */
import { chmodSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { commitPathsLocked } from "../git"
import { commit, git, head } from "../lint/lint-fixture"
import { makeProject, removeProjects } from "../test-project"
import {
  ALPHA,
  applyPlan,
  BETA,
  DOMAINS_YAML,
  indexFiles,
  makeRecutRepo,
  ONE,
  read,
  status,
  TWO,
} from "./recut-fixture"
import { readPageSources } from "./read-pages"

// The real helpers, except where a test changes what happens between two steps of the command.
vi.mock("../git", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../git")>()
  return { ...actual, commitPathsLocked: vi.fn(actual.commitPathsLocked) }
})
vi.mock("./read-pages", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./read-pages")>()
  return { ...actual, readPageSources: vi.fn(actual.readPageSources) }
})

vi.setConfig({ testTimeout: 30_000 })

afterEach(() => {
  removeProjects()
  vi.mocked(commitPathsLocked).mockClear()
  vi.mocked(readPageSources).mockClear()
})

const GAMMA = "example/gamma"
const rename = { op: "rename", from: ALPHA, to: GAMMA }
const merge = { op: "merge", from: [ALPHA, BETA], into: { domain: GAMMA, lens: "ai", description: "About gamma" } }

function writeFile(project: string, path: string, text: string): void {
  mkdirSync(dirname(join(project, path)), { recursive: true })
  writeFileSync(join(project, path), text)
}

/** A folder outside the project, with the given files. */
function outsideFolder(files: Record<string, string>): string {
  return makeProject(files, { noHeptabaseYaml: true })
}

function listing(folder: string): Record<string, string> {
  return Object.fromEntries(readdirSync(folder).sort().map((name) => [name, readFileSync(join(folder, name), "utf8")]))
}

describe("recut apply: nothing is written outside the project", () => {
  const OUTSIDE_PAGE = ["---", "type: concept", "title: Outside", `domain: ${ALPHA}`, "---", "", "# Outside", ""].join("\n")

  it("refuses a page that a linked folder brings in from outside", async () => {
    const outside = outsideFolder({ "linked/page.md": OUTSIDE_PAGE })
    const project = makeRecutRepo()
    symlinkSync(join(outside, "linked"), join(project, "wiki/linked"), "dir")
    commit(project, "link a folder")
    const before = head(project)

    const result = await applyPlan(project, rename)
    expect(result.exitCode).toBe(2)
    expect(result.output.problems).toEqual([expect.stringMatching(/^wiki\/linked\/page\.md: the file is outside the project/)])
    expect(readFileSync(join(outside, "linked/page.md"), "utf8")).toBe(OUTSIDE_PAGE)
    expect(head(project)).toBe(before)
    expect(status(project)).toBe("")
    expect(read(project, "wiki/concepts/one.md")).toBe(ONE)
  })

  it("refuses a domains.yaml that is a link to a file outside", async () => {
    const outside = outsideFolder({ "domains.yaml": DOMAINS_YAML })
    const project = makeRecutRepo()
    rmSync(join(project, "domains.yaml"))
    symlinkSync(join(outside, "domains.yaml"), join(project, "domains.yaml"))
    commit(project, "link domains.yaml")

    const result = await applyPlan(project, rename)
    expect(result.exitCode).toBe(2)
    expect(result.output.problems).toEqual([expect.stringMatching(/^domains\.yaml: the file is outside the project/)])
    expect(readFileSync(join(outside, "domains.yaml"), "utf8")).toBe(DOMAINS_YAML)
    expect(status(project)).toBe("")
  })

  it("refuses an index folder that is a link to a folder outside", async () => {
    const project = makeRecutRepo()
    const copies = Object.fromEntries(
      Object.entries(indexFiles(project))
        .filter(([path]) => path.startsWith("wiki/indexes/"))
        .map(([path, text]) => [path.slice("wiki/indexes/".length), text]),
    )
    const outside = outsideFolder(copies)
    rmSync(join(project, "wiki/indexes"), { recursive: true })
    symlinkSync(outside, join(project, "wiki/indexes"), "dir")
    commit(project, "link the index folder")
    const before = listing(outside)

    const result = await applyPlan(project, rename)
    expect(result.exitCode).toBe(2)
    expect(result.output.problems?.[0]).toMatch(/^wiki\/indexes\/[^:]+: the file is outside the project/)
    expect(listing(outside)).toEqual(before)
    expect(status(project)).toBe("")
  })

  it("does not rewrite a dismissed-pairs file that is a link to a file outside, and says so", async () => {
    const pairs = `[{"mechanism":"wiki/mechanisms/handshake.md","targetDomain":"${ALPHA}"}]`
    const outside = outsideFolder({ "pairs.json": pairs })
    const project = makeRecutRepo()
    mkdirSync(join(project, ".llm-wiki"), { recursive: true })
    symlinkSync(join(outside, "pairs.json"), join(project, ".llm-wiki/fusion-dismissed.json"))

    const result = await applyPlan(project, rename)
    expect(result.exitCode).toBe(0)
    expect(readFileSync(join(outside, "pairs.json"), "utf8")).toBe(pairs)
    // The first note is the one of a reading wiki (ruling U21); the second is about the dismissed pairs.
    expect(result.output.notes).toEqual([
      expect.stringContaining("This is a reading wiki."),
      expect.stringMatching(/fusion-dismissed\.json were not updated: .*outside the project/),
    ])
  })
})

describe("recut apply: a page behind a link that stays inside the project", () => {
  const SHARED_PAGE = ["---", "type: concept", "title: Shared", `domain: ${ALPHA}`, "---", "", "# Shared", ""].join("\n")

  it("refuses a page that is reached through a folder link, and writes nothing", async () => {
    // The folder `shared/real` is not under wiki/, so the page is read only through the link `wiki/inlink`.
    const project = makeRecutRepo({ "shared/real/r.md": SHARED_PAGE })
    symlinkSync("../shared/real", join(project, "wiki/inlink"), "dir")
    commit(project, "link a folder inside the project")
    const before = head(project)

    const result = await applyPlan(project, rename)
    expect(result.exitCode).toBe(2)
    expect(result.output.problems).toEqual(["wiki/inlink/r.md: a folder in its path is a link, so a recut cannot edit it safely"])
    expect(read(project, "shared/real/r.md")).toBe(SHARED_PAGE)
    expect(read(project, "wiki/concepts/one.md")).toBe(ONE)
    expect(head(project)).toBe(before)
    expect(status(project)).toBe("")
  })
})

// Final review, P1 (parked from Task 4): a file or folder that is a link inside the project is refused like a page is.
// A write would replace the link with a regular file, and the commit would record a change of type.
describe("recut apply: domains.yaml and the index files behind a link that stays inside the project", () => {
  it("refuses a domains.yaml that is a link to a file inside the project, and writes nothing", async () => {
    const project = makeRecutRepo({ "shared/domains.real.yaml": DOMAINS_YAML })
    rmSync(join(project, "domains.yaml"))
    symlinkSync("shared/domains.real.yaml", join(project, "domains.yaml"))
    commit(project, "link domains.yaml inside the project")
    const before = head(project)

    const result = await applyPlan(project, rename)
    expect(result.exitCode).toBe(2)
    expect(result.output.problems).toEqual(["domains.yaml: the file is a link, so a recut does not write it"])
    expect(read(project, "shared/domains.real.yaml")).toBe(DOMAINS_YAML)
    expect(head(project)).toBe(before)
    expect(status(project)).toBe("")
    expect(read(project, "wiki/concepts/one.md")).toBe(ONE)
  })

  it("refuses an index folder that is a link to a folder inside the project", async () => {
    const project = makeRecutRepo()
    renameSync(join(project, "wiki/indexes"), join(project, "shared-indexes"))
    symlinkSync("../shared-indexes", join(project, "wiki/indexes"), "dir")
    commit(project, "link the index folder inside the project")
    const before = head(project)
    const files = readdirSync(join(project, "shared-indexes")).sort()

    const result = await applyPlan(project, rename)
    expect(result.exitCode).toBe(2)
    expect(result.output.problems?.[0]).toMatch(/^wiki\/indexes\/[^:]+: a folder in its path is a link, so a recut does not write it$/)
    expect(readdirSync(join(project, "shared-indexes")).sort()).toEqual(files)
    expect(head(project)).toBe(before)
    expect(status(project)).toBe("")
  })

  it("refuses an index file that is a link to a file inside the project", async () => {
    const project = makeRecutRepo()
    // The rename writes the root index and the index of the new name. The root index is a link to another file.
    renameSync(join(project, "wiki/index.md"), join(project, "root-index.md"))
    symlinkSync("../root-index.md", join(project, "wiki/index.md"))
    commit(project, "link the root index inside the project")
    const before = head(project)

    const result = await applyPlan(project, rename)
    expect(result.exitCode).toBe(2)
    expect(result.output.problems).toEqual(["wiki/index.md: the file is a link, so a recut does not write it"])
    expect(head(project)).toBe(before)
    expect(status(project)).toBe("")
  })

  it("refuses to remove an index file that is a link, also one that leads nowhere", async () => {
    const project = makeRecutRepo()
    // The rename removes the index of the old name. Here it is a link to a file that does not exist.
    rmSync(join(project, "wiki/indexes/example--alpha.md"))
    symlinkSync("missing.md", join(project, "wiki/indexes/example--alpha.md"))
    commit(project, "link the old index to nothing")
    const before = head(project)

    const result = await applyPlan(project, rename)
    expect(result.exitCode).toBe(2)
    expect(result.output.problems).toEqual(["wiki/indexes/example--alpha.md: the file is a link, so a recut does not write it"])
    expect(head(project)).toBe(before)
    expect(status(project)).toBe("")
  })

  it("still writes through a folder that is a plain folder", async () => {
    const result = await applyPlan(makeRecutRepo(), rename)
    expect(result.exitCode).toBe(0)
  })
})

describe("recut apply: a path that cannot be resolved", () => {
  it("names the path in a problem for a link loop, with exit 2", async () => {
    const project = makeRecutRepo()
    // The index file that the rename would write is a link to itself.
    symlinkSync("example--gamma.md", join(project, "wiki/indexes/example--gamma.md"))
    commit(project, "add a link loop")
    const before = head(project)

    const result = await applyPlan(project, rename)
    expect(result.exitCode).toBe(2)
    expect(result.output.problems).toEqual([expect.stringMatching(/^wiki\/indexes\/example--gamma\.md: the path cannot be resolved \(ELOOP.*example--gamma\.md.*\), so a recut does not write it$/)])
    expect(head(project)).toBe(before)
    expect(status(project)).toBe("")
    expect(read(project, "wiki/concepts/one.md")).toBe(ONE)
  })

  // Final review, P1: the index file that a recut would remove is a link loop. It was skipped without a word.
  it("names the path of an index file to remove that is a link loop, with exit 2", async () => {
    const project = makeRecutRepo()
    // The rename removes the index of the old name. Here it is a link to itself.
    rmSync(join(project, "wiki/indexes/example--alpha.md"))
    symlinkSync("example--alpha.md", join(project, "wiki/indexes/example--alpha.md"))
    commit(project, "link the old index to itself")
    const before = head(project)

    const result = await applyPlan(project, rename)
    expect(result.exitCode).toBe(2)
    expect(result.output.problems).toEqual([
      expect.stringMatching(/^wiki\/indexes\/example--alpha\.md: the path cannot be resolved \(ELOOP.*\), so a recut does not write it$/),
    ])
    expect(head(project)).toBe(before)
    expect(status(project)).toBe("")
  })

  it("does not rewrite a dismissed-pairs file behind a link loop, and says so", async () => {
    const project = makeRecutRepo()
    mkdirSync(join(project, ".llm-wiki"), { recursive: true })
    symlinkSync("fusion-dismissed.json", join(project, ".llm-wiki/fusion-dismissed.json"))
    const result = await applyPlan(project, rename)
    expect(result.exitCode).toBe(0)
    expect(result.output.notes).toEqual([
      expect.stringContaining("This is a reading wiki."),
      expect.stringMatching(/fusion-dismissed\.json were not updated: the path cannot be resolved \(ELOOP/),
    ])
  })

  it("does not rewrite a dismissed-pairs file that is a link inside the project, and says so", async () => {
    const pairs = `[{"mechanism":"wiki/mechanisms/handshake.md","targetDomain":"${ALPHA}"}]`
    const project = makeRecutRepo({ "shared/pairs.json": pairs })
    mkdirSync(join(project, ".llm-wiki"), { recursive: true })
    symlinkSync("../shared/pairs.json", join(project, ".llm-wiki/fusion-dismissed.json"))
    const result = await applyPlan(project, rename)
    expect(result.exitCode).toBe(0)
    expect(read(project, "shared/pairs.json")).toBe(pairs)
    expect(result.output.notes).toEqual([
      expect.stringContaining("This is a reading wiki."),
      expect.stringMatching(/fusion-dismissed\.json were not updated: the file is a link/),
    ])
  })
})

describe("recut apply: a reference it cannot rewrite is not skipped", () => {
  const forms: Array<[string, string]> = [
    ["indented frontmatter", `---\n  type: concept\n  title: Odd\n  domain: ${ALPHA}\n---\n\n# Odd\n`],
    ["frontmatter written as a flow mapping", `---\n{type: concept, title: Odd, domain: ${ALPHA}}\n---\n\n# Odd\n`],
  ]
  const plans: Array<[string, unknown]> = [
    ["rename", rename],
    ["merge", merge],
  ]
  for (const [op, plan] of plans) {
    for (const [form, text] of forms) {
      it(`refuses a ${op} when a page has ${form}`, async () => {
        const project = makeRecutRepo({ "wiki/concepts/odd.md": text })
        const before = head(project)
        const result = await applyPlan(project, plan)
        expect(result.exitCode).toBe(2)
        expect(result.output.problems).toEqual([expect.stringMatching(/^wiki\/concepts\/odd\.md: domain still names example\/alpha/)])
        expect(head(project)).toBe(before)
        expect(status(project)).toBe("")
        expect(read(project, "domains.yaml")).toBe(DOMAINS_YAML)
        expect(read(project, "wiki/concepts/one.md")).toBe(ONE)
      })
    }
  }
})

describe("recut apply: a commit that git refuses", () => {
  it("leaves nothing staged and puts every file back", async () => {
    const project = makeRecutRepo()
    // A hook that rejects every ref update. `commit --no-verify` does not skip this one.
    const hook = join(project, ".git/hooks/reference-transaction")
    mkdirSync(dirname(hook), { recursive: true })
    writeFileSync(hook, "#!/bin/sh\nexit 1\n")
    chmodSync(hook, 0o755)
    const before = head(project)

    const result = await applyPlan(project, rename)
    expect(result.exitCode).toBe(2)
    expect(result.output.problems?.length).toBeGreaterThan(0)
    expect(head(project)).toBe(before)
    expect(git(project, "diff", "--cached", "--name-only")).toBe("")
    expect(status(project)).toBe("")
    expect(read(project, "domains.yaml")).toBe(DOMAINS_YAML)
    expect(read(project, "wiki/concepts/one.md")).toBe(ONE)
  })
})

describe("recut apply: a project folder that git does not track yet", () => {
  it("counts an untracked project folder inside a larger repository as a dirty tree", async () => {
    const project = makeRecutRepo({}, { prefix: "wikis/main" })
    git(project, "rm", "-r", "--cached", "--quiet", ".")
    git(project, "commit", "--quiet", "--no-verify", "-m", "untrack the wiki")
    // Git prints the whole folder as one entry: the entry is above the project folder.
    expect(status(project)).toContain("?? wikis/\n")
    const result = await applyPlan(project, rename)
    expect(result.exitCode).toBe(2)
    expect(result.output.problems?.[0]).toMatch(/uncommitted changes/)
    expect(read(project, "wiki/concepts/one.md")).toBe(ONE)
  })
})

describe("recut apply: a page that another tool wrote meanwhile", () => {
  it("refuses to overwrite it and writes nothing", async () => {
    const project = makeRecutRepo()
    const actual = await vi.importActual<typeof import("./read-pages")>("./read-pages")
    // Another tool writes a page after the recut has read it.
    vi.mocked(readPageSources).mockImplementationOnce((folder) => {
      const pages = actual.readPageSources(folder)
      writeFile(folder, "wiki/concepts/two.md", `${TWO}Another tool wrote this line.\n`)
      return pages
    })
    const before = head(project)

    const result = await applyPlan(project, { op: "rename", from: "example/alpha/child", to: "example/alpha/kid" })
    expect(result.exitCode).toBe(2)
    expect(result.output.problems).toEqual(["wiki/concepts/two.md changed while the recut ran, so nothing was written. Run the recut again."])
    expect(read(project, "wiki/concepts/two.md")).toBe(`${TWO}Another tool wrote this line.\n`)
    expect(read(project, "domains.yaml")).toBe(DOMAINS_YAML)
    expect(head(project)).toBe(before)
    expect(status(project)).toBe(" M wiki/concepts/two.md\n")
  })
})
