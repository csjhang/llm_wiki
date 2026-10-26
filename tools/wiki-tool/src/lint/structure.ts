/**
 * `wiki-tool lint structure` - the structural lint (layer 1) of a mechanism wiki, without a model.
 *
 * `--project P` gives `{ ok: true, findings }`. The command reads the pages under `wiki/`, `wiki.yaml`,
 * `domains.yaml`, the `domains.yaml` of the reading wiki (in a work wiki), and the card map
 * `heptabase-map.json`, and passes them to `checkStructure`, the same pure function that the lint view of the app
 * uses (`runMechanismStructuralLint` in `src/lib/mechanism-wiki/lint-run.ts`). It changes nothing. A config file
 * that is missing or not valid gives `config-invalid` findings, not an error (ruling U14). A project without
 * `domains.yaml` is not a mechanism wiki: exit 2.
 */
import { readFileSync } from "node:fs"
import {
  cardMapFromJson,
  checkStructure,
  localDate,
  type StructureInput,
  structurePageFromMarkdown,
} from "@/lib/mechanism-wiki/lint-structure"
import { CARD_MAP_FILE } from "../card-map"
import { type CommandResult, resolveInProject } from "../io"
import { readWikiPages } from "../mirror-pages"
import { loadLintProject, notMechanismWiki, parseLintArgs } from "./project"

export function lintStructure(args: string[]): CommandResult {
  const parsed = parseLintArgs(args)
  if (!parsed.ok) return parsed.result
  const { project } = parsed

  const config = loadLintProject(project)
  if (config === null) return notMechanismWiki(project)

  const pages = readWikiPages(project, { allowMissingWiki: true }).map((page) => structurePageFromMarkdown(page.path, page.markdown))
  const findings = checkStructure({
    pages,
    domains: config.domains,
    identity: config.identity,
    cardMap: readLintCardMap(project),
    today: localDate(),
    libraryDomains: config.libraryDomains,
    configProblems: config.configProblems,
  })
  return { ok: true, findings }
}

/**
 * The card map of the project for the checks, read by `cardMapFromJson` (the function of the app). Null when the
 * file is missing, cannot be read, or is not a card map: it is left out of the checks.
 */
function readLintCardMap(project: string): StructureInput["cardMap"] {
  try {
    return cardMapFromJson(readFileSync(resolveInProject(project, CARD_MAP_FILE), "utf8"))
  } catch {
    return null
  }
}
