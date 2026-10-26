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
import { checkStructure, type StructureInput, structurePageFromMarkdown } from "@/lib/mechanism-wiki/lint-structure"
import { isRecord } from "@/lib/wiki-config/yaml-util"
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
    cardMap: loadCardMap(project),
    today: localDate(new Date()),
    libraryDomains: config.libraryDomains,
    configProblems: config.configProblems,
  })
  return { ok: true, findings }
}

/**
 * The pages of `heptabase-map.json` with the two fields the checks read. Null when the file is missing, is not
 * JSON, or is not a card map of version 1: it is left out of the checks, as in the app. An entry without a text
 * `status` and `card_id` is left out.
 */
function loadCardMap(project: string): StructureInput["cardMap"] {
  try {
    const raw: unknown = JSON.parse(readFileSync(resolveInProject(project, CARD_MAP_FILE), "utf8").replace(/^﻿/, ""))
    if (!isRecord(raw) || raw.version !== 1 || !isRecord(raw.pages)) return null
    const entries: Array<[string, { status: string; card_id: string }]> = []
    for (const [path, entry] of Object.entries(raw.pages)) {
      if (isRecord(entry) && typeof entry.status === "string" && typeof entry.card_id === "string") {
        entries.push([path, { status: entry.status, card_id: entry.card_id }])
      }
    }
    // `fromEntries` makes plain own properties, also for a page path such as `__proto__`.
    return { pages: Object.fromEntries(entries) }
  } catch {
    return null
  }
}

/** The local date as `YYYY-MM-DD`. */
function localDate(now: Date): string {
  const two = (value: number): string => String(value).padStart(2, "0")
  return `${String(now.getFullYear()).padStart(4, "0")}-${two(now.getMonth() + 1)}-${two(now.getDate())}`
}
