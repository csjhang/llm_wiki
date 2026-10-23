/**
 * Every ingest must go through the ingest queue: the queue makes the version
 * history baseline, commits a successful ingest, and restores a failed one.
 * A direct `autoIngest(...)` call skips all of that.
 */
import { readdirSync, readFileSync } from "node:fs"
import { join, relative } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

const SRC = fileURLToPath(new URL("../..", import.meta.url))
/** Files allowed to call autoIngest: its own module and the queue. */
const ALLOWED = new Set(["lib/ingest.ts", "lib/ingest-queue.ts"])

function sourceFiles(dir: string): string[] {
  const files: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === "__tests__" || entry.name === "test-helpers") continue
      files.push(...sourceFiles(full))
    } else if (/\.(ts|tsx)$/.test(entry.name) && !/\.test\.(ts|tsx)$/.test(entry.name)) {
      files.push(full)
    }
  }
  return files
}

describe("ingest entry points", () => {
  it("only the ingest queue calls autoIngest", () => {
    const callers = sourceFiles(SRC)
      .map((file) => relative(SRC, file).replace(/\\/g, "/"))
      .filter((file) => !ALLOWED.has(file))
      .filter((file) => /\bautoIngest\s*\(/.test(readFileSync(join(SRC, file), "utf8")))
    expect(callers).toEqual([])
  })
})
