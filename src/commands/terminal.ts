import { invoke } from "@tauri-apps/api/core"

/**
 * Open Claude Code in a new terminal window, in the project folder, with
 * `command` (for example `/wiki-fuse <whiteboard id>`).
 *
 * Resolves to the name of the launcher that started. Rejects with a message
 * when no terminal could start, or when the text is unsafe; the caller then
 * offers to copy the command so the user can run it in any terminal.
 */
export async function openClaudeTerminal(
  projectPath: string,
  command: string,
): Promise<string> {
  return invoke<string>("open_claude_terminal", { projectPath, command })
}
