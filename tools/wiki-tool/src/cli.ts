/**
 * wiki-tool dispatcher.
 *
 * Usage: wiki-tool <group> <command> [options]
 *        wiki-tool version
 *
 * runCli never prints and never exits. main.ts prints the output as one JSON line
 * and sets the exit code: 0 for ok, 2 for a handled problem, 1 for an unexpected
 * error. Each command group lives in its own file; add its CommandGroup to GROUPS.
 */
import manifest from "../../../plugins/llm-wiki/.claude-plugin/plugin.json"
import { HEPTA_GROUP } from "./cmd-hepta"
import type { CommandGroup, CommandHandler, CommandResult } from "./io"

/** Command groups. The recut, lint, and fuse groups register here. */
const GROUPS: readonly CommandGroup[] = [HEPTA_GROUP]

/** Commands that take no group. */
const TOP_LEVEL_COMMANDS: Record<string, CommandHandler> = {
  version: () => ({ ok: true, version: manifest.version }),
}

const USAGE = "usage: wiki-tool <group> <command> [options]"

type CliOutcome = { exitCode: 0 | 1 | 2; output: CommandResult }

function problem(message: string): CliOutcome {
  return { exitCode: 2, output: { ok: false, problems: [message] } }
}

/** Own-property lookup, so `constructor` and `__proto__` are not commands. */
function findCommand(commands: Record<string, CommandHandler>, name: string): CommandHandler | undefined {
  return Object.prototype.hasOwnProperty.call(commands, name) ? commands[name] : undefined
}

async function execute(handler: CommandHandler, args: string[]): Promise<CliOutcome> {
  try {
    const output = await handler(args)
    return { exitCode: output.ok ? 0 : 2, output }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { exitCode: 1, output: { ok: false, problems: [`unexpected error: ${message}`] } }
  }
}

export async function runCli(argv: string[], groups: readonly CommandGroup[] = GROUPS): Promise<CliOutcome> {
  const [first, second, ...rest] = argv
  if (first === undefined) return problem(USAGE)

  const topLevel = findCommand(TOP_LEVEL_COMMANDS, first)
  if (topLevel) return execute(topLevel, argv.slice(1))

  const group = groups.find((candidate) => candidate.name === first)
  if (!group || second === undefined) return problem(`unknown command: ${first}`)

  const command = findCommand(group.commands, second)
  if (!command) return problem(`unknown command: ${first} ${second}`)
  return execute(command, rest)
}
