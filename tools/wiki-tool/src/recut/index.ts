/**
 * The `recut` command group: change the domain list of a mechanism wiki and bring every page along.
 *
 * `pages` lists the pages that a recut of one domain concerns (input for the assignment of a split). `apply` runs a
 * rename, move, split, or merge from a plan and makes one commit. Neither calls Heptabase.
 */
import type { CommandGroup } from "../io"
import { recutApply } from "./apply"
import { recutPages } from "./pages"

export const RECUT_GROUP: CommandGroup = {
  name: "recut",
  commands: { pages: recutPages, apply: recutApply },
}
