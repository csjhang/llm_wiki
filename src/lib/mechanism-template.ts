/**
 * mechanism-template.ts — the "Mechanism Wiki" project template.
 *
 * The template files live in `templates/mechanism-wiki/` at the repo root.
 * Vite reads them at build time as raw text, so the app needs no file access
 * to ship them. `schema.md` and `purpose.md` fill the two standard template
 * fields. Every other file goes into `files`, and `applyTemplate` writes them.
 */
// Type-only import: `templates.ts` imports this module at runtime to register
// the template, so a value import here would create a cycle.
import type { WikiTemplate } from "@/lib/templates"

const TEMPLATE_ROOT = "/templates/mechanism-wiki/"

const rawFiles = import.meta.glob("/templates/mechanism-wiki/**/*", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>

/** Template files keyed by path relative to `templates/mechanism-wiki/`, with "/" separators. */
export const MECHANISM_TEMPLATE_FILES: Readonly<Record<string, string>> = Object.freeze(
  Object.fromEntries(
    Object.entries(rawFiles).map(([path, content]) => [path.slice(TEMPLATE_ROOT.length), content]),
  ),
)

const { "schema.md": schema, "purpose.md": purpose, ...otherFiles } = MECHANISM_TEMPLATE_FILES

export const mechanismTemplate: WikiTemplate = {
  id: "mechanism",
  name: "Mechanism Wiki",
  description: "Cross-domain mechanisms, fusion hypotheses, and Heptabase sync",
  icon: "🧩",
  schema,
  purpose,
  files: otherFiles,
  extraDirs: ["wiki/mechanisms", "wiki/hypotheses", "wiki/indexes", "raw/sources/heptabase"],
}
