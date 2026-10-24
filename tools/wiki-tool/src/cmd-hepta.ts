/**
 * The `hepta` command group: sync between a wiki and Heptabase.
 *
 * Commands never call Heptabase. A skill saves the MCP output to files, and the
 * commands read those files and the card map.
 */
import { init } from "./cmd-init"
import type { CommandGroup } from "./io"

export const HEPTA_GROUP: CommandGroup = {
  name: "hepta",
  commands: { init },
}
