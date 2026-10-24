/**
 * `wiki-tool hepta record` - tell the card map what the skill did in Heptabase.
 *
 * The skill runs one action of `plan-down`, then records one event. Each event changes the
 * map and saves it before the command returns, so a run that stops halfway keeps what was
 * done, and the next `plan-down` plans only the rest.
 *
 *   {"type":"created","page","cardId","cardUpdatedAt"[,"contentHash"]}
 *   {"type":"updated","page","cardUpdatedAt"[,"contentHash"]}      (also for a relink)
 *   {"type":"placed","page","whiteboardId"}
 *   {"type":"retired","page"[,"cardUpdatedAt"]}
 *   {"type":"feedback","page","cardId","cardUpdatedAt","content"}
 *
 * `contentHash` is the `contentHash` of the action. It is the hash of the card that was sent
 * (body and property values), which can differ from the page now (links to cards that did not
 * exist then). Without it, the hash of the page as it renders now is used.
 *
 * A `feedback` event saves the text a user wrote in a mirror card as a note under
 * `raw/sources/heptabase/`, so the next ingest reads it. It also records the time of that edit
 * (`cardUpdatedAt`, the `updatedAt` of the card) in the map, so plan-down reports one edit once.
 */
import { existsSync } from "node:fs"
import { posix } from "node:path"
import { UUID_PATTERN } from "@/lib/wiki-config/types"
import { isRecord } from "@/lib/wiki-config/yaml-util"
import { parseArgs, parseNowOption } from "./args"
import { type CardMap, contentHash, loadCardMap, type PageEntry, saveCardMap } from "./card-map"
import { type CommandResult, isDirectory, resolveInProject, writeFileAtomic } from "./io"
import {
  cardHash,
  createRenderer,
  pageProperties,
  readProjectConfig,
  readWikiPage,
  readWikiPages,
  RETIRED_BODY,
  slugOfPath,
} from "./mirror-pages"

const OPTION_SPEC = { values: ["project", "event", "now"] } as const

const FEEDBACK_DIRECTORY = "raw/sources/heptabase"
const HASH_PATTERN = /^[0-9a-f]{64}$/

interface RecordContext {
  project: string
  map: CardMap
  event: Record<string, unknown>
  now: Date
}

/** A handler returns the result, or the problems that stopped it. Nothing is saved when it fails. */
type EventHandler = (context: RecordContext) => CommandResult

const HANDLERS: Record<string, EventHandler> = {
  created: recordCreated,
  updated: recordUpdated,
  placed: recordPlaced,
  retired: recordRetired,
  feedback: recordFeedback,
}

export function record(args: string[]): CommandResult {
  const { parsed, problems: optionProblems } = parseArgs(args, OPTION_SPEC)
  const problems = [...optionProblems]
  const project = parsed.values.project
  const eventText = parsed.values.event
  if (project === undefined) problems.push("missing option: --project")
  if (eventText === undefined) problems.push("missing option: --event")
  if (problems.length > 0 || project === undefined || eventText === undefined) return { ok: false, problems }
  if (!isDirectory(project)) return { ok: false, problems: [`project folder not found: ${project}`] }

  const now = parseNowOption(parsed.values.now, problems)
  const event = parseEvent(eventText, problems)
  let map: CardMap | null = null
  try {
    map = loadCardMap(project)
  } catch (error) {
    problems.push(error instanceof Error ? error.message : String(error))
  }
  if (problems.length > 0 || !now || !event || !map) return { ok: false, problems }

  const type = event.type
  const handler = typeof type === "string" && Object.prototype.hasOwnProperty.call(HANDLERS, type) ? HANDLERS[type] : null
  if (!handler) return { ok: false, problems: [`unknown event type: ${JSON.stringify(type)}`] }
  return handler({ project, map, event, now })
}

function parseEvent(text: string, problems: string[]): Record<string, unknown> | null {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch (error) {
    problems.push(`--event is not valid JSON: ${error instanceof Error ? error.message : String(error)}`)
    return null
  }
  if (!isRecord(value)) {
    problems.push("--event must be a JSON object")
    return null
  }
  if (typeof value.type !== "string") {
    problems.push('--event needs a "type"')
    return null
  }
  return value
}

// --- fields ------------------------------------------------------------

/** Reads the fields of an event and collects what is wrong with them. */
class Fields {
  readonly problems: string[] = []

  constructor(private readonly event: Record<string, unknown>) {}

