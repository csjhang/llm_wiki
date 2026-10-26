import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import yaml from "js-yaml"
import { describe, expect, it } from "vitest"
import type { ParseResult } from "@/lib/wiki-config/types"
import {
  PANEL_ENTRIES,
  commandFor,
  parsePanelYaml,
  readSkillDescriptions,
  type PanelEntry,
} from "./panel-config"

const SKILLS_URL = new URL("../../../plugins/llm-wiki/skills/", import.meta.url)
const WHITEBOARD_ID = "00000000-0000-4000-8000-000000000001"

const DESCRIPTIONS: Record<string, string> = {
  "wiki-sync": "Sync description.",
  "wiki-fuse": "Fuse description.",
  "wiki-lint": "Lint description.",
}

function valueOf<T>(result: ParseResult<T>): T {
  if (!result.ok) throw new Error(`expected ok, got ${JSON.stringify(result.issues)}`)
  return result.value
}

function pathsOf<T>(result: ParseResult<T>): string[] {
  if (result.ok) throw new Error("expected issues, got ok")
  return result.issues.map((issue) => issue.path)
}

/** The `description` of the SKILL.md frontmatter, read the way the contract test reads it. */
function descriptionOnDisk(skill: string): string {
  const text = readFileSync(fileURLToPath(new URL(`${skill}/SKILL.md`, SKILLS_URL)), "utf8")
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)
  if (!match) throw new Error(`No frontmatter in ${skill}`)
  return (yaml.load(match[1]) as { description: string }).description
}

const SAMPLE = `version: 1
buttons:
  - skill: wiki-sync
    label: Sync
    mode: background
    args: --yes
  - skill: wiki-fuse
    label: Fuse
    mode: conversation
    inputs: [whiteboard]
  - skill: wiki-lint
    label: Lint
    mode: background
`

