/**
 * Layer 1 of the domain lint, run on a project in the app.
 *
 * `runMechanismStructuralLint` reads the files that `checkStructure` needs (the pages, `domains.yaml`,
 * `wiki.yaml`, the card map, and in a work wiki the `domains.yaml` of the reading wiki) and returns its
 * findings. It writes nothing. The lint view and the ingest queue call it. `checkStructure` itself is
 * pure and also runs in the `wiki-tool` CLI; this file reads files through the app, so the tool does
 * not import it.
 */
import { readFile } from "@/commands/fs"
import { normalizePath } from "@/lib/path-utils"
import type { DomainsConfig } from "@/lib/wiki-config/domains"
import { isRecord } from "@/lib/wiki-config/yaml-util"
import { loadMechanismContext } from "./context"
import type { MechanismContext } from "./context"
import { scanWikiPagesWith } from "./domain-index"
import { checkStructure, structurePageFromMarkdown } from "./lint-structure"
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

  const [pages, libraryDomains, cardMap] = await Promise.all([
    scanWikiPagesWith(projectPath, structurePageFromMarkdown),
    loadLibraryDomains(ctx),
    loadCardMap(projectPath),
  ])
  throwIfAborted(signal)

  return checkStructure({
    pages,
    domains: ctx.domains,
    identity: ctx.identity,
    cardMap,
    today: localDate(new Date()),
    libraryDomains,
  })
}

/**
 * `domains.yaml` of the reading wiki, for a work wiki. Null for a reading wiki, and for a work wiki
 * whose library is not set or is not a mechanism wiki.
 */
async function loadLibraryDomains(ctx: MechanismContext): Promise<DomainsConfig | null> {
  if (ctx.identity.role !== "work" || ctx.mechanismLibraryPath === null) return null
  try {
    return (await loadMechanismContext(ctx.mechanismLibraryPath))?.domains ?? null
  } catch {
    return null
  }
}

/**
 * The pages of `heptabase-map.json` with the two fields the checks read. Null when the file is
 * missing, is not JSON, or is not a card map of version 1. An entry without a text `status` and
 * `card_id` is left out.
 */
async function loadCardMap(projectPath: string): Promise<StructureInput["cardMap"]> {
  try {
    const raw: unknown = JSON.parse(await readFile(`${normalizePath(projectPath).replace(/\/+$/, "")}/${CARD_MAP_FILE}`))
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

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new DOMException("Structural lint cancelled", "AbortError")
}
