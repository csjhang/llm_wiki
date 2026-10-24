/**
 * Entry point of the bundled wiki-tool.
 *
 * Prints the result of runCli as one JSON line on stdout and sets the exit code.
 * The code is set on process.exitCode, not with process.exit, so stdout is flushed.
 */
import { runCli } from "./cli"

const { exitCode, output } = await runCli(process.argv.slice(2))
process.stdout.write(`${JSON.stringify(output)}\n`)
process.exitCode = exitCode
