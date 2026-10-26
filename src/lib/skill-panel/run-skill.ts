/**
 * run-skill.ts - what a button of the skill panel does.
 *
 * - A conversation button opens Claude Code in a terminal, so the user can answer the
 *   questions of the skill.
 * - A background button runs `claude -p "<command>"` with nobody watching. The progress
 *   goes into one item of the activity store, and the final text or the error text of
 *   Claude Code replaces it at the end.
 *
 * When Claude Code is missing, or a terminal or a run cannot start, the command is copied
 * so the user can run it anywhere. The caller hears about it through `onFallback`.
 *
 * The code never touches Tauri. The caller passes the launchers in `deps`, so each branch
 * is tested with fakes.
 */
import {
  buildExitError,
  createBoundedDiagnosticBuffer,
  extractClaudeCodeStructuredError,
  shouldCaptureClaudeDiagnostic,
} from "@/lib/claude-cli-transport"
import type { ActivityItem } from "@/stores/activity-store"
import { commandFor, type PanelEntry } from "./panel-config"

/** The part of the activity store that a run uses. */
export interface ActivityApi {
  addItem(item: Omit<ActivityItem, "id" | "createdAt">): string
  updateItem(id: string, updates: Partial<Pick<ActivityItem, "status" | "detail" | "filesWritten">>): void
}

/** What a background run sends back: one stdout line per call, then the exit. */
export interface SkillRunHandlers {
  onLine(line: string): void
  onExit(result: { code: number | null; stderr: string }): void
}

export type FallbackReason = "claude-missing" | "spawn-failed" | "terminal-failed"

/** Sent to `onFallback` when the command was copied instead of run. */
export interface SkillFallback {
  reason: FallbackReason
  /** Why, in the words of the launcher. May be empty. */
  detail: string
  command: string
}

export interface RunSkillDeps {
  /** Absolute path of the open project. */
  projectPath: string
  /** `claude_cli_detect`. */
  detectClaude(): Promise<{ installed: boolean; error?: string | null }>
  /** Start `claude -p "<command>"` in the project. Resolves when the process has started. */
  spawnClaude(projectPath: string, command: string, handlers: SkillRunHandlers): Promise<void>
  /** `open_claude_terminal`. Resolves to the name of the launcher. */
  openTerminal(projectPath: string, command: string): Promise<string>
  copy(text: string): Promise<void>
  activity: ActivityApi
  /** Called when the command was copied instead of run. */
  onFallback?(fallback: SkillFallback): void
}

/** The command could not be run and could not be copied. `command` is for the user to copy by hand. */
export class SkillCopyError extends Error {
  readonly command: string
  /** Why the copy failed, in the words of the clipboard. */
  readonly reason: string

  constructor(reason: string, command: string) {
    super(`Could not copy the command (${reason})`)
    this.name = "SkillCopyError"
    this.reason = reason
    this.command = command
  }
}

