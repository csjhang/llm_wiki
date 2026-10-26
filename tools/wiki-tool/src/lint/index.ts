/**
 * The `lint` command group: helpers of the domain lint of a mechanism wiki.
 *
 * `structure` runs the structural checks (layer 1). `changed-domains`, `mark`, and `batch` serve the semantic
 * lint (layer 2): which domains to review, where the last review ended, and how to cut the pages of a domain into
 * batches. None of them calls Heptabase or changes a wiki page; `mark` writes the marker file only.
 */
import type { CommandGroup } from "../io"
import { lintBatch } from "./batch"
import { lintChangedDomains } from "./changed-domains"
import { lintMark } from "./mark"
import { lintStructure } from "./structure"

export const LINT_GROUP: CommandGroup = {
  name: "lint",
  commands: { structure: lintStructure, "changed-domains": lintChangedDomains, mark: lintMark, batch: lintBatch },
}
