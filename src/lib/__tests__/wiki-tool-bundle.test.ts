/**
 * wiki-tool-bundle.test.ts - contract for the committed wiki-tool bundle.
 *
 * Skills run plugins/llm-wiki/scripts/wiki-tool.mjs. The file is built from
 * tools/wiki-tool/src by `npm run build:wiki-tool` and committed. The first test
 * rebuilds it into a temporary folder and compares the bytes, so a source change
 * without a rebuilt bundle fails here.
 */
import { execFileSync, spawnSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url))
const BUNDLE_PATH = join(REPO_ROOT, "plugins", "llm-wiki", "scripts", "wiki-tool.mjs")
const MANIFEST_PATH = join(REPO_ROOT, "plugins", "llm-wiki", ".claude-plugin", "plugin.json")

let tempDir: string

beforeAll(() => {
  tempDir = mkdtempSync(join(tmpdir(), "wiki-tool-bundle-"))
})

afterAll(() => {
  rmSync(tempDir, { recursive: true, force: true })
})

function runBundle(path: string, args: string[]) {
  const result = spawnSync(process.execPath, [path, ...args], { encoding: "utf8" })
  return { status: result.status, stdout: result.stdout, stderr: result.stderr }
}

describe("wiki-tool bundle", () => {
  it("is up to date with the sources", () => {
    const rebuilt = join(tempDir, "wiki-tool.mjs")
    execFileSync("npm", ["run", "--silent", "build:wiki-tool", "--", "--file", rebuilt], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      shell: process.platform === "win32",
    })
    const expected = readFileSync(rebuilt)
    const committed = readFileSync(BUNDLE_PATH)
    expect(
      committed.equals(expected),
      "plugins/llm-wiki/scripts/wiki-tool.mjs is stale. Run `npm run build:wiki-tool` and commit the result.",
    ).toBe(true)
  }, 120_000)

  it("prints the plugin version as JSON", () => {
    const manifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf8")) as { version: string }
    const result = runBundle(BUNDLE_PATH, ["version"])
    expect(result.status).toBe(0)
    expect(result.stderr).toBe("")
    expect(result.stdout.trim().split("\n")).toHaveLength(1)
    expect(JSON.parse(result.stdout)).toEqual({ ok: true, version: manifest.version })
  })

  it("exits 2 with a JSON problem for an unknown command", () => {
    const result = runBundle(BUNDLE_PATH, ["nope", "run"])
    expect(result.status).toBe(2)
    expect(JSON.parse(result.stdout)).toEqual({ ok: false, problems: ["unknown command: nope"] })
  })

  it("runs from a folder without node_modules", () => {
    const result = spawnSync(process.execPath, [BUNDLE_PATH, "version"], { cwd: tempDir, encoding: "utf8" })
    expect(result.status).toBe(0)
    expect(JSON.parse(result.stdout).ok).toBe(true)
  })

  it("imports only node built-in modules", () => {
    const text = readFileSync(BUNDLE_PATH, "utf8")
    const specifiers = [...text.matchAll(/(?:^|[\s;])(?:import|export)\b[^"'`;]*?from\s*["']([^"']+)["']/gm)].map(
      (match) => match[1],
    )
    const bare = [...text.matchAll(/^\s*import\s*["']([^"']+)["']/gm)].map((match) => match[1])
    const dynamic = [...text.matchAll(/\bimport\(\s*["']([^"']+)["']\s*\)/g)].map((match) => match[1])
    const requires = [...text.matchAll(/\brequire\(\s*["']([^"']+)["']\s*\)/g)].map((match) => match[1])
    for (const specifier of [...specifiers, ...bare, ...dynamic, ...requires]) {
      expect(specifier.startsWith("node:"), `non built-in import: ${specifier}`).toBe(true)
    }
    expect(text).not.toContain("@tauri-apps")
  })
})