describe("parsePanelYaml", () => {
  it("parses entries in order", () => {
    const entries = valueOf(parsePanelYaml(SAMPLE, DESCRIPTIONS))
    expect(entries.map((entry) => entry.skill)).toEqual(["wiki-sync", "wiki-fuse", "wiki-lint"])
    expect(entries[0]).toEqual({
      skill: "wiki-sync",
      label: "Sync",
      mode: "background",
      inputs: [],
      args: "--yes",
      description: "Sync description.",
    })
    expect(entries[1].inputs).toEqual(["whiteboard"])
    expect(entries[1].args).toBeUndefined()
    expect(entries[2].mode).toBe("background")
  })

  it("rejects an unknown skill", () => {
    const text = SAMPLE.replace("skill: wiki-fuse", "skill: wiki-missing")
    expect(pathsOf(parsePanelYaml(text, DESCRIPTIONS))).toEqual(["buttons[1].skill"])
  })

  it("stores the trimmed label", () => {
    const text = SAMPLE.replace("label: Sync", 'label: "  Sync  "')
    expect(valueOf(parsePanelYaml(text, DESCRIPTIONS))[0].label).toBe("Sync")
  })

  it("rejects two buttons for the same skill", () => {
    const text = `${SAMPLE}  - skill: wiki-lint
    label: Lint again
    mode: background
`
    expect(pathsOf(parsePanelYaml(text, DESCRIPTIONS))).toEqual(["buttons[3].skill"])
  })

  it("accepts args made of safe words split by single spaces", () => {
    const text = SAMPLE.replace("args: --yes", 'args: "--yes --dry-run wiki/example.md"')
    expect(valueOf(parsePanelYaml(text, DESCRIPTIONS))[0].args).toBe("--yes --dry-run wiki/example.md")
  })

  it.each([
    ["a semicolon", "--yes;rm"],
    ["a double quote", '--yes"'],
    ["a single quote", "--yes'"],
    ["a dollar sign", "--$HOME"],
    ["a command substitution", "$(id)"],
    ["a backtick", "`id`"],
    ["an ampersand", "--yes&"],
    ["a pipe", "--yes|cat"],
    ["a redirect", "--yes>out"],
    ["a double space", "--yes  --dry-run"],
    ["a tab", "--yes\t--dry-run"],
    ["a dot-dot segment", "../secret"],
  ])("rejects args with %s", (_name, args) => {
    const text = SAMPLE.replace("args: --yes", `args: ${JSON.stringify(args)}`)
    expect(pathsOf(parsePanelYaml(text, DESCRIPTIONS))).toEqual(["buttons[0].args"])
  })

  it("fills descriptions from SKILL.md", () => {
    // The text of panel.yaml carries no description. It comes from the map.
    const entries = valueOf(parsePanelYaml(SAMPLE, { ...DESCRIPTIONS, "wiki-lint": "Other text." }))
    expect(entries.map((entry) => entry.description)).toEqual([
      "Sync description.",
      "Fuse description.",
      "Other text.",
    ])
    // The shipped entries carry the frontmatter description of each skill, trimmed.
    expect(PANEL_ENTRIES.length).toBeGreaterThan(0)
    for (const entry of PANEL_ENTRIES) {
      expect(entry.description, entry.skill).toBe(descriptionOnDisk(entry.skill).trim())
    }
  })

  it("reads a description from SKILL.md frontmatter", () => {
    const files = {
      "/plugins/llm-wiki/skills/wiki-one/SKILL.md": "---\nname: wiki-one\ndescription: >\n  First line\n  second line.\n---\n\n# one\n",
      "/plugins/llm-wiki/skills/wiki-two/SKILL.md": "---\nname: wiki-two\n---\n\n# no description\n",
      "/plugins/llm-wiki/skills/wiki-three/SKILL.md": "# no frontmatter\n",
      "/plugins/llm-wiki/skills/wiki-four/notes.md": "---\ndescription: not a skill file\n---\n",
    }
    expect(readSkillDescriptions(files)).toEqual({ "wiki-one": "First line second line." })
  })

  it("collects every issue", () => {
    const text = `version: 2
extra: 1
buttons:
  - skill: wiki-sync
    label: ""
    mode: sideways
    inputs: [whiteboard, whiteboard, card]
    args: "a\\nb"
    color: red
  - not a mapping
`
    expect(pathsOf(parsePanelYaml(text, DESCRIPTIONS))).toEqual([
      "version",
      "extra",
      "buttons[0].color",
      "buttons[0].label",
      "buttons[0].mode",
      "buttons[0].inputs[1]",
      "buttons[0].inputs[2]",
      "buttons[0].args",
      "buttons[1]",
    ])
  })

  it("rejects a missing or empty button list and bad YAML", () => {
    expect(pathsOf(parsePanelYaml("version: 1\n", DESCRIPTIONS))).toEqual(["buttons"])
    expect(pathsOf(parsePanelYaml("version: 1\nbuttons: []\n", DESCRIPTIONS))).toEqual(["buttons"])
    expect(pathsOf(parsePanelYaml("- just a list\n", DESCRIPTIONS))).toEqual([""])
    expect(pathsOf(parsePanelYaml("version: 1\nbuttons: [\n", DESCRIPTIONS))).toEqual([""])
  })
})

describe("PANEL_ENTRIES", () => {
  it("lists the five panel buttons in order", () => {
    expect(
      PANEL_ENTRIES.map(({ skill, label, mode, inputs, args }) => ({ skill, label, mode, inputs, args })),
    ).toEqual([
      { skill: "wiki-sync", label: "同步 Heptabase", mode: "background", inputs: [], args: "--yes" },
      { skill: "wiki-fuse", label: "融合", mode: "conversation", inputs: ["whiteboard"], args: undefined },
      { skill: "wiki-lint", label: "健檢", mode: "background", inputs: [], args: undefined },
      { skill: "wiki-recut", label: "切分領域", mode: "conversation", inputs: [], args: undefined },
      { skill: "wiki-undo", label: "退回", mode: "conversation", inputs: [], args: undefined },
    ])
  })
})

