/**
 * claude-skill-spawn.ts - the Tauri side of a background skill run.
 *
 * Rust side: `claude_cli_run_skill` and `claude_cli_detect` in
 * src-tauri/src/commands/claude_cli.rs. A run sends its stdout lines as
 * `claude-cli:{streamId}` events and its exit as `claude-cli:{streamId}:done`.
 *
 * It is not the chat transport (`claude-cli-transport.ts`). The chat transport shuts
 * the user's slash commands, tools, and MCP servers off. A skill needs all three.
 */
import { invoke } from "@tauri-apps/api/core"
import { listen, type UnlistenFn } from "@tauri-apps/api/event"
import type { SkillRunHandlers } from "./run-skill"

interface DetectResult {
  installed: boolean
  error?: string | null
}

/** Is Claude Code on the machine, and does `claude --version` run? */
export async function detectClaudeCode(): Promise<{ installed: boolean; error: string | null }> {
  const found = await invoke<DetectResult>("claude_cli_detect")
  return { installed: found.installed === true, error: found.error ?? null }
}

/**
 * Start `claude -p "<command>"` in the project folder. Resolves to the stream id when the process has
 * started; the output comes later through `handlers`. The stream id is what `killClaudeSkill` needs to stop the run.
 * Rejects with the message of Rust when it cannot start.
 */
export async function spawnClaudeSkill(
  projectPath: string,
  command: string,
  handlers: SkillRunHandlers,
): Promise<string> {
  const streamId = crypto.randomUUID()
  const unlisteners: UnlistenFn[] = []
  const stopListening = (): void => {
    while (unlisteners.length > 0) unlisteners.pop()?.()
  }

  try {
    // Listen first, so the first events of a fast run are not lost.
    unlisteners.push(
      await listen<string>(`claude-cli:${streamId}`, (event) => {
        handlers.onLine(event.payload)
      }),
    )
    unlisteners.push(
      await listen<{ code?: number | null; stderr?: string }>(`claude-cli:${streamId}:done`, (event) => {
        stopListening()
        handlers.onExit({ code: event.payload?.code ?? null, stderr: event.payload?.stderr ?? "" })
      }),
    )
    await invoke("claude_cli_run_skill", { streamId, command, workingDirectory: projectPath })
  } catch (error) {
    stopListening()
    throw error
  }
  return streamId
}

/**
 * Stop a run that `spawnClaudeSkill` started. The process is killed; its exit event still comes,
 * with no exit code. Does nothing for a run that has ended.
 */
export async function killClaudeSkill(streamId: string): Promise<void> {
  await invoke("claude_cli_kill", { streamId })
}
