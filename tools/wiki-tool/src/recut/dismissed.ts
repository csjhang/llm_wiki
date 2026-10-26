/**
 * The dismissed fusion pairs after a recut (ruling U5).
 *
 * `.llm-wiki/fusion-dismissed.json` lists the pairs of a mechanism and a target domain that the user skipped
 * (`recordDismissedPairs` in `src/lib/mechanism-wiki/fusion-candidates.ts`). When a recut gives a domain another name,
 * its pairs follow, so that a skipped candidate stays skipped. The file is local state and never committed. A file
 * that is missing, is not JSON, or is not a list is left alone, and so is an entry that is not a pair. A file that is a
 * link that leads out of the project, or that cannot be resolved, is never written: the function throws.
 */
import { existsSync, readFileSync } from "node:fs"
import { resolveInProject, writeFileAtomic } from "../io"
import { insideProblem } from "./inside"

export const FUSION_DISMISSED_FILE = ".llm-wiki/fusion-dismissed.json"

interface Pair {
  mechanism: string
  targetDomain: string
  [key: string]: unknown
}

function isPair(value: unknown): value is Pair {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false
  const entry = value as Record<string, unknown>
  return typeof entry.mechanism === "string" && typeof entry.targetDomain === "string"
}

/**
 * Give the target domain of every pair its new name. Returns true when the file changed. Two pairs that are the same
 * after the rewrite (a merge) become one. The file is written as the app writes it: indented JSON and a line break.
 */
export function remapDismissedPairs(project: string, map: (domain: string) => string): boolean {
  const path = resolveInProject(project, FUSION_DISMISSED_FILE)
  if (!existsSync(path)) return false
  const problem = insideProblem(project, FUSION_DISMISSED_FILE)
  if (problem !== null) throw new Error(problem)
  let entries: unknown
  try {
    entries = JSON.parse(readFileSync(path, "utf8"))
  } catch {
    return false
  }
  if (!Array.isArray(entries)) return false

  let changed = false
  const seen = new Set<string>()
  const next: unknown[] = []
  for (const entry of entries) {
    if (!isPair(entry)) {
      next.push(entry)
      continue
    }
    const targetDomain = map(entry.targetDomain)
    if (targetDomain !== entry.targetDomain) changed = true
    const key = `${entry.mechanism}\0${targetDomain}`
    if (seen.has(key)) {
      changed = true
      continue
    }
    seen.add(key)
    next.push(targetDomain === entry.targetDomain ? entry : { ...entry, targetDomain })
  }
  if (!changed) return false
  writeFileAtomic(path, `${JSON.stringify(next, null, 2)}\n`)
  return true
}
