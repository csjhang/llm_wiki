/**
 * sample-wiki.ts — build the sample wiki on disk for tests.
 *
 * `materializeSampleWiki(targetDir)` copies the Mechanism Wiki template files,
 * copies `examples/sample-wiki/` on top (overlay files win), and creates the
 * folders that the app's `create_project` creates, plus the template's
 * `extraDirs`. It does not write wiki/index.md, wiki/log.md, or
 * wiki/overview.md. Uses `node:fs` only, so it needs no Tauri runtime.
 */
import { cp, mkdir, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { MECHANISM_TEMPLATE_FILES, mechanismTemplate } from "@/lib/mechanism-template"

const SAMPLE_WIKI_DIR = fileURLToPath(new URL("../../examples/sample-wiki/", import.meta.url))

/** Folders that the Rust `create_project` command creates. */
const PROJECT_DIRS = [
  "raw/sources",
  "raw/assets",
  "wiki/entities",
  "wiki/concepts",
  "wiki/sources",
  "wiki/queries",
  "wiki/comparisons",
  "wiki/synthesis",
] as const

export async function materializeSampleWiki(targetDir: string): Promise<void> {
  await mkdir(targetDir, { recursive: true })

  // 1. Template files. Keys are relative paths with "/" separators.
  for (const [relativePath, content] of Object.entries(MECHANISM_TEMPLATE_FILES)) {
    const destination = join(targetDir, ...relativePath.split("/"))
    await mkdir(dirname(destination), { recursive: true })
    await writeFile(destination, content, "utf-8")
  }

  // 2. Overlay files. A file here replaces the template file with the same path.
  await cp(SAMPLE_WIKI_DIR, targetDir, { recursive: true, force: true })

  // 3. Folders from `create_project`, then the template's extra folders.
  for (const dir of [...PROJECT_DIRS, ...mechanismTemplate.extraDirs]) {
    await mkdir(join(targetDir, ...dir.split("/")), { recursive: true })
  }
}