describe("commandFor", () => {
  const byName = (skill: string): PanelEntry => {
    const entry = PANEL_ENTRIES.find((candidate) => candidate.skill === skill)
    if (!entry) throw new Error(`no panel entry for ${skill}`)
    return entry
  }

  it("adds the fixed args of wiki-sync", () => {
    expect(commandFor(byName("wiki-sync"), {})).toBe("/wiki-sync --yes")
  })

  it("adds inputs", () => {
    expect(commandFor(byName("wiki-fuse"), { whiteboard: WHITEBOARD_ID })).toBe(`/wiki-fuse ${WHITEBOARD_ID}`)
  })

  it("has no trailing space when there is nothing to add", () => {
    expect(commandFor(byName("wiki-lint"), {})).toBe("/wiki-lint")
    expect(commandFor(byName("wiki-recut"), { whiteboard: WHITEBOARD_ID })).toBe("/wiki-recut")
  })

  it("puts args first, then the input values in the order of the entry", () => {
    const entry: PanelEntry = {
      skill: "wiki-fuse",
      label: "x",
      mode: "conversation",
      inputs: ["whiteboard", "hypothesis"],
      args: "--yes",
      description: "d",
    }
    expect(commandFor(entry, { hypothesis: "wiki/hypotheses/example.md", whiteboard: WHITEBOARD_ID })).toBe(
      `/wiki-fuse --yes ${WHITEBOARD_ID} wiki/hypotheses/example.md`,
    )
  })

  it("leaves out a blank input", () => {
    expect(commandFor(byName("wiki-fuse"), {})).toBe("/wiki-fuse")
    expect(commandFor(byName("wiki-fuse"), { whiteboard: "  " })).toBe("/wiki-fuse")
  })

  it("refuses a whiteboard value that is not a lowercase UUID", () => {
    const entry = byName("wiki-fuse")
    const bad = [
      "a b",
      "a\n/wiki-undo",
      `${WHITEBOARD_ID};rm`,
      `"${WHITEBOARD_ID}"`,
      `'${WHITEBOARD_ID}'`,
      `$(${WHITEBOARD_ID})`,
      `\`${WHITEBOARD_ID}\``,
      `-${WHITEBOARD_ID}`,
      "0000000A-0000-4000-8000-00000000000B",
      "../etc/passwd",
    ]
    for (const value of bad) {
      expect(() => commandFor(entry, { whiteboard: value }), value).toThrow(/whiteboard/)
    }
  })

  describe("hypothesis value", () => {
    const entry: PanelEntry = {
      skill: "wiki-fuse",
      label: "x",
      mode: "conversation",
      inputs: ["hypothesis"],
      description: "d",
    }

    it("accepts a plain wiki path", () => {
      expect(commandFor(entry, { hypothesis: "wiki/hypotheses/example_one-2.md" })).toBe(
        "/wiki-fuse wiki/hypotheses/example_one-2.md",
      )
    })

    it.each([
      ["a semicolon", "wiki/a;rm"],
      ["a double quote", 'wiki/a"'],
      ["a single quote", "wiki/a'"],
      ["a command substitution", "$(id)"],
      ["a variable", "wiki/$HOME"],
      ["a backtick", "`id`"],
      ["an ampersand", "wiki/a&b"],
      ["a pipe", "wiki/a|b"],
      ["a leading dash", "-rf"],
      ["a dot-dot segment", "wiki/../secret.md"],
      ["a leading dot-dot segment", "../secret.md"],
      ["a space", "wiki/a b"],
      ["a newline", "wiki/a\n/wiki-undo"],
    ])("refuses %s", (_name, value) => {
      expect(() => commandFor(entry, { hypothesis: value }), value).toThrow(/hypothesis/)
    })

    it("allows dots inside a name", () => {
      expect(commandFor(entry, { hypothesis: "wiki/a..b.md" })).toBe("/wiki-fuse wiki/a..b.md")
    })
  })
})
