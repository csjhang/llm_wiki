/**
 * panel-config.ts — the buttons of the skill panel.
 *
 * `plugins/llm-wiki/panel.yaml` lists the buttons. The description of each
 * button is the `description` in the frontmatter of the SKILL.md of its skill.
 * Vite reads both at build time as raw text, so the app needs no file access.
 */
import panelYaml from "../../../plugins/llm-wiki/panel.yaml?raw"
import { parseFrontmatter } from "@/lib/frontmatter"
import { UUID_PATTERN } from "@/lib/wiki-config/types"
import type { ConfigIssue, ParseResult } from "@/lib/wiki-config/types"
import {
  checkVersion,
  childPath,
  hasOwn,
  isRecord,
  loadYamlMapping,
  reportUnknownKeys,
} from "@/lib/wiki-config/yaml-util"

export const PANEL_MODES = ["background", "conversation"] as const
export type PanelMode = (typeof PANEL_MODES)[number]

export const PANEL_INPUTS = ["whiteboard", "hypothesis"] as const
export type PanelInput = (typeof PANEL_INPUTS)[number]

export interface PanelEntry {
  /** Name of the skill folder, and the slash command. */
  skill: string
  label: string
  mode: PanelMode
  /** Values the panel asks for before it runs the skill. */
  inputs: PanelInput[]
  /** Fixed text that goes after the skill name in the command. */
  args?: string
  /** The `description` of the SKILL.md of the skill. */
  description: string
}

const TOP_LEVEL_KEYS = ["version", "buttons"] as const
const BUTTON_KEYS = ["skill", "label", "mode", "inputs", "args"] as const

// The command goes to a terminal, so every word in it must be plain. These are
// the only characters a word may have: letters, digits, ".", "_", "/", and "-".
const SAFE_WORD = /^[A-Za-z0-9._/-]+$/

/** True when the word has only safe characters and no `..` path segment. */
function isSafeWord(word: string): boolean {
  return SAFE_WORD.test(word) && !word.split("/").includes("..")
}

/**
 * Parse and validate the text of `panel.yaml`. Collects every issue before
 * returning. A skill is known when `skillDescriptions` has its name; the
 * description of the entry comes from there.
 */
export function parsePanelYaml(
  text: string,
  skillDescriptions: Record<string, string>,
): ParseResult<PanelEntry[]> {
  const loaded = loadYamlMapping(text)
  if (!loaded.ok) return { ok: false, issues: [loaded.issue] }

  const root = loaded.value
  const issues: ConfigIssue[] = []
  checkVersion(root, issues)
  reportUnknownKeys(root, TOP_LEVEL_KEYS, "", issues)
  const entries = parseButtons(root.buttons, skillDescriptions, issues)

  if (issues.length > 0) return { ok: false, issues }
  return { ok: true, value: entries, issues: [] }
}

function parseButtons(
  raw: unknown,
  skillDescriptions: Record<string, string>,
  issues: ConfigIssue[],
): PanelEntry[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    issues.push({ path: "buttons", message: "must be a non-empty list of buttons" })
    return []
  }
  const entries: PanelEntry[] = []
  const seen = new Set<string>()
  // The panel finds the run of a button by its label, so two buttons must not share one.
  const seenLabels = new Set<string>()
  raw.forEach((item, index) => {
    const path = `buttons[${index}]`
    const entry = parseButton(item, path, skillDescriptions, issues)
    if (!entry) return
    if (seen.has(entry.skill)) {
      issues.push({ path: childPath(path, "skill"), message: `duplicate button for skill "${entry.skill}"` })
      return
    }
    if (seenLabels.has(entry.label)) {
      issues.push({ path: childPath(path, "label"), message: `duplicate label "${entry.label}"` })
      return
    }
    seen.add(entry.skill)
    seenLabels.add(entry.label)
    entries.push(entry)
  })
  return entries
}

function parseButton(
  raw: unknown,
  path: string,
  skillDescriptions: Record<string, string>,
  issues: ConfigIssue[],
): PanelEntry | null {
  if (!isRecord(raw)) {
    issues.push({ path, message: "must be a mapping with skill, label, mode, and optional inputs and args" })
    return null
  }
  const before = issues.length
  reportUnknownKeys(raw, BUTTON_KEYS, path, issues)

  let skill = ""
  if (typeof raw.skill === "string" && hasOwn(skillDescriptions, raw.skill)) {
    skill = raw.skill
  } else {
    issues.push({
      path: childPath(path, "skill"),
      message: `must name a skill of the plugin; known skills: ${Object.keys(skillDescriptions).join(", ")}`,
    })
  }

  let label = ""
  if (typeof raw.label === "string" && raw.label.trim() !== "") {
    label = raw.label.trim()
  } else {
    issues.push({ path: childPath(path, "label"), message: "must be a non-empty string" })
  }

  let mode: PanelMode = "background"
  if (typeof raw.mode === "string" && (PANEL_MODES as readonly string[]).includes(raw.mode)) {
    mode = raw.mode as PanelMode
  } else {
    issues.push({ path: childPath(path, "mode"), message: `must be one of: ${PANEL_MODES.join(", ")}` })
  }

  const inputs = parseInputs(raw.inputs, childPath(path, "inputs"), issues)
  const args = parseArgs(raw.args, childPath(path, "args"), issues)

  if (issues.length > before) return null
  const entry: PanelEntry = { skill, label, mode, inputs, description: skillDescriptions[skill] }
  if (args !== undefined) entry.args = args
  return entry
}