  /** A page path under `wiki/`, normalized. */
  page(): string {
    const value = this.event.page
    const normalized = typeof value === "string" ? posix.normalize(value.trim()) : ""
    if (!normalized.startsWith("wiki/") || !normalized.toLowerCase().endsWith(".md")) {
      this.problems.push('event "page" must be a path under wiki/ that ends with .md')
      return ""
    }
    return normalized
  }

  /** A lowercase UUID. */
  id(key: string): string {
    const value = this.event[key]
    if (typeof value === "string" && UUID_PATTERN.test(value)) return value
    this.problems.push(`event "${key}" must be an id (a lowercase UUID)`)
    return ""
  }

  /** An ISO date and time; the text is kept as it is. */
  time(key: string, required: boolean): string | undefined {
    const value = this.event[key]
    if (value === undefined && !required) return undefined
    if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}/.test(value) && !Number.isNaN(Date.parse(value))) return value
    this.problems.push(`event "${key}" must be an ISO date and time`)
    return undefined
  }

  /** The hash of the action, or undefined when the event has none. */
  hash(): string | undefined {
    const value = this.event.contentHash
    if (value === undefined) return undefined
    if (typeof value === "string" && HASH_PATTERN.test(value)) return value
    this.problems.push('event "contentHash" must be the contentHash of the action (64 lowercase hex digits)')
    return undefined
  }

  /** Text that is not blank. */
  text(key: string): string {
    const value = this.event[key]
    if (typeof value === "string" && value.trim() !== "") return value
    this.problems.push(`event "${key}" must be text that is not empty`)
    return ""
  }
}

function fail(problems: string[]): CommandResult {
  return { ok: false, problems }
}

function mappedPage(map: CardMap, page: string, problems: string[]): PageEntry | null {
  const entry = map.pages[page]
  if (entry) return entry
  problems.push(`${page} is not in the card map`)
  return null
}

/**
 * The hash of the card of a page as it renders now. A page that is being created is not
 * linked to itself, because it has no card yet.
 */
function currentHash(context: RecordContext, page: string, creating: boolean, problems: string[]): string | null {
  const wikiPage = readWikiPage(context.project, page)
  if (!wikiPage) {
    problems.push(`cannot compute the content hash: ${page} cannot be read; give "contentHash" in the event`)
    return null
  }
  const config = readProjectConfig(context.project, problems)
  if (!config) {
    problems.push('cannot compute the content hash without a valid heptabase.yaml and wiki.yaml; give "contentHash" in the event')
    return null
  }
  const skip = creating ? new Set([page]) : undefined
  const renderer = createRenderer(context.project, context.map, readWikiPages(context.project), skip)
  const properties = pageProperties(wikiPage, { properties: config.heptabase.properties, wikiId: config.wiki.id })
  return cardHash(renderer.render(wikiPage), properties)
}

/** A card belongs to one page. A card id that is another page's card or a source snapshot cannot be a new mirror card. */
function cardIdProblems(map: CardMap, page: string, cardId: string): string[] {
  const problems: string[] = []
  for (const [path, entry] of Object.entries(map.pages)) {
    if (path !== page && entry.card_id === cardId) problems.push(`card ${cardId} is already the card of ${path}`)
  }
  if (Object.prototype.hasOwnProperty.call(map.sources, cardId)) {
    problems.push(`card ${cardId} is a source snapshot, so it cannot be a mirror card`)
  }
  return problems
}

function saved(context: RecordContext, event: string, page: string, entry: PageEntry): CommandResult {
  context.map.pages[page] = entry
  saveCardMap(context.project, context.map)
  return { ok: true, event, page, entry }
}

// --- events ------------------------------------------------------------

function recordCreated(context: RecordContext): CommandResult {
  const fields = new Fields(context.event)
  const page = fields.page()
  const cardId = fields.id("cardId")
  const cardUpdatedAt = fields.time("cardUpdatedAt", true)
  const given = fields.hash()
  const problems = fields.problems
  const existing = page === "" ? undefined : context.map.pages[page]
  if (existing && existing.status === "active" && cardId !== "" && existing.card_id !== cardId) {
    problems.push(`${page} is already mapped to card ${existing.card_id}`)
  }
  if (cardId !== "") problems.push(...cardIdProblems(context.map, page, cardId))
  const hash = problems.length === 0 ? (given ?? currentHash(context, page, true, problems)) : null
  if (problems.length > 0 || hash === null || cardUpdatedAt === undefined) return fail(problems)

  return saved(context, "created", page, {
    card_id: cardId,
    content_hash: hash,
    last_synced_at: context.now.toISOString(),
    card_updated_at: cardUpdatedAt,
    placements: existing?.card_id === cardId ? existing.placements : [],
    status: "active",
  })
}

