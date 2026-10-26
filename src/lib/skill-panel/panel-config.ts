/**
 * panel-config.ts — the buttons of the skill panel.
 *
 * `plugins/llm-wiki/panel.yaml` lists the buttons. The description of each
 * button is the `description` in the frontmatter of the SKILL.md of its skill.
 * Vite reads both at build time as raw text, so the app needs no file access.
 */
import panelYaml from "../../../plugins/llm-wiki/panel.yaml?raw"
import { parseFrontmatter } from "@/lib/frontmatter"
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
  raw.forEach((item, index) => {
    const entry = parseButton(item, `buttons[${index}]`, skillDescriptions, issues)
    if (entry) entries.push(entry)
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
    label = raw.label
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

function parseArgs(raw: unknown, path: string, issues: ConfigIssue[]): string | undefined {
  if (raw === undefined || raw === null) return undefined
  if (typeof raw === "string" && raw.trim() !== "" && !/[\r\n]/.test(raw)) return raw.trim()
  issues.push({ path, message: "must be a non-empty string on one line" })
  return undefined
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

/**
 * The slash command for a button: `/<skill> [args] [input values in the order
 * of the entry]`. A blank input is left out, so the skill asks for it. A value
 * with whitespace inside would change the command, so it throws.
 */
export function commandFor(entry: PanelEntry, inputs: Record<string, string>): string {
  const parts = [`/${entry.skill}`]
  if (entry.args) parts.push(entry.args)
  for (const name of entry.inputs) {
    const value = (inputs[name] ?? "").trim()
    if (value === "") continue
    if (/\s/.test(value)) throw new Error(`the ${name} value must not contain whitespace`)
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
