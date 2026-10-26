/**
 * lint-reminder.ts - how many ingests ran since the last semantic lint.
 *
 * The count is the `ingestsSince` of `wiki-tool lint changed-domains`
 * (`tools/wiki-tool/src/lint/changed-domains.ts`): the commits after the commit of the marker
 * `.llm-wiki/semantic-lint.json` that touch the project folder and whose subject starts with
 * `ingest:`. No marker, a marker that cannot be used, or a marker commit that HEAD does not reach
 * counts every such commit. One Rust command does the counting (`git_count_subjects`); a Rust test
 * checks that it gives the number of `wiki-tool`. The panel shows a reminder when the count reaches
 * `lint.semantic_reminder_ingests` of `wiki.yaml`.
 */
import { readFile } from "@/commands/fs"
import { gitCountSubjects } from "@/commands/git"
import { loadWikiIdentity } from "@/lib/mechanism-wiki/context"
import { normalizePath } from "@/lib/path-utils"

/** The marker file of the semantic lint, relative to the project folder. `lint mark` writes it. */
export const SEMANTIC_LINT_MARKER = ".llm-wiki/semantic-lint.json"

/** The subject start of the commit of an ingest (`buildActionCommitMessage("ingest", ...)`). */
export const INGEST_SUBJECT_PREFIX = "ingest:"

/** A sha as the marker keeps it: 7 to 64 hex digits (`tools/wiki-tool/src/lint/marker.ts`). Anything else could be read by git as an option or a name. */
const SHA_PATTERN = /^[0-9a-f]{7,64}$/i

/** The commit of the marker file in lower case, or null when the text is not a marker with a usable sha. */
export function parseMarkerCommit(text: string): string | null {
  let marker: unknown
  try {
    marker = JSON.parse(text.replace(/^﻿/, ""))
  } catch {
    return null
  }
  const commit = typeof marker === "object" && marker !== null ? (marker as { commit?: unknown }).commit : undefined
  return typeof commit === "string" && SHA_PATTERN.test(commit) ? commit.toLowerCase() : null
}

/** The commit of the marker of the project. A marker that is missing or cannot be used gives null. */
async function readMarkerCommit(projectPath: string): Promise<string | null> {
  const base = normalizePath(projectPath).replace(/\/+$/, "")
  try {
    return parseMarkerCommit(await readFile(`${base}/${SEMANTIC_LINT_MARKER}`))
  } catch {
    return null
  }
}

/** The number of ingests since the last semantic lint. Rejects when git fails. */
export async function ingestsSinceSemanticLint(projectPath: string): Promise<number> {
  return gitCountSubjects(projectPath, await readMarkerCommit(projectPath), INGEST_SUBJECT_PREFIX)
}

/** True when the reminder is due: at least one ingest, and as many as the threshold. An unknown count is never due. */
export function reminderDue(count: number | null, threshold: number): boolean {
  return count !== null && count > 0 && count >= threshold
}

export interface LintReminder {
  /** The ingests since the last semantic lint. */
  count: number
  /** `lint.semantic_reminder_ingests` of `wiki.yaml`. */
  threshold: number
  due: boolean
}

/**
 * The reminder state of the project. Never rejects: a git error is logged and gives null, so the
 * panel shows no reminder and still works.
 */
export async function loadLintReminder(projectPath: string): Promise<LintReminder | null> {
  try {
    const [count, identity] = await Promise.all([ingestsSinceSemanticLint(projectPath), loadWikiIdentity(projectPath)])
    const threshold = identity.lint.semantic_reminder_ingests
    return { count, threshold, due: reminderDue(count, threshold) }
  } catch (error) {
    console.warn("[skill-panel] could not count the ingests since the last semantic lint:", error)
    return null
  }
}
