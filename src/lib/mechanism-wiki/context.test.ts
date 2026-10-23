import { mkdtemp, readdir, readFile as nodeReadFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import type { FileNode } from "@/types/wiki"
import { materializeSampleWiki } from "@/test-helpers/sample-wiki"

/** In-memory project tree. Keys are absolute paths with "/" separators. */
const tree = vi.hoisted(() => ({
  files: new Map<string, string>(),
  /** Paths that exist and are listed, but whose read rejects (for example a UTF-16 file). */
  unreadable: new Set<string>(),
}))

vi.mock("@/commands/fs", () => ({
  readFile: vi.fn(async (path: string) => {
    const text = tree.files.get(path)
    if (text === undefined) throw new Error(`No such file: ${path}`)
    if (tree.unreadable.has(path)) throw new Error(`stream did not contain valid UTF-8: ${path}`)
    return text
  }),
  fileExists: vi.fn(async (path: string) => tree.files.has(path)),
  // Lists the direct children of a directory, like the real command with maxDepth 1.
  listDirectory: vi.fn(async (path: string) => {
    const prefix = `${path.replace(/\/$/, "")}/`
    const files = new Map<string, FileNode>()
    const dirs = new Map<string, FileNode>()
    for (const key of tree.files.keys()) {
      if (!key.startsWith(prefix)) continue
      const rest = key.slice(prefix.length)
      const slash = rest.indexOf("/")
      if (slash === -1) {
        files.set(rest, { name: rest, path: key, is_dir: false })
      } else {
        const name = rest.slice(0, slash)
        dirs.set(name, { name, path: `${prefix}${name}`, is_dir: true, children: [] })
      }
    }
    if (files.size === 0 && dirs.size === 0) throw new Error(`Path does not exist: '${path}'`)
    return [...dirs.values(), ...files.values()]
  }),
}))

import {
  canWriteMechanismPages,
  extractLensPromptText,
  lensForDomain,
  loadMechanismContext,
} from "./context"

const PROJECT = "/projects/reading"

/** Relative path to text, for every file of the materialized sample wiki. */
const sampleFiles = new Map<string, string>()
let sampleDir = ""

async function readTree(dir: string, relative = ""): Promise<void> {
  for (const entry of await readdir(join(dir, relative), { withFileTypes: true })) {
    const entryPath = relative === "" ? entry.name : `${relative}/${entry.name}`
    if (entry.isDirectory()) await readTree(dir, entryPath)
    else sampleFiles.set(entryPath, await nodeReadFile(join(dir, entryPath), "utf-8"))
  }
}

/** Replace the in-memory project with the sample wiki mounted at `root`. */
function mountSample(root: string = PROJECT): void {
  tree.files.clear()
  for (const [relative, text] of sampleFiles) tree.files.set(`${root}/${relative}`, text)
}

function setFile(relative: string, text: string, root: string = PROJECT): void {
  tree.files.set(`${root}/${relative}`, text)
}

function removeFile(relative: string, root: string = PROJECT): void {
  tree.files.delete(`${root}/${relative}`)
}

/** The file stays in the tree, so it exists and is listed, but reading it fails. */
function makeUnreadable(relative: string, root: string = PROJECT): void {
  tree.unreadable.add(`${root}/${relative}`)
}

beforeAll(async () => {
  sampleDir = await mkdtemp(join(tmpdir(), "mechanism-context-"))
  await materializeSampleWiki(sampleDir)
  await readTree(sampleDir)
})

afterAll(async () => {
  if (sampleDir !== "") await rm(sampleDir, { recursive: true, force: true })
})

beforeEach(() => {
  tree.unreadable.clear()
  mountSample()
})

describe("loadMechanismContext", () => {
  it("returns null without domains.yaml", async () => {
    removeFile("domains.yaml")
    expect(await loadMechanismContext(PROJECT)).toBeNull()
  })

  it("loads sample wiki", async () => {
    const ctx = await loadMechanismContext(PROJECT)
    if (ctx === null) throw new Error("expected a context")

    expect(ctx.configIssues).toEqual([])
    expect(ctx.projectPath).toBe(PROJECT)
    expect(ctx.identity).toEqual({ version: 1, id: "reading", role: "reading", mechanism_library: null })
    expect(ctx.identityStatus).toBe("ok")
    expect(ctx.mechanismLibraryPath).toBe(PROJECT)
    expect(Object.keys(ctx.domains.domains).sort()).toEqual([
      "ai/architecture",
      "business/franchising",
      "hardware/async-circuits",
    ])
    expect(Object.keys(ctx.lenses).sort()).toEqual(["ai", "business", "hardware", "physics"])
    expect(Object.keys(ctx.pageTypeRules).sort()).toEqual([
      "comparison",
      "concept",
      "entity",
      "hypothesis",
      "mechanism",
      "query",
      "source",
    ])
    expect(ctx.pageTypeRules.mechanism).toBe(sampleFiles.get("schema/page-types/mechanism.md"))
    expect(ctx.lenses.hardware.id).toBe("hardware")
    expect(ctx.lenses.hardware.text).toBe(sampleFiles.get("lenses/hardware.md"))
  })

  it("keeps only the Fields, Evidence standard, and Strength rules sections in promptText", async () => {
    const ctx = await loadMechanismContext(PROJECT)
    const { promptText, text } = ctx!.lenses.hardware

    expect(promptText).toContain("## Fields")
    expect(promptText).toContain("### Parts")
    expect(promptText).toContain("## Evidence standard")
    expect(promptText).toContain("Measured silicon data")
    expect(promptText).toContain("## Strength rules")
    expect(promptText).toContain("`mathematical`")
    expect(promptText).not.toContain("## Purpose")
    expect(promptText).not.toContain("## Example")
    // Nothing from the Example fence: its frontmatter, its `## ` headings, its links.
    expect(promptText).not.toContain("type: mechanism")
    expect(promptText).not.toContain("## 組成")
    expect(promptText).not.toContain("[[pipeline-tradeoffs-survey]]")
    // The full text still has all of it.
    expect(text).toContain("## Example")
    expect(text).toContain("## 組成")
  })

  it("custom lens file becomes a known lens", async () => {
    setFile("lenses/chemistry.md", "# Lens: chemistry\n\n## Fields\n\n### Parts\n\nWrite: species.\n")
    setFile(
      "domains.yaml",
      [
        "version: 1",
        "domains:",
        "  chemistry/catalysis:",
        "    lens: chemistry",
        "    description: Reactions sped up by a catalyst",
        "",
      ].join("\n"),
    )

    const ctx = await loadMechanismContext(PROJECT)

    expect(ctx!.configIssues).toEqual([])
    expect(ctx!.domains.domains["chemistry/catalysis"].lens).toBe("chemistry")
    expect(ctx!.lenses.chemistry.id).toBe("chemistry")
    expect(lensForDomain(ctx!, "chemistry/catalysis")).toBe(ctx!.lenses.chemistry)
  })

  it("rejects a lens that has no lens file or built-in name", async () => {
    setFile(
      "domains.yaml",
      ["version: 1", "domains:", "  a/b:", "    lens: chemistry", "    description: x", ""].join("\n"),
    )

    const ctx = await loadMechanismContext(PROJECT)

    expect(ctx!.domains.domains).toEqual({})
    expect(ctx!.configIssues).toHaveLength(1)
    expect(ctx!.configIssues[0].path).toBe("domains.yaml:domains.a/b.lens")
  })

  it("invalid domains.yaml records issues", async () => {
    setFile("domains.yaml", "version: 1\ndomains:\n  Bad Name:\n    lens: nope\n")

    const ctx = await loadMechanismContext(PROJECT)

    if (ctx === null) throw new Error("expected a context")
    expect(ctx.domains).toEqual({ version: 1, domains: {} })
    expect(ctx.configIssues.length).toBeGreaterThan(0)
    for (const issue of ctx.configIssues) expect(issue.path.startsWith("domains.yaml")).toBe(true)
    // The other files still load.
    expect(ctx.identity.id).toBe("reading")
    expect(Object.keys(ctx.lenses)).toHaveLength(4)
    expect(Object.keys(ctx.pageTypeRules)).toHaveLength(7)
  })

  it("unparseable domains.yaml records one whole-file issue", async () => {
    setFile("domains.yaml", "version: [1\n")

    const ctx = await loadMechanismContext(PROJECT)

    expect(ctx!.domains).toEqual({ version: 1, domains: {} })
    expect(ctx!.configIssues).toHaveLength(1)
    expect(ctx!.configIssues[0].path).toBe("domains.yaml")
  })

  it("unreadable domains.yaml records an issue", async () => {
    makeUnreadable("domains.yaml")

    const ctx = await loadMechanismContext(PROJECT)

    // The file exists, so this is still a mechanism wiki, with no domains.
    if (ctx === null) throw new Error("expected a context")
    expect(ctx.domains).toEqual({ version: 1, domains: {} })
    expect(ctx.configIssues).toEqual([{ path: "domains.yaml", message: "could not read the file" }])
    // The other files still load.
    expect(ctx.identityStatus).toBe("ok")
    expect(Object.keys(ctx.lenses)).toHaveLength(4)
    expect(Object.keys(ctx.pageTypeRules)).toHaveLength(7)
  })

  it("missing wiki.yaml defaults to reading", async () => {
    removeFile("wiki.yaml")

    const ctx = await loadMechanismContext(PROJECT)

    expect(ctx!.identity).toEqual({ version: 1, id: "reading", role: "reading", mechanism_library: null })
    expect(ctx!.identityStatus).toBe("missing")
    expect(ctx!.mechanismLibraryPath).toBe(PROJECT)
    expect(ctx!.configIssues).toHaveLength(1)
    expect(ctx!.configIssues[0].path).toBe("wiki.yaml")
    expect(ctx!.configIssues[0].message).toContain("missing")
  })

  it("unreadable wiki.yaml is invalid", async () => {
    makeUnreadable("wiki.yaml")

    const ctx = await loadMechanismContext(PROJECT)

    expect(ctx!.identity).toEqual({ version: 1, id: "reading", role: "reading", mechanism_library: null })
    expect(ctx!.identityStatus).toBe("invalid")
    expect(ctx!.configIssues).toEqual([{ path: "wiki.yaml", message: "could not read the file" }])
    expect(canWriteMechanismPages(ctx!)).toBe(false)
  })

  it("invalid wiki.yaml records issues and defaults to reading", async () => {
    setFile("wiki.yaml", "version: 1\nid: Not Valid\nrole: boss\n")

    const ctx = await loadMechanismContext(PROJECT)

    expect(ctx!.identity).toEqual({ version: 1, id: "reading", role: "reading", mechanism_library: null })
    expect(ctx!.identityStatus).toBe("invalid")
    expect(ctx!.configIssues.length).toBeGreaterThanOrEqual(2)
    for (const issue of ctx!.configIssues) expect(issue.path.startsWith("wiki.yaml")).toBe(true)
  })

  it("work wiki resolves relative library path", async () => {
    const work = "/home/me/work/projectA"
    mountSample(work)
    setFile("wiki.yaml", "version: 1\nid: work\nrole: work\nmechanism_library: ../../reading/wiki\n", work)

    const ctx = await loadMechanismContext(work)

    expect(ctx!.configIssues).toEqual([])
    expect(ctx!.identity.role).toBe("work")
    expect(ctx!.mechanismLibraryPath).toBe("/home/me/reading/wiki")
  })

  it("work wiki resolves a ./ library path against the project", async () => {
    const work = "/home/me/work"
    mountSample(work)
    setFile("wiki.yaml", "version: 1\nid: work\nrole: work\nmechanism_library: ./lib//reading/\n", work)

    const ctx = await loadMechanismContext(work)

    expect(ctx!.mechanismLibraryPath).toBe("/home/me/work/lib/reading")
  })

  it("work wiki resolves relative path against a Windows project path", async () => {
    const work = "C:\\Users\\me\\work"
    mountSample("C:/Users/me/work")
    setFile("wiki.yaml", "version: 1\nid: work\nrole: work\nmechanism_library: ..\\reading\n", "C:/Users/me/work")

    const ctx = await loadMechanismContext(work)

    expect(ctx!.mechanismLibraryPath).toBe("C:/Users/me/reading")
  })

  it("work wiki uses an absolute library path as is", async () => {
    const work = "/home/me/work"
    mountSample(work)
    setFile("wiki.yaml", "version: 1\nid: work\nrole: work\nmechanism_library: /srv/wikis/reading\n", work)

    const ctx = await loadMechanismContext(work)

    expect(ctx!.mechanismLibraryPath).toBe("/srv/wikis/reading")
  })

  it("does not climb above the filesystem root", async () => {
    const work = "/work"
    mountSample(work)
    setFile("wiki.yaml", "version: 1\nid: work\nrole: work\nmechanism_library: ../../../lib\n", work)

    const ctx = await loadMechanismContext(work)

    expect(ctx!.mechanismLibraryPath).toBe("/lib")
  })

  it("loads without lenses/ and schema/page-types/ folders", async () => {
    for (const key of [...tree.files.keys()]) {
      if (key.startsWith(`${PROJECT}/lenses/`) || key.startsWith(`${PROJECT}/schema/page-types/`)) {
        tree.files.delete(key)
      }
    }

    const ctx = await loadMechanismContext(PROJECT)

    expect(ctx!.lenses).toEqual({})
    expect(ctx!.pageTypeRules).toEqual({})
    // The sample domains still name built-in lenses, which are known even without a file.
    expect(ctx!.configIssues).toEqual([])
    expect(Object.keys(ctx!.domains.domains)).toHaveLength(3)
  })

  it("ignores non-markdown files in lenses/", async () => {
    setFile("lenses/notes.txt", "not a lens")
    setFile("lenses/.DS_Store", "junk")

    const ctx = await loadMechanismContext(PROJECT)

    expect(Object.keys(ctx!.lenses).sort()).toEqual(["ai", "business", "hardware", "physics"])
  })

  it("records an issue for a listed lens file that cannot be read, which still counts as a known lens", async () => {
    setFile("lenses/chemistry.md", "# Lens: chemistry\n\n## Fields\n\nWrite: species.\n")
    makeUnreadable("lenses/chemistry.md")
    setFile(
      "domains.yaml",
      [
        "version: 1",
        "domains:",
        "  chemistry/catalysis:",
        "    lens: chemistry",
        "    description: Reactions sped up by a catalyst",
        "",
      ].join("\n"),
    )

    const ctx = await loadMechanismContext(PROJECT)

    // One issue, for the file. The domain is valid because the stem is a known lens.
    expect(ctx!.configIssues).toEqual([{ path: "lenses/chemistry.md", message: "could not read the file" }])
    expect(Object.keys(ctx!.domains.domains)).toEqual(["chemistry/catalysis"])
    expect(Object.keys(ctx!.lenses).sort()).toEqual(["ai", "business", "hardware", "physics"])
    expect(lensForDomain(ctx!, "chemistry/catalysis")).toBeNull()
  })

  it("records an issue for a page-type file that cannot be read and leaves it out", async () => {
    makeUnreadable("schema/page-types/mechanism.md")

    const ctx = await loadMechanismContext(PROJECT)

    expect(ctx!.configIssues).toEqual([
      { path: "schema/page-types/mechanism.md", message: "could not read the file" },
    ])
    expect(Object.keys(ctx!.pageTypeRules).sort()).toEqual([
      "comparison",
      "concept",
      "entity",
      "hypothesis",
      "query",
      "source",
    ])
  })

  it("records an issue for a lens file with none of the prompt sections", async () => {
    setFile("lenses/empty.md", "# Lens: empty\n\n## Purpose\n\nNothing else.\n")

    const ctx = await loadMechanismContext(PROJECT)

    expect(ctx!.lenses.empty.promptText).toBe("")
    expect(ctx!.configIssues).toHaveLength(1)
    expect(ctx!.configIssues[0].path).toBe("lenses/empty.md")
  })
})

describe("canWriteMechanismPages", () => {
  it("sample reading wiki can write mechanism pages", async () => {
    const ctx = await loadMechanismContext(PROJECT)

    expect(canWriteMechanismPages(ctx!)).toBe(true)
  })

  it("missing wiki.yaml can write mechanism pages", async () => {
    removeFile("wiki.yaml")

    const ctx = await loadMechanismContext(PROJECT)

    expect(ctx!.identityStatus).toBe("missing")
    expect(canWriteMechanismPages(ctx!)).toBe(true)
  })

  it("invalid wiki.yaml cannot write mechanism pages", async () => {
    // A work wiki with a broken file would otherwise read as a reading wiki.
    setFile("wiki.yaml", "version: 1\nid: work\nrole: work\n")

    const ctx = await loadMechanismContext(PROJECT)

    expect(ctx!.identityStatus).toBe("invalid")
    expect(ctx!.identity.role).toBe("reading")
    expect(canWriteMechanismPages(ctx!)).toBe(false)
  })

  it("work wiki cannot write mechanism pages", async () => {
    setFile("wiki.yaml", "version: 1\nid: work\nrole: work\nmechanism_library: ../reading\n")

    const ctx = await loadMechanismContext(PROJECT)

    expect(ctx!.identityStatus).toBe("ok")
    expect(ctx!.identity.role).toBe("work")
    expect(canWriteMechanismPages(ctx!)).toBe(false)
  })
})

describe("lensForDomain", () => {
  it("returns the hardware lens for hardware/async-circuits", async () => {
    const ctx = await loadMechanismContext(PROJECT)

    const lens = lensForDomain(ctx!, "hardware/async-circuits")

    expect(lens).not.toBeNull()
    expect(lens!.id).toBe("hardware")
  })

  it("uses the nearest listed ancestor for a deeper path", async () => {
    const ctx = await loadMechanismContext(PROJECT)

    expect(lensForDomain(ctx!, "hardware/async-circuits/handshakes/four-phase")!.id).toBe("hardware")
    expect(lensForDomain(ctx!, "ai/architecture/spiking")!.id).toBe("ai")
  })

  it("returns null for a domain with no listed ancestor", async () => {
    const ctx = await loadMechanismContext(PROJECT)

    expect(lensForDomain(ctx!, "hardware")).toBeNull()
    expect(lensForDomain(ctx!, "biology/cells")).toBeNull()
    expect(lensForDomain(ctx!, "constructor")).toBeNull()
  })

  it("returns null when the lens file is missing", async () => {
    removeFile("lenses/hardware.md")
    const ctx = await loadMechanismContext(PROJECT)

    expect(lensForDomain(ctx!, "hardware/async-circuits")).toBeNull()
  })
})

describe("extractLensPromptText", () => {
  it("returns the three sections in file order, each with its heading", () => {
    const text = [
      "# Lens: x",
      "",
      "## Purpose",
      "",
      "Skip me.",
      "",
      "## Fields",
      "",
      "### Parts",
      "",
      "Write: parts.",
      "",
      "## Evidence standard",
      "",
      "1. Data.",
      "",
      "## Strength rules",
      "",
      "- `surface`: loose.",
      "",
      "## Example",
      "",
      "Skip me too.",
      "",
    ].join("\n")

    expect(extractLensPromptText(text)).toBe(
      [
        "## Fields",
        "",
        "### Parts",
        "",
        "Write: parts.",
        "",
        "## Evidence standard",
        "",
        "1. Data.",
        "",
        "## Strength rules",
        "",
        "- `surface`: loose.",
      ].join("\n"),
    )
  })

  it("ignores `## ` lines inside fences, so a fenced heading neither starts nor ends a section", () => {
    const text = [
      "## Fields",
      "",
      "Before.",
      "",
      "```markdown",
      "## Evidence standard",
      "fake",
      "```",
      "",
      "After the fence.",
      "",
      "## Example",
      "",
      "````markdown",
      "## Strength rules",
      "```",
      "still inside the outer fence",
      "```",
      "## Fields",
      "````",
      "",
      "## Strength rules",
      "",
      "Real rules.",
      "",
    ].join("\n")

    const result = extractLensPromptText(text)

    expect(result).toBe(
      [
        "## Fields",
        "",
        "Before.",
        "",
        "```markdown",
        "## Evidence standard",
        "fake",
        "```",
        "",
        "After the fence.",
        "",
        "## Strength rules",
        "",
        "Real rules.",
      ].join("\n"),
    )
  })

  it("handles tilde fences and an unclosed fence", () => {
    const tilde = "## Fields\n\n~~~\n## Example\n~~~\n\nKept.\n\n## Example\n\nDrop.\n"
    expect(extractLensPromptText(tilde)).toBe("## Fields\n\n~~~\n## Example\n~~~\n\nKept.")

    const unclosed = "## Fields\n\nKept.\n\n## Example\n\n```\n## Strength rules\nnever closed\n"
    expect(extractLensPromptText(unclosed)).toBe("## Fields\n\nKept.")
  })

  it("matches heading names without regard to case, spacing, or a trailing colon", () => {
    const text = "##   fields:  \n\nA.\n\n## EVIDENCE STANDARD\n\nB.\n\n## Strength Rules ##\n\nC.\n"
    expect(extractLensPromptText(text)).toBe(
      "##   fields:  \n\nA.\n\n## EVIDENCE STANDARD\n\nB.\n\n## Strength Rules ##\n\nC.",
    )
  })

  it("accepts CRLF line endings and does not match level-3 headings or look-alikes", () => {
    const text = "## Fields\r\n\r\n### Evidence standard\r\n\r\nA.\r\n\r\n## Fields and more\r\n\r\nDrop.\r\n"
    expect(extractLensPromptText(text)).toBe("## Fields\n\n### Evidence standard\n\nA.")
  })

  it("returns an empty string when no section matches", () => {
    expect(extractLensPromptText("# Lens\n\n## Purpose\n\nText.\n")).toBe("")
  })
})
