/**
 * Reading the saved result of `read_object` for a command.
 *
 * snapshot and record (feedback) take the text of a card as files: one file for each page of the result, or one file
 * with the text of the card.
 */
import { readFileSync } from "node:fs"
import { failedStatus, isReadObjectResult, joinReadObjectPages, parseReadObjectHeader } from "./parse-mcp"

/**
 * The text of the card. The files are the pages of one read_object result (joined in line order), or one
 * file of the card's own text. Null when a file cannot be read, is the result of a failed call or of another
 * card (`cardId` is null when the card id is not valid, and then the card is not compared), or the files are
 * not one of these. Every reason is added to `problems`.
 */
export function readContentFiles(paths: readonly string[], cardId: string | null, problems: string[]): string | null {
  if (paths.length === 0) return null
  const before = problems.length
  const texts: string[] = []
  for (const path of paths) {
    let text: string
    try {
      text = readFileSync(path, "utf8").replace(/^﻿/, "")
    } catch {
      problems.push(`cannot read --content file: ${path}`)
      continue
    }
    const status = failedStatus(text)
    const header = parseReadObjectHeader(text)
    if (status !== null) {
      problems.push(`--content file ${path} is the result of a call that did not succeed (status: ${status})`)
    } else if (header && cardId !== null && header.id.toLowerCase() !== cardId) {
      problems.push(`--content file ${path} is the result for card ${header.id}, not card ${cardId}`)
    }
    texts.push(text)
  }
  if (problems.length > before) return null
  const pages = texts.filter(isReadObjectResult).length
  if (pages === texts.length) return joinReadObjectPages(texts)
  if (pages === 0 && texts.length === 1) return texts[0]
  problems.push("--content must be the pages of one read_object result, or one file with the text of the card")
  return null
}
