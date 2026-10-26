/**
 * Layer 1 of the domain lint, run on a project in the app.
 *
 * `runMechanismStructuralLint` reads the files that `checkStructure` needs (the pages, `domains.yaml`,
 * `wiki.yaml`, the card map, and in a work wiki the `domains.yaml` of the reading wiki) and returns its
 * findings. It writes nothing. A problem found while the config files were read goes to `checkStructure`
 * as a config problem (ruling U14). The lint view and the ingest queue call it. `checkStructure` itself
 * is pure and also runs in the `wiki-tool` CLI; this file reads files through the app, so the tool does
 * not import it.
 */
import { readFile } from "@/commands/fs"
import { normalizePath } from "@/lib/path-utils"
import type { DomainsConfig } from "@/lib/wiki-config/domains"
import { loadMechanismContext } from "./context"
import type { MechanismContext } from "./context"
import { scanWikiPagesWith } from "./domain-index"
import { cardMapFromJson, checkStructure, configProblemText, localDate, structurePageFromMarkdown } from "./lint-structure"
import type { StructureFinding, StructureInput } from "./lint-structure"

/** The card map that `wiki-tool` writes, in the project folder. */
const CARD_MAP_FILE = "heptabase-map.json"

export interface StructuralLintRunOptions {
  /** When it aborts, the run stops at its next step and rejects with an `AbortError`. */
  signal?: AbortSignal
}

/**
 * The structural findings of a mechanism wiki. A project that is not a mechanism wiki (no
 * `domains.yaml`) has none: the result is `[]`. A card map that is missing or cannot be read is
 * left out of the checks. The date of today is the local date.
 */
export async function runMechanismStructuralLint(
  projectPath: string,
  options: StructuralLintRunOptions = {},
): Promise<StructureFinding[]> {
  const { signal } = options
  throwIfAborted(signal)
  const ctx = await loadMechanismContext(projectPath)
  if (ctx === null) return []
  throwIfAborted(signal)

  const [pages, library, cardMap] = await Promise.all([
    scanWikiPagesWith(projectPath, structurePageFromMarkdown),
    loadLibrary(ctx),
    loadCardMap(projectPath),
  ])
  throwIfAborted(signal)

  return checkStructure({
    pages,
    domains: ctx.domains,
    identity: ctx.identity,
    cardMap,
    today: localDate(),
    libraryDomains: library.domains,
    configProblems: [...ctx.configIssues.map((issue) => configProblemText(issue, "this")), ...library.problems],
  })
}

/** What the lint needs from the reading wiki of a work wiki. */
interface LibraryInfo {
  /** `domains.yaml` of the reading wiki. Null for a reading wiki, and when the file is not there. */
  domains: DomainsConfig | null
  /** The config problems of the reading wiki, as text for `configProblems`. */
  problems: string[]
}

/**
 * The reading wiki of a work wiki: its domains and the problems found while its config files were read.
 * A reading wiki has none. A work wiki whose library has no `domains.yaml` (the folder is missing or is
 * not a mechanism wiki) gets one problem that says so.
 */
async function loadLibrary(ctx: MechanismContext): Promise<LibraryInfo> {
  if (ctx.identity.role !== "work" || ctx.mechanismLibraryPath === null) return { domains: null, problems: [] }
  try {
    const library = await loadMechanismContext(ctx.mechanismLibraryPath)
    if (library === null) {
      const issue = { path: "domains.yaml", message: `the file is missing at ${normalizePath(ctx.mechanismLibraryPath)}` }
      return { domains: null, problems: [configProblemText(issue, "library")] }
    }
    return { domains: library.domains, problems: library.configIssues.map((issue) => configProblemText(issue, "library")) }
  } catch {
    return { domains: null, problems: [] }
  }
}

/** The card map of the project for the checks. Null when the file is missing, cannot be read, or is not a card map. */
async function loadCardMap(projectPath: string): Promise<StructureInput["cardMap"]> {
  try {
    return cardMapFromJson(await readFile(`${normalizePath(projectPath).replace(/\/+$/, "")}/${CARD_MAP_FILE}`))
  } catch {
    return null
  }
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new DOMException("Structural lint cancelled", "AbortError")
}
