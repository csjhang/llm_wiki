/**
 * The structural lint runs in two places: in the app (`runMechanismStructuralLint`) and in the `wiki-tool` CLI
 * (`lint structure`). Both call `checkStructure`, but each reads the files its own way. These tests build one
 * scratch wiki on disk, run both readers on it, and require the same findings. A form of page that one reader
 * sees and the other does not (a byte order mark, an upper-case `.MD` suffix, an app page in other case) fails here.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createTempProject, realFs, writeFileRaw } from "@/test-helpers/fs-temp"
import { runCli } from "../../../tools/wiki-tool/src/cli"

vi.mock("@/commands/fs", () => realFs)

import { runMechanismStructuralLint } from "./lint-run"
import type { StructureFinding } from "./lint-structure"

const ALPHA = "example/alpha"
const BETA = "example/beta"
const CARD_1 = "00000000-0000-4000-8000-000000000001"
const CARD_2 = "00000000-0000-4000-8000-000000000002"
const CARD_3 = "00000000-0000-4000-8000-000000000003"

let tmp: { path: string; cleanup: () => Promise<void> }
let project: string

beforeEach(async () => {
  tmp = await createTempProject("lint-parity")
  project = tmp.path
  await writeFileRaw(
    `${project}/domains.yaml`,
    ["version: 1", "domains:", ...[ALPHA, BETA].flatMap((name) => [`  ${name}:`, "    lens: ai", `    description: The ${name} domain`]), ""].join("\n"),
  )
  await writeFileRaw(`${project}/wiki.yaml`, "version: 1\nid: reading\nrole: reading\nmechanism_library: null\nlint:\n  min_domain_pages: 1\n")
})

afterEach(async () => {
  await tmp.cleanup()
})

function page(fields: string[], body = "# Page\n"): string {
  return `---\n${fields.join("\n")}\n---\n${body}`
}

async function findingsOfCli(): Promise<StructureFinding[]> {
  const result = await runCli(["lint", "structure", "--project", project])
  expect(result.exitCode, JSON.stringify(result.output)).toBe(0)
  return (result.output as { findings: StructureFinding[] }).findings
}

/** Both readers on the project at once: they must agree, and the common answer is returned. */
async function findingsOfBoth(): Promise<StructureFinding[]> {
  const [app, cli] = [await runMechanismStructuralLint(project), await findingsOfCli()]
  expect(app).toEqual(cli)
  return app
}

describe("the app and the CLI read the same pages", () => {
  it("a clean wiki gives the same (empty) findings", async () => {
    await writeFileRaw(`${project}/wiki/concepts/a.md`, page(["type: concept", `domain: ${ALPHA}`]))
    await writeFileRaw(`${project}/wiki/concepts/b.md`, page(["type: concept", `domain: ${BETA}`]))
    expect(await findingsOfBoth()).toEqual([])
  })

  // Final review, M4. The CLI strips a byte order mark before the frontmatter; the app did not.
  it("a page that starts with a byte order mark has its frontmatter in both", async () => {
    await writeFileRaw(`${project}/wiki/concepts/a.md`, page(["type: concept", `domain: ${ALPHA}`]))
    await writeFileRaw(`${project}/wiki/concepts/bom.md`, `﻿${page(["type: concept", `domain: ${BETA}`])}`)
    expect(await findingsOfBoth()).toEqual([])
  })

  // Final review, M4. The CLI matches `.md` without regard to case; the app did not.
  it("a file with an upper-case .MD suffix is a page in both", async () => {
    await writeFileRaw(`${project}/wiki/concepts/a.md`, page(["type: concept", `domain: ${ALPHA}`]))
    await writeFileRaw(`${project}/wiki/concepts/b.md`, page(["type: concept", `domain: ${BETA}`]))
    await writeFileRaw(`${project}/wiki/concepts/C.MD`, page(["type: concept"]))
    const findings = await findingsOfBoth()
    expect(findings).toMatchObject([{ check: "domain-missing", page: "wiki/concepts/C.MD" }])
  })

  it("an app page in other case is left out in both, and so is every file in wiki/indexes", async () => {
    await writeFileRaw(`${project}/wiki/concepts/a.md`, page(["type: concept", `domain: ${ALPHA}`]))
    await writeFileRaw(`${project}/wiki/concepts/b.md`, page(["type: concept", `domain: ${BETA}`]))
    await writeFileRaw(`${project}/wiki/Index.md`, "# Index\n")
    await writeFileRaw(`${project}/wiki/LOG.MD`, "# Log\n")
    await writeFileRaw(`${project}/wiki/Overview.md`, "# Overview\n")
    await writeFileRaw(`${project}/wiki/indexes/example--alpha.md`, "# example/alpha\n")
    await writeFileRaw(`${project}/wiki/Indexes/Other.md`, "# Other\n")
    expect(await findingsOfBoth()).toEqual([])
  })

  it("the card map gives the same findings: retired, missing page, and a mirrored page that came back", async () => {
    await writeFileRaw(`${project}/wiki/mechanisms/m.md`, page(["type: mechanism", "instances: [x]"]))
    await writeFileRaw(`${project}/wiki/concepts/one.md`, page(["type: concept", `domain: ${ALPHA}`, "sources: [a.md]"]))
    await writeFileRaw(`${project}/wiki/concepts/two.md`, page(["type: concept", `domain: ${BETA}`, "sources: [a.md, b.md]"]))
    const entry = (cardId: string, status: string) => ({
      card_id: cardId,
      content_hash: "x",
      last_synced_at: "2026-10-01T00:00:00.000Z",
      card_updated_at: "2026-10-01T00:00:00.000Z",
      placements: [],
      status,
    })
    await writeFileRaw(
      `${project}/heptabase-map.json`,
      JSON.stringify({
        version: 1,
        pages: {
          // Mirrored, so the next sync brings the card back: no finding.
          "wiki/mechanisms/m.md": entry(CARD_1, "retired"),
          "wiki/concepts/two.md": entry(CARD_2, "retired"),
          // Not mirrored (one source): the card is for the user to delete.
          "wiki/concepts/one.md": entry(CARD_3, "retired"),
          "wiki/concepts/gone.md": entry("00000000-0000-4000-8000-000000000004", "active"),
        },
        sources: {},
        whiteboards_cache: { updated_at: "", items: [] },
      }),
    )
    const findings = await findingsOfBoth()
    expect(findings.map((finding) => [finding.check, finding.page])).toEqual([
      ["map-missing-page", "wiki/concepts/gone.md"],
      ["mirror-retired", "wiki/concepts/one.md"],
    ])
  })

  it("a bad lint threshold gives the same config problem and the same default", async () => {
    await writeFileRaw(`${project}/wiki.yaml`, "version: 1\nid: reading\nrole: reading\nmechanism_library: null\nlint:\n  min_domain_pages: 0\n")
    await writeFileRaw(`${project}/wiki/concepts/a.md`, page(["type: concept", `domain: ${ALPHA}`]))
    const findings = await findingsOfBoth()
    expect(findings.map((finding) => finding.check)).toEqual(["config-invalid", "domain-too-small", "domain-too-small"])
    expect(findings[0].message).toContain("wiki.yaml:lint.min_domain_pages")
  })
})