function recordUpdated(context: RecordContext): CommandResult {
  const fields = new Fields(context.event)
  const page = fields.page()
  const cardUpdatedAt = fields.time("cardUpdatedAt", true)
  const given = fields.hash()
  const problems = fields.problems
  const existing = page === "" ? null : mappedPage(context.map, page, problems)
  const hash = problems.length === 0 ? (given ?? currentHash(context, page, false, problems)) : null
  if (problems.length > 0 || !existing || hash === null || cardUpdatedAt === undefined) return fail(problems)

  return saved(context, "updated", page, {
    ...existing,
    content_hash: hash,
    last_synced_at: context.now.toISOString(),
    card_updated_at: cardUpdatedAt,
    status: "active",
  })
}

function recordPlaced(context: RecordContext): CommandResult {
  const fields = new Fields(context.event)
  const page = fields.page()
  const whiteboardId = fields.id("whiteboardId")
  const problems = fields.problems
  const existing = page === "" ? null : mappedPage(context.map, page, problems)
  if (problems.length > 0 || !existing) return fail(problems)

  const placements = existing.placements.includes(whiteboardId) ? existing.placements : [...existing.placements, whiteboardId]
  return saved(context, "placed", page, { ...existing, placements })
}

function recordRetired(context: RecordContext): CommandResult {
  const fields = new Fields(context.event)
  const page = fields.page()
  const cardUpdatedAt = fields.time("cardUpdatedAt", false)
  const problems = fields.problems
  const existing = page === "" ? null : mappedPage(context.map, page, problems)
  if (problems.length > 0 || !existing) return fail(problems)

  return saved(context, "retired", page, {
    ...existing,
    content_hash: contentHash(RETIRED_BODY),
    last_synced_at: context.now.toISOString(),
    card_updated_at: cardUpdatedAt ?? existing.card_updated_at,
    status: "retired",
  })
}

function recordFeedback(context: RecordContext): CommandResult {
  const fields = new Fields(context.event)
  const page = fields.page()
  const cardId = fields.id("cardId")
  const cardUpdatedAt = fields.time("cardUpdatedAt", true)
  const content = fields.text("content")
  const problems = fields.problems
  const existing = page === "" ? null : mappedPage(context.map, page, problems)
  if (existing && cardId !== "" && existing.card_id !== cardId) {
    problems.push(`card ${cardId} is not the card of ${page} (${existing.card_id})`)
  }
  if (problems.length > 0 || !existing || cardUpdatedAt === undefined) return fail(problems)

  const stamp = context.now.toISOString().slice(0, 16).replace(/\D/g, "")
  const relative = freeNotePath(context.project, `${FEEDBACK_DIRECTORY}/feedback-${cardId}-${stamp}`)
  const title = `Feedback on ${readWikiPage(context.project, page)?.title ?? slugOfPath(page)}`
  const text = [
    "---",
    `title: ${JSON.stringify(title)}`,
    `heptabase_card_id: ${cardId}`,
    "source_kind: note",
    "---",
    "",
    `${content.replace(/\s+$/, "")}\n`,
  ].join("\n")
  // The note goes first: if the map fails to save, the edit is reported once more, and no text is lost.
  writeFileAtomic(resolveInProject(context.project, relative), text)

  const handled = Math.max(Date.parse(cardUpdatedAt), Date.parse(existing.feedback_card_updated_at ?? ""))
  const feedback_card_updated_at = Number.isNaN(handled) ? cardUpdatedAt : new Date(handled).toISOString()
  context.map.pages[page] = { ...existing, feedback_card_updated_at }
  saveCardMap(context.project, context.map)
  return { ok: true, event: "feedback", page, written: relative }
}

/** `<stem>.md`, or `<stem>-2.md`, `<stem>-3.md`, ... for the first name that is not a file yet. */
function freeNotePath(project: string, stem: string): string {
  for (let number = 1; ; number += 1) {
    const relative = `${stem}${number === 1 ? "" : `-${number}`}.md`
    if (!existsSync(resolveInProject(project, relative))) return relative
  }
}