/** Progress lines that stay in the item while the run goes on. */
const MAX_PROGRESS_LINES = 6
/** One progress line. */
const MAX_LINE_CHARS = 200
/** The final text of a run. A report is longer than a line, but not endless. */
const MAX_FINAL_CHARS = 8000

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === "string") return error
  try {
    return JSON.stringify(error) ?? String(error)
  } catch {
    return String(error)
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function firstLine(text: string, max = MAX_LINE_CHARS): string {
  const first = text.split("\n").find((part) => part.trim() !== "") ?? ""
  const trimmed = first.trim()
  return trimmed.length > max ? `${trimmed.slice(0, max)}...` : trimmed
}

function cutFinal(text: string): string {
  return text.length > MAX_FINAL_CHARS ? `${text.slice(0, MAX_FINAL_CHARS)}\n... (cut)` : text
}

/** The text of a `tool_result` block: a string, or a list of text blocks. */
function toolResultText(content: unknown): string {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  return content
    .map((part) => (isRecord(part) && typeof part.text === "string" ? part.text : ""))
    .filter((part) => part !== "")
    .join("\n")
}

function uniqueStrings(values: unknown[]): string[] {
  return [...new Set(values.filter((value): value is string => typeof value === "string" && value !== ""))]
}

interface FinalResult {
  text: string
  isError: boolean
  /** Names of the tools that the settings denied. */
  denied: string[]
}

interface Snapshot {
  status: ActivityItem["status"]
  detail: string
}

/**
 * Reads the stream-json lines of one run. `snapshot()` is what the activity item shows now:
 * the command and the latest progress while the run goes on, then the final text or the error.
 */
function createRunMonitor(command: string): {
  feed(rawLine: string): void
  finish(exit: { code: number | null; stderr: string }): void
  snapshot(): Snapshot
} {
  const progress: string[] = []
  const denialTexts = new Set<string>()
  const diagnostics = createBoundedDiagnosticBuffer()
  let lastText = ""
  let structuredError = ""
  let finalResult: FinalResult | null = null
  let outcome: Snapshot | null = null

  const addProgress = (text: string): void => {
    if (text !== "") progress.push(text)
  }

  const feedAssistant = (event: Record<string, unknown>): void => {
    const message = event.message
    const content = isRecord(message) ? message.content : null
    if (!Array.isArray(content)) return
    for (const block of content) {
      if (!isRecord(block)) continue
      if (block.type === "text" && typeof block.text === "string" && block.text.trim() !== "") {
        lastText = block.text.trim()
        addProgress(firstLine(lastText))
      } else if (block.type === "tool_use" && typeof block.name === "string") {
        const input = isRecord(block.input) ? block.input : {}
        const why = typeof input.description === "string" ? firstLine(input.description, 100) : ""
        addProgress(why ? `-> ${block.name}: ${why}` : `-> ${block.name}`)
      }
    }
  }

  const feedUser = (event: Record<string, unknown>): void => {
    const message = event.message
    const content = isRecord(message) ? message.content : null
    if (!Array.isArray(content)) return
    for (const block of content) {
      if (!isRecord(block) || block.type !== "tool_result" || block.is_error !== true) continue
      const text = toolResultText(block.content).trim()
      // A denial has its own event, shown already.
      if (text === "" || denialTexts.has(text)) continue
      addProgress(`! ${firstLine(text)}`)
    }
  }

  const feedSystem = (event: Record<string, unknown>): void => {
    if (event.subtype !== "permission_denied") return
    const text = typeof event.message === "string" ? event.message.trim() : ""
    if (text !== "") denialTexts.add(text)
    const tool = typeof event.tool_name === "string" ? event.tool_name : "a tool"
    addProgress(`! Denied ${tool}${text ? `: ${firstLine(text)}` : ""}`)
  }

  const feedResult = (event: Record<string, unknown>): void => {
    let text = typeof event.result === "string" ? event.result.trim() : ""
    if (text === "" && Array.isArray(event.errors)) {
      text = uniqueStrings(event.errors).join("\n")
    }
    const denials = Array.isArray(event.permission_denials) ? event.permission_denials : []
    finalResult = {
      text,
      isError: event.is_error === true,
      denied: uniqueStrings(denials.map((denial) => (isRecord(denial) ? denial.tool_name : undefined))),
    }
  }

  const deniedNote = (): string =>
    finalResult && finalResult.denied.length > 0 ? `\n\nDenied tools: ${finalResult.denied.join(", ")}` : ""

  return {
    feed(rawLine) {
      const line = rawLine.trim()
      if (line === "") return
      let event: unknown
      try {
        event = JSON.parse(line)
      } catch {
        diagnostics.append(line)
        return
      }
      if (!isRecord(event)) {
        diagnostics.append(line)
        return
      }
      switch (event.type) {
        case "assistant":
          feedAssistant(event)
          return
        case "user":
          feedUser(event)
          return
        case "system":
          feedSystem(event)
          return
        case "result":
          feedResult(event)
          return
        default: {
          const error = extractClaudeCodeStructuredError(line)
          if (error) structuredError = error
          else if (shouldCaptureClaudeDiagnostic(line)) diagnostics.append(line)
        }
      }
    },

    finish({ code, stderr }) {
      const errorText = stderr.trim()
      const failed = code !== null && code !== 0
      const result = finalResult as FinalResult | null
      if (result) {
        if (result.isError || failed) {
          const text = result.text || (failed ? buildExitError(code ?? 1, errorText, structuredError || diagnostics.value()) : errorText)
          outcome = { status: "error", detail: cutFinal(text || "Claude Code reported an error with no text.") + deniedNote() }
        } else {
          outcome = { status: "done", detail: cutFinal(result.text || lastText || "Finished with no text.") + deniedNote() }
        }
        return
      }
      const details = structuredError || diagnostics.value()
      if (failed) {
        outcome = { status: "error", detail: cutFinal(buildExitError(code ?? 1, errorText, details)) }
      } else if (structuredError) {
        outcome = { status: "error", detail: cutFinal(buildExitError(code ?? 1, errorText, structuredError)) }
      } else {
        const why = code === null ? "Claude Code was stopped before it finished" : "Claude Code ended with no result"
        const more = [errorText, details].filter((part) => part !== "").join("\n")
        outcome = { status: "error", detail: cutFinal(more ? `${why}:\n${more}` : `${why}.`) }
      }
    },

    snapshot() {
      if (outcome) return outcome
      return { status: "running", detail: [command, ...progress.slice(-MAX_PROGRESS_LINES)].join("\n") }
    },
  }
}

/**
 * Run one button. Resolves to `"started"` when the terminal opened or the background run
 * started (it does not wait for the run to end), and to `"copied"` when the command was
 * copied instead. Throws the message of `commandFor` for a bad value, and a `SkillCopyError`
 * when the command could not be copied either.
 */
export async function runSkill(
  entry: PanelEntry,
  inputs: Record<string, string>,
  deps: RunSkillDeps,
): Promise<"started" | "copied"> {
  const command = commandFor(entry, inputs)

  const fallBack = async (reason: FallbackReason, detail: string): Promise<"copied"> => {
    try {
      await deps.copy(command)
    } catch (error) {
      throw new SkillCopyError(messageOf(error), command)
    }
    deps.onFallback?.({ reason, detail, command })
    return "copied"
  }

  if (entry.mode === "conversation") {
    // No check for Claude Code here: the terminal says it when `claude` is missing.
    try {
      await deps.openTerminal(deps.projectPath, command)
      return "started"
    } catch (error) {
      return fallBack("terminal-failed", messageOf(error))
    }
  }

  let detected: { installed: boolean; error?: string | null }
  try {
    detected = await deps.detectClaude()
  } catch (error) {
    detected = { installed: false, error: messageOf(error) }
  }
  if (!detected.installed) {
    return fallBack("claude-missing", detected.error?.trim() || "Claude Code was not found")
  }

  const monitor = createRunMonitor(command)
  let itemId: string | null = null
  const show = (): void => {
    if (itemId === null) return
    const { status, detail } = monitor.snapshot()
    deps.activity.updateItem(itemId, { status, detail })
  }

  try {
    await deps.spawnClaude(deps.projectPath, command, {
      onLine(line) {
        monitor.feed(line)
        show()
      },
      onExit(exit) {
        monitor.finish(exit)
        show()
      },
    })
  } catch (error) {
    return fallBack("spawn-failed", messageOf(error))
  }

  // The item exists after the start, so a failed start leaves none. A fast run may
  // have sent events already; `show()` replays them.
  itemId = deps.activity.addItem({
    type: "skill",
    title: entry.label,
    status: "running",
    detail: command,
    filesWritten: [],
  })
  show()
  return "started"
}
