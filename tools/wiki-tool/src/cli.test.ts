/**
 * cli.test.ts - tests for the wiki-tool dispatcher and the io helpers.
 *
 * The dispatcher tests call runCli() directly. The bundle test in
 * src/lib/__tests__/wiki-tool-bundle.test.ts runs the built file.
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve, sep } from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, describe, expect, it } from "vitest"
import { runCli } from "./cli"
import type { CommandGroup } from "./io"
import { readJsonFile, resolveInProject, writeFileAtomic } from "./io"

const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url))
const MANIFEST_PATH = join(REPO_ROOT, "plugins", "llm-wiki", ".claude-plugin", "plugin.json")

const tempDirs: string[] = []

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "wiki-tool-test-"))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop() as string, { recursive: true, force: true })
  }
})

describe("runCli", () => {
  it("version prints plugin version", async () => {
    const manifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf8")) as { version: string }
    const result = await runCli(["version"])
    expect(result.exitCode).toBe(0)
    expect(result.output).toEqual({ ok: true, version: manifest.version })
    expect(manifest.version).toMatch(/^\d+\.\d+\.\d+/)
  })

  it("unknown command exits 2", async () => {
    const result = await runCli(["nope", "run"])
    expect(result.exitCode).toBe(2)
    expect(result.output).toEqual({ ok: false, problems: ["unknown command: nope"] })
  })

  it("an empty command line exits 2 with a usage problem", async () => {
    const result = await runCli([])
    expect(result.exitCode).toBe(2)
    expect(result.output.ok).toBe(false)
    expect(result.output.problems).toEqual(["usage: wiki-tool <group> <command> [options]"])
  })

  describe("with registered groups", () => {
    const groups: CommandGroup[] = [
      {
        name: "demo",
        commands: {
          echo: (args) => ({ ok: true, args }),
          refuse: () => ({ ok: false, problems: ["not allowed"] }),
          crash: () => {
            throw new Error("boom")
          },
          slow: async () => ({ ok: true, waited: true }),
        },
      },
    ]

    it("runs a command of a group and passes the remaining arguments", async () => {
      const result = await runCli(["demo", "echo", "--project", "/x"], groups)
      expect(result).toEqual({ exitCode: 0, output: { ok: true, args: ["--project", "/x"] } })
    })

    it("awaits an async command", async () => {
      const result = await runCli(["demo", "slow"], groups)
      expect(result).toEqual({ exitCode: 0, output: { ok: true, waited: true } })
    })

    it("exits 2 when a command reports ok: false", async () => {
      const result = await runCli(["demo", "refuse"], groups)
      expect(result).toEqual({ exitCode: 2, output: { ok: false, problems: ["not allowed"] } })
    })

    it("exits 2 with the group and command for an unknown command of a known group", async () => {
      const result = await runCli(["demo", "missing"], groups)
      expect(result).toEqual({ exitCode: 2, output: { ok: false, problems: ["unknown command: demo missing"] } })
    })

    it("exits 2 for a known group without a command", async () => {
      const result = await runCli(["demo"], groups)
      expect(result.exitCode).toBe(2)
      expect(result.output.problems).toEqual(["unknown command: demo"])
    })

    it("does not find commands through the prototype chain", async () => {
      const result = await runCli(["demo", "constructor"], groups)
      expect(result.exitCode).toBe(2)
      expect(result.output.problems).toEqual(["unknown command: demo constructor"])
      const group = await runCli(["constructor", "x"], groups)
      expect(group.exitCode).toBe(2)
      expect(group.output.problems).toEqual(["unknown command: constructor"])
    })

    it("exits 1 when a command throws", async () => {
      const result = await runCli(["demo", "crash"], groups)
      expect(result.exitCode).toBe(1)
      expect(result.output).toEqual({ ok: false, problems: ["unexpected error: boom"] })
    })
  })
})

describe("resolveInProject", () => {
  it("resolves a relative path inside the project", () => {
    const project = makeTempDir()
    expect(resolveInProject(project, "wiki/index.md")).toBe(join(resolve(project), "wiki", "index.md"))
    expect(resolveInProject(project, "wiki/../raw/a.md")).toBe(join(resolve(project), "raw", "a.md"))
    expect(resolveInProject(project, ".")).toBe(resolve(project))
  })

  it("resolveInProject rejects ../", () => {
    const project = makeTempDir()
    expect(() => resolveInProject(project, "../outside.md")).toThrow(/outside the project/)
    expect(() => resolveInProject(project, "wiki/../../outside.md")).toThrow(/outside the project/)
    expect(() => resolveInProject(project, "..")).toThrow(/outside the project/)
  })

  it("rejects an absolute path outside the project and a sibling folder with the same prefix", () => {
    const project = makeTempDir()
    expect(() => resolveInProject(project, resolve(project, "..", "elsewhere.md"))).toThrow(/outside the project/)
    expect(() => resolveInProject(project, `..${sep}${project.split(sep).pop()}-sibling${sep}a.md`)).toThrow(
      /outside the project/,
    )
  })

  it("accepts a file name that starts with two dots", () => {
    const project = makeTempDir()
    expect(resolveInProject(project, "..notes.md")).toBe(join(resolve(project), "..notes.md"))
  })
})

describe("writeFileAtomic", () => {
  it("writes the content and replaces an existing file", () => {
    const dir = makeTempDir()
    const target = join(dir, "map.json")
    writeFileAtomic(target, "first\n")
    writeFileAtomic(target, "second\n")
    expect(readFileSync(target, "utf8")).toBe("second\n")
  })

  it("writeFileAtomic leaves no temp file", () => {
    const dir = makeTempDir()
    const target = join(dir, "map.json")
    writeFileAtomic(target, "{}\n")
    writeFileAtomic(target, '{"a":1}\n')
    expect(readdirSync(dir)).toEqual(["map.json"])
  })

  it("creates missing parent folders", () => {
    const dir = makeTempDir()
    const target = join(dir, ".llm-wiki", "hepta", "raw.json")
    writeFileAtomic(target, "[]")
    expect(readFileSync(target, "utf8")).toBe("[]")
  })

  it("leaves the old file and no temp file when the write fails", () => {
    const dir = makeTempDir()
    const target = join(dir, "map.json")
    writeFileAtomic(target, "old")
    // A folder at the target path makes the final rename fail.
    const blocked = join(dir, "blocked")
    mkdirSync(join(blocked, "child"), { recursive: true })
    expect(() => writeFileAtomic(blocked, "new")).toThrow()
    expect(readFileSync(target, "utf8")).toBe("old")
    expect(readdirSync(dir).sort()).toEqual(["blocked", "map.json"])
    expect(existsSync(join(blocked, "child"))).toBe(true)
  })
})

describe("readJsonFile", () => {
  it("parses a JSON file", () => {
    const dir = makeTempDir()
    const target = join(dir, "a.json")
    writeFileSync(target, '{"a":[1,2]}')
    expect(readJsonFile<{ a: number[] }>(target)).toEqual({ a: [1, 2] })
  })

  it("ignores a byte order mark", () => {
    const dir = makeTempDir()
    const target = join(dir, "a.json")
    writeFileSync(target, '﻿{"a":1}')
    expect(readJsonFile<{ a: number }>(target)).toEqual({ a: 1 })
  })

  it("names the file when the JSON is invalid", () => {
    const dir = makeTempDir()
    const target = join(dir, "bad.json")
    writeFileSync(target, "{nope")
    expect(() => readJsonFile(target)).toThrow(/bad\.json/)
  })
})
