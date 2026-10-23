/**
 * sample-wiki.test.ts — contract for examples/sample-wiki/.
 *
 * The sample wiki is an overlay on templates/mechanism-wiki/. Later
 * sub-projects use `materializeSampleWiki` as a test fixture, so these tests
 * check that the overlay is valid and that the helper builds a complete wiki.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import yaml from "js-yaml"
import { afterEach, describe, expect, it } from "vitest"
import { parseDomainsYaml } from "@/lib/wiki-config/domains"
import { materializeSampleWiki } from "@/test-helpers/sample-wiki"

const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url))
const SAMPLE_DIR = join(REPO_ROOT, "examples", "sample-wiki")
const SOURCES_DIR = join(SAMPLE_DIR, "raw", "sources")

function readSampleDomains() {
  return parseDomainsYaml(readFileSync(join(SAMPLE_DIR, "domains.yaml"), "utf-8"))
}

/** Read the YAML frontmatter block of a markdown file. */
function readFrontmatter(path: string): Record<string, unknown> {
  const match = /^---\n([\s\S]*?)\n---\n/.exec(readFileSync(path, "utf-8"))
  if (!match) throw new Error(`no frontmatter in ${path}`)
  return yaml.load(match[1]) as Record<string, unknown>
}

function listSources(): string[] {
  return readdirSync(SOURCES_DIR)
    .filter((name) => name.endsWith(".md"))
    .sort()
}

const tempDirs: string[] = []

afterEach(async () => {
  while (tempDirs.length > 0) {
    await rm(tempDirs.pop()!, { recursive: true, force: true })
  }
})

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "llmwiki-sample-"))
  tempDirs.push(dir)
  return dir
}

describe("sample wiki overlay", () => {
  it("sample domains are valid", () => {
    const result = readSampleDomains()
    expect(result.issues).toEqual([])
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const lensByDomain = Object.fromEntries(
      Object.entries(result.value.domains).map(([name, entry]) => [name, entry.lens]),
    )
    expect(lensByDomain).toEqual({
      "hardware/async-circuits": "hardware",
      "ai/architecture": "ai",
      "business/franchising": "business",
    })
  })

  it("every sample source names a known domain", () => {
    const result = readSampleDomains()
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const known = Object.keys(result.value.domains)
    const names = listSources()
    expect(names).toEqual([
      "async-handshake-circuits.md",
      "franchise-licensing.md",
      "spiking-neural-networks.md",
    ])
    for (const name of names) {
      const front = readFrontmatter(join(SOURCES_DIR, name))
      expect(typeof front.title, `${name} title`).toBe("string")
      expect(known, `${name} domain`).toContain(front.domain)
      expect(front.source_kind, `${name} source_kind`).toBe("article")
    }
  })

  it("keeps each sample source between 250 and 450 words", () => {
    for (const name of listSources()) {
      const text = readFileSync(join(SOURCES_DIR, name), "utf-8")
      const body = text.replace(/^---\n[\s\S]*?\n---\n/, "")
      const words = body.split(/\s+/).filter((word) => word.length > 0).length
      expect(words, `${name} word count`).toBeGreaterThanOrEqual(250)
      expect(words, `${name} word count`).toBeLessThanOrEqual(450)
    }
  })

  it("two domains share a mechanism candidate", () => {
    const phrase = "event-driven"
    for (const name of ["async-handshake-circuits.md", "spiking-neural-networks.md"]) {
      const text = readFileSync(join(SOURCES_DIR, name), "utf-8").toLowerCase()
      expect(text, name).toContain(phrase)
    }
  })

  it("explains in README.md that the sample overlays the template", () => {
    const readme = readFileSync(join(SAMPLE_DIR, "README.md"), "utf-8")
    expect(readme).toContain("templates/mechanism-wiki/")
    expect(readme.toLowerCase()).toContain("overlay")
  })

  it("README.md calls the sample a starting-point fixture, not a finished wiki", () => {
    const readme = readFileSync(join(SAMPLE_DIR, "README.md"), "utf-8")
    expect(readme).toContain("starting-point fixture")
    expect(readme).toContain("not a finished wiki")
    expect(readme).not.toMatch(/example of a finished/i)
  })
})

describe("materializeSampleWiki", () => {
  it("materializes a complete wiki", async () => {
    const target = await makeTempDir()
    await materializeSampleWiki(target)

    // Template files are present. The agent entry files are there, and the sample README is not.
    expect(existsSync(join(target, "CLAUDE.md"))).toBe(true)
    expect(existsSync(join(target, "schema.md"))).toBe(true)
    expect(existsSync(join(target, "AGENTS.md"))).toBe(true)
    expect(existsSync(join(target, "README.md"))).toBe(false)
    expect(existsSync(join(target, "lenses", "hardware.md"))).toBe(true)
    expect(existsSync(join(target, "schema", "page-types", "source.md"))).toBe(true)

    // Overlay files are present, and an overlay file wins over its template twin.
    expect(existsSync(join(target, "raw", "sources", "franchise-licensing.md"))).toBe(true)
    expect(readFileSync(join(target, "purpose.md"), "utf-8")).toBe(
      readFileSync(join(SAMPLE_DIR, "purpose.md"), "utf-8"),
    )
    expect(readFileSync(join(target, "domains.yaml"), "utf-8")).toBe(
      readFileSync(join(SAMPLE_DIR, "domains.yaml"), "utf-8"),
    )

    // Folders that the app's create_project makes, plus the template extra dirs.
    for (const dir of [
      "raw/sources",
      "raw/assets",
      "wiki/entities",
      "wiki/concepts",
      "wiki/sources",
      "wiki/queries",
      "wiki/comparisons",
      "wiki/synthesis",
      "wiki/mechanisms",
      "wiki/hypotheses",
      "wiki/indexes",
      "raw/sources/heptabase",
    ]) {
      expect(existsSync(join(target, dir)), dir).toBe(true)
    }

    // The helper does not invent index, log, or overview content.
    for (const name of ["index.md", "log.md", "overview.md"]) {
      expect(existsSync(join(target, "wiki", name)), name).toBe(false)
    }
  })

  it("is deterministic", async () => {
    const first = await makeTempDir()
    const second = await makeTempDir()
    await materializeSampleWiki(first)
    await materializeSampleWiki(second)
    const list = (root: string) => readdirSync(root, { recursive: true }).map(String).sort()
    expect(list(first)).toEqual(list(second))
  })

  it("can run twice on the same directory", async () => {
    const target = await makeTempDir()
    await materializeSampleWiki(target)
    await expect(materializeSampleWiki(target)).resolves.toBeUndefined()
  })
})
