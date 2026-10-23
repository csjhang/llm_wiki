/**
 * apply-template.ts — write a project template into a new project folder.
 *
 * The caller passes the file functions in (`TemplateFs`), so this module has
 * no dependency on Tauri and tests can use a fake.
 */
import type { WikiTemplate } from "@/lib/templates"

export interface TemplateFs {
  writeFile(path: string, content: string): Promise<void>
  createDirectory(path: string): Promise<void>
}

/** Backslashes to "/", no trailing "/". */
function normalizeRoot(projectPath: string): string {
  return projectPath.replace(/\\/g, "/").replace(/\/+$/, "")
}

/** Template-relative path: "/" separators, no leading or trailing "/". */
function normalizeRelative(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "")
}

/** Every folder above a file, outermost first: "a/b/c.md" gives ["a", "a/b"]. */
function parentFolders(relativeFile: string): string[] {
  const parts = relativeFile.split("/").slice(0, -1)
  return parts.map((_, i) => parts.slice(0, i + 1).join("/"))
}

/**
 * Write `schema.md`, `purpose.md`, the extra folders, and the extra files of
 * `template` into `projectPath`. Each folder is created once, and a parent
 * folder is created before its children and before the files inside it.
 */
export async function applyTemplate(
  projectPath: string,
  template: WikiTemplate,
  fs: TemplateFs,
): Promise<void> {
  const root = normalizeRoot(projectPath)
  const abs = (relative: string) => `${root}/${relative}`

  await fs.writeFile(abs("schema.md"), template.schema)
  await fs.writeFile(abs("purpose.md"), template.purpose)

  const created = new Set<string>()
  const ensureDirectory = async (relative: string) => {
    if (!relative || created.has(relative)) return
    created.add(relative)
    await fs.createDirectory(abs(relative))
  }

  for (const dir of template.extraDirs) {
    await ensureDirectory(normalizeRelative(dir))
  }

  for (const [file, content] of Object.entries(template.files ?? {})) {
    const relative = normalizeRelative(file)
    for (const folder of parentFolders(relative)) {
      await ensureDirectory(folder)
    }
    await fs.writeFile(abs(relative), content)
  }
}
