/**
 * The `fuse` command group: prepare, check, and commit hypotheses that fuse a mechanism with another domain.
 *
 * Commands never call Heptabase. A skill saves the MCP output to files, and the commands read those files and the wikis.
 */
import type { CommandGroup } from "../io"
import { resolveBoard } from "./resolve-board"

export const FUSE_GROUP: CommandGroup = {
  name: "fuse",
  commands: { "resolve-board": resolveBoard },
}