function parseInputs(raw: unknown, path: string, issues: ConfigIssue[]): PanelInput[] {
  if (raw === undefined || raw === null) return []
  if (!Array.isArray(raw)) {
    issues.push({ path, message: `must be a list; allowed values: ${PANEL_INPUTS.join(", ")}` })
    return []
  }
  const inputs: PanelInput[] = []
  raw.forEach((item, index) => {
    const itemPath = `${path}[${index}]`
    if (typeof item !== "string" || !(PANEL_INPUTS as readonly string[]).includes(item)) {
      issues.push({ path: itemPath, message: `must be one of: ${PANEL_INPUTS.join(", ")}` })
    } else if (inputs.includes(item as PanelInput)) {
      issues.push({ path: itemPath, message: `duplicate input "${item}"` })
    } else {
      inputs.push(item as PanelInput)
    }
  })
  return inputs
}

/** Fixed arguments: words split on single spaces, each a safe word. A word may start with `--`, like `--yes`. */
function parseArgs(raw: unknown, path: string, issues: ConfigIssue[]): string | undefined {
  if (raw === undefined || raw === null) return undefined
  const args = typeof raw === "string" ? raw.trim() : ""
  if (args === "" || !args.split(" ").every(isSafeWord)) {
    issues.push({
      path,
      message:
        'must be words of letters, digits, ".", "_", "/", and "-", split by single spaces; a word may start with "--"',
    })
    return undefined
  }
  return args
}

/**
 * Descriptions of skills, keyed by skill folder name. `files` maps the path of
 * each file to its text, like the result of `import.meta.glob`. Only
 * `<folder>/SKILL.md` files count. A file with no frontmatter `description`
 * gives no entry.
 */
export function readSkillDescriptions(files: Record<string, string>): Record<string, string> {
  const descriptions: Record<string, string> = {}
  for (const [path, text] of Object.entries(files)) {
    const match = /(?:^|\/)([^/]+)\/SKILL\.md$/.exec(path)
    if (!match) continue
    const description = parseFrontmatter(text).frontmatter?.description
    if (typeof description !== "string" || description.trim() === "") continue
    descriptions[match[1]] = description.trim()
  }
  return descriptions
}

/** Check one input value. It goes into a terminal command, so a value that is not plain throws. */
function checkInput(name: PanelInput, value: string): void {
  const ok =
    name === "whiteboard" ? UUID_PATTERN.test(value) : isSafeWord(value) && !value.startsWith("-")
  if (!ok) {
    const expected =
      name === "whiteboard"
        ? "a lowercase UUID"
        : 'a path of letters, digits, ".", "_", "/", and "-" that does not start with "-" and has no ".." segment'
    throw new Error(`the ${name} value must be ${expected}`)
  }
}

/**
 * The slash command for a button: `/<skill> [args] [input values in the order
 * of the entry]`. A blank input is left out, so the skill asks for it. The
 * command goes to a terminal, so each value must pass an allowlist: a
 * `whiteboard` value is a lowercase UUID, and a `hypothesis` value is a plain
 * relative path. Any other value throws.
 */
export function commandFor(entry: PanelEntry, inputs: Record<string, string>): string {
  const parts = [`/${entry.skill}`]
  if (entry.args) parts.push(entry.args)
  for (const name of entry.inputs) {
    const value = (inputs[name] ?? "").trim()
    if (value === "") continue
    checkInput(name, value)
    parts.push(value)
  }
  return parts.join(" ")
}

const skillFiles = import.meta.glob("/plugins/llm-wiki/skills/*/SKILL.md", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>

function loadPanelEntries(): PanelEntry[] {
  const parsed = parsePanelYaml(panelYaml, readSkillDescriptions(skillFiles))
  if (!parsed.ok) {
    const lines = parsed.issues.map((issue) => `${issue.path || "(file)"}: ${issue.message}`)
    throw new Error(`plugins/llm-wiki/panel.yaml is not valid:\n${lines.join("\n")}`)
  }
  return parsed.value
}

/** The panel buttons, in display order. Loaded at build time. */
export const PANEL_ENTRIES: PanelEntry[] = loadPanelEntries()
