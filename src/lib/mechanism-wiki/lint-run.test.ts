/**
 * lint-run.test.ts - the part of `runMechanismStructuralLint` that the parity tests cannot reach: the reading wiki of a
 * work wiki cannot be read at all. The check of the domains then has to say so once, and not flag every hypothesis.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createTempProject, realFs, writeFileRaw } from "@/test-helpers/fs-temp"

vi.mock("@/commands/fs", () => realFs)
vi.mock("./context", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./context")>()
  return { ...actual, loadMechanismContext: vi.fn(actual.loadMechanismContext) }
})

import { loadMechanismContext } from "./context"
import { runMechanismStructuralLint } from "./lint-run"

let tmp: { path: string; cleanup: () => Promise<void> }

beforeEach(async () => {
  tmp = await createTempProject("lint-run")
})

afterEach(async () => {
  vi.mocked(loadMechanismContext).mockRestore()
  await tmp.cleanup()
})

function domainsYaml(...names: string[]): string {
  return ["version: 1", "domains:", ...names.flatMap((name) => [`  ${name}:`, "    lens: ai", `    description: The ${name} domain`]), ""].join("\n")
}

describe("runMechanismStructuralLint: the reading wiki of a work wiki", () => {
  async function makeWork(): Promise<{ work: string; library: string }> {
    const work = `${tmp.path}/work`
    const library = `${tmp.path}/library`
    await writeFileRaw(`${library}/domains.yaml`, domainsYaml("example/lib"))
    await writeFileRaw(`${library}/wiki.yaml`, "version: 1\nid: reading\nrole: reading\nmechanism_library: null\n")
    await writeFileRaw(`${work}/domains.yaml`, domainsYaml("example/own"))
    await writeFileRaw(`${work}/wiki.yaml`, `version: 1\nid: work\nrole: work\nmechanism_library: ../library\nlint:\n  min_domain_pages: 1\n`)
    await writeFileRaw(`${work}/wiki/concepts/a.md`, "---\ntype: concept\ndomain: example/own\n---\n# A\n")
    // A hypothesis from a domain of the reading wiki: known when the reading wiki can be read.
    await writeFileRaw(`${work}/wiki/hypotheses/h.md`, "---\ntype: hypothesis\nfrom_domain: example/lib\nto_domain: example/own\n---\n# H\n")
    return { work, library }
  }

  it("finds no unknown domain when the reading wiki can be read", async () => {
    const { work } = await makeWork()
    expect(await runMechanismStructuralLint(work)).toEqual([])
  })

  // Final review, P2 (parked from Task 2): the catch returned no problem, so every library domain looked unknown.
  it("gives one config problem, and no domain-unknown, when loading the reading wiki fails", async () => {
    const { work, library } = await makeWork()
    const actual = vi.mocked(loadMechanismContext).getMockImplementation()
    vi.mocked(loadMechanismContext).mockImplementation(async (path: string) => {
      if (path.replace(/\/+$/, "").endsWith("/library") || path === library) throw new Error("the disk failed")
      return actual === undefined ? null : actual(path)
    })

    const findings = await runMechanismStructuralLint(work)

    expect(findings.map((finding) => finding.check)).toEqual(["config-invalid"])
    expect(findings[0].message).toContain("reading wiki domains.yaml: could not read the file")
    expect(findings[0].message).toContain("The domains of the reading wiki are not checked until you fix the file.")
  })
})
