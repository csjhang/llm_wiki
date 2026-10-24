/**
 * `wiki-tool hepta record` - tell the card map what the skill did in Heptabase.
 *
 * The skill runs one action of `plan-down`, then records one event. Each event changes the
 * map and saves it before the command returns, so a run that stops halfway keeps what was
 * done, and the next `plan-down` plans only the rest.
 *
 *   {"type":"created","page","cardId","cardUpdatedAt"[,"contentHash"]}
 *   {"type":"created","page","cardId","setup":false[,"cardUpdatedAt"][,"contentHash"]}   (right after create_object)
 *   {"type":"setup-done","page","cardUpdatedAt"}
 *   {"type":"updated","page","cardUpdatedAt"[,"contentHash"]}
 *   {"type":"relinked","page","cardUpdatedAt"[,"contentHash"]}
 *   {"type":"placed","page","whiteboardId"}
 *   {"type":"retired","page","cardUpdatedAt"}
 *   {"type":"feedback","page","cardId","cardUpdatedAt"}          (with one --content file for each page of read_object)
 *   {"type":"up-decision","cardId","decision"}                    (decision: "skip" or "this-wiki")
 *
 * A `created` event with `"setup": false` is run right after `create_object` returned the card id, before the
 * card is in the mirror tag. The map keeps the page as `setup_pending`, so a failure in the next calls never
 * makes a second card: plan-down plans a `setup` action (tag membership and properties) for the page and
 * nothing else, and `setup-done` clears the state. Until then no `updated`, `relinked`, or `retired` event
 * is taken for the page. Its `cardUpdatedAt` is optional (the time of the command stands in).
 *
 * `contentHash` is the `contentHash` of the action. It is the hash of the card that was sent
 * (body and property values), which can differ from the page now (links to cards that did not
 * exist then). Without it, the hash of the page as it renders now is used.
 *
 * `created`, `updated`, `relinked`, and `retired` keep the text that was sent: the event names the body file of the
 * action (`bodyFile`), or the tool takes the outbox file of the page that plan-down wrote, and copies it to
 * `.llm-wiki/hepta/sent/<card id>.md`. Nothing is copied when the page has no outbox file.
 *
 * A `feedback` event reads the card the skill saved (`--content`, the pages of the `read_object` result) and compares
 * it with the sent text, both as plain Markdown. When they are the same (white space aside), the card is as the wiki
 * wrote it: no note is written. Else the lines the user added and removed are saved as a note under
 * `raw/sources/heptabase/`, so the next ingest reads the user's change and not the text of the wiki. Without a sent
 * text the note holds the whole card. Either way the event records the time of that edit (`cardUpdatedAt`, the
 * `updatedAt` of the card) in the map, so plan-down reports one edit once.
 *
 * An `up-decision` event keeps the user's answer to a question of `plan-up` (an `ask` action): `skip` leaves the
 * card out, `this-wiki` makes it a source of this wiki. `plan-up` plans no question for the card while the answer is
 * in the map and the card has no snapshot.
 */
import { existsSync, readFileSync, statSync } from "node:fs"
import { posix } from "node:path"
import { UUID_PATTERN } from "@/lib/wiki-config/types"
import { isRecord } from "@/lib/wiki-config/yaml-util"
import { parseArgs, parseNowOption } from "./args"
import { type CardMap, contentHash, loadCardMap, type PageEntry, saveCardMap } from "./card-map"
import { cardToSnapshotBody } from "./convert"
import { outboxFile, sentFile } from "./hepta-files"
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
import { readContentFiles } from "./read-content"

const OPTION_SPEC = {
  values: ["project", "event", "now"],
  // One file for each page of the read_object result of a feedback event.
  lists: ["content"],
} as const

const FEEDBACK_DIRECTORY = "raw/sources/heptabase"
const HASH_PATTERN = /^[0-9a-f]{64}$/

interface RecordContext {
  project: string
  map: CardMap
  event: Record<string, unknown>
  now: Date
  /** The `--content` files. Only a feedback event takes them. */
  content: string[]
}

/** A handler returns the result, or the problems that stopped it. Nothing is saved when it fails. */
type EventHandler = (context: RecordContext) => CommandResult

const HANDLERS: Record<string, EventHandler> = {
  created: recordCreated,
  updated: (context) => recordRewritten(context, "updated"),
  relinked: (context) => recordRewritten(context, "relinked"),
  "setup-done": recordSetupDone,
  placed: recordPlaced,
  retired: recordRetired,
  feedback: recordFeedback,
  "up-decision": recordUpDecision,
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
  if (parsed.lists.content.length > 0 && type !== "feedback") {
    return { ok: false, problems: ["--content is only for the feedback event"] }
  }
  return handler({ project, map, event, now, content: parsed.lists.content })
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

  constructor(
    private readonly event: Record<string, unknown>,
    private readonly project: string,
  ) {}

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

  /** The project-relative body file that the event names, or undefined when it names none. It must be a file of the project. */
  bodyFile(): string | undefined {
    const value = this.event.bodyFile
    if (value === undefined) return undefined
    try {
      if (typeof value === "string" && value.trim() !== "" && statSync(resolveInProject(this.project, value)).isFile()) return value
    } catch {
      // Outside the project, or not there: the problem below says so.
    }
    this.problems.push('event "bodyFile" must be a file of the project (the bodyFile of the action)')
    return undefined
  }

  /** True when the event says `"setup": false`: the card exists, but its setup is not done. */
  setupPending(): boolean {
    const value = this.event.setup
    if (value === undefined || typeof value === "boolean") return value === false
    this.problems.push('event "setup" must be true or false')
    return false
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

/** A card that waits for its setup takes no other write event: its tag and properties are not set yet. */
function refuseWhileWaiting(entry: PageEntry | null, page: string, problems: string[]): void {
  if (entry?.setup_pending) problems.push(`${page} is waiting for setup; record setup-done first`)
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

/**
 * Keeps the text of the last write of a card (the named body file, else the outbox file of the page), then saves the map.
 * The text goes first: if the map fails to save, the text is already there for the edit check of the next run.
 */
function savedWithBody(context: RecordContext, event: string, page: string, entry: PageEntry, bodyFile: string | undefined): CommandResult {
  const text = readBody(context, page, bodyFile)
  if (text === null) return saved(context, event, page, entry)
  const sent = sentFile(entry.card_id)
  writeFileAtomic(resolveInProject(context.project, sent), text)
  return { ...saved(context, event, page, entry), sent }
}

/** The text plan-down wants in the card of a page: the named body file, else the outbox file. Null when there is none. */
function readBody(context: RecordContext, page: string, bodyFile: string | undefined): string | null {
  try {
    return readFileSync(resolveInProject(context.project, bodyFile ?? outboxFile(page)), "utf8")
  } catch {
    return null
  }
}

// --- events ------------------------------------------------------------

function recordCreated(context: RecordContext): CommandResult {
  const fields = new Fields(context.event, context.project)
  const page = fields.page()
  const cardId = fields.id("cardId")
  const pending = fields.setupPending()
  // A card that waits for setup has no time from a list yet: the time of the create stands in.
  const cardUpdatedAt = fields.time("cardUpdatedAt", !pending) ?? context.now.toISOString()
  const given = fields.hash()
  const bodyFile = fields.bodyFile()
  const problems = fields.problems
  const existing = page === "" ? undefined : context.map.pages[page]
  if (existing && existing.status === "active" && cardId !== "" && existing.card_id !== cardId) {
    problems.push(`${page} is already mapped to card ${existing.card_id}`)
  }
  if (cardId !== "") problems.push(...cardIdProblems(context.map, page, cardId))
  const hash = problems.length === 0 ? (given ?? currentHash(context, page, true, problems)) : null
  if (problems.length > 0 || hash === null) return fail(problems)

  // The same card recorded again keeps what the map learned about it: the placements and the handled edit.
  const entry: PageEntry = {
    ...(existing?.card_id === cardId ? existing : {}),
    card_id: cardId,
    content_hash: hash,
    last_synced_at: context.now.toISOString(),
    card_updated_at: cardUpdatedAt,
    placements: existing?.card_id === cardId ? existing.placements : [],
    status: "active",
  }
  if (pending) entry.setup_pending = true
  else delete entry.setup_pending
  return savedWithBody(context, "created", page, entry, bodyFile)
}

/** `updated` and `relinked`: the body of the card changed. */
function recordRewritten(context: RecordContext, event: "updated" | "relinked"): CommandResult {
  const fields = new Fields(context.event, context.project)
  const page = fields.page()
  const cardUpdatedAt = fields.time("cardUpdatedAt", true)
  const given = fields.hash()
  const bodyFile = fields.bodyFile()
  const problems = fields.problems
  const existing = page === "" ? null : mappedPage(context.map, page, problems)
  refuseWhileWaiting(existing, page, problems)
  const hash = problems.length === 0 ? (given ?? currentHash(context, page, false, problems)) : null
  if (problems.length > 0 || !existing || hash === null || cardUpdatedAt === undefined) return fail(problems)

  return savedWithBody(
    context,
    event,
    page,
    {
      ...existing,
      content_hash: hash,
      last_synced_at: context.now.toISOString(),
      card_updated_at: cardUpdatedAt,
      status: "active",
    },
    bodyFile,
  )
}

/** The membership and the properties of a new card are set. */
function recordSetupDone(context: RecordContext): CommandResult {
  const fields = new Fields(context.event, context.project)
  const page = fields.page()
  const cardUpdatedAt = fields.time("cardUpdatedAt", true)
  const problems = fields.problems
  const existing = page === "" ? null : mappedPage(context.map, page, problems)
  if (existing && !existing.setup_pending) problems.push(`${page} is not waiting for setup`)
  if (problems.length > 0 || !existing || cardUpdatedAt === undefined) return fail(problems)

  const entry: PageEntry = { ...existing, last_synced_at: context.now.toISOString(), card_updated_at: cardUpdatedAt }
  delete entry.setup_pending
  return saved(context, "setup-done", page, entry)
}

function recordPlaced(context: RecordContext): CommandResult {
  const fields = new Fields(context.event, context.project)
  const page = fields.page()
  const whiteboardId = fields.id("whiteboardId")
  const problems = fields.problems
  const existing = page === "" ? null : mappedPage(context.map, page, problems)
  if (problems.length > 0 || !existing) return fail(problems)

  const placements = existing.placements.includes(whiteboardId) ? existing.placements : [...existing.placements, whiteboardId]
  return saved(context, "placed", page, { ...existing, placements })
}

function recordRetired(context: RecordContext): CommandResult {
  const fields = new Fields(context.event, context.project)
  const page = fields.page()
  const cardUpdatedAt = fields.time("cardUpdatedAt", true)
  const bodyFile = fields.bodyFile()
  const problems = fields.problems
  const existing = page === "" ? null : mappedPage(context.map, page, problems)
  refuseWhileWaiting(existing, page, problems)
  if (problems.length > 0 || !existing || cardUpdatedAt === undefined) return fail(problems)

  return savedWithBody(
    context,
    "retired",
    page,
    {
      ...existing,
      content_hash: contentHash(RETIRED_BODY),
      last_synced_at: context.now.toISOString(),
      card_updated_at: cardUpdatedAt,
      status: "retired",
    },
    bodyFile,
  )
}

function recordFeedback(context: RecordContext): CommandResult {
  const fields = new Fields(context.event, context.project)
  const page = fields.page()
  const cardId = fields.id("cardId")
  const cardUpdatedAt = fields.time("cardUpdatedAt", true)
  const problems = fields.problems
  const existing = page === "" ? null : mappedPage(context.map, page, problems)
  if (existing && cardId !== "" && existing.card_id !== cardId) {
    problems.push(`card ${cardId} is not the card of ${page} (${existing.card_id})`)
  }
  if (context.content.length === 0) problems.push("missing option: --content")
  const cardText = readContentFiles(context.content, cardId === "" ? null : cardId, problems)
  if (problems.length > 0 || !existing || cardUpdatedAt === undefined || cardText === null) return fail(problems)

  const card = cardToSnapshotBody(cardText)
  const sentText = readSent(context.project, existing.card_id)
  const sent = sentText === null ? null : cardToSnapshotBody(sentText)

  let note: string | null = null
  let reason: string | undefined
  if (sent !== null && sameText(sent, card)) {
    reason = "same as sent"
  } else if (sent === null && card.trim() === "") {
    reason = "card is empty"
  } else {
    const stamp = context.now.toISOString().slice(0, 16).replace(/\D/g, "")
    note = freeNotePath(context.project, `${FEEDBACK_DIRECTORY}/feedback-${existing.card_id}-${stamp}`)
    // The note goes first: if the map fails to save, the edit is reported once more, and no text is lost.
    writeFileAtomic(resolveInProject(context.project, note), feedbackNote(context.project, page, existing.card_id, sent, card))
  }

  const handled = Math.max(Date.parse(cardUpdatedAt), Date.parse(existing.feedback_card_updated_at ?? ""))
  const feedback_card_updated_at = Number.isNaN(handled) ? cardUpdatedAt : new Date(handled).toISOString()
  context.map.pages[page] = { ...existing, feedback_card_updated_at }
  saveCardMap(context.project, context.map)
  return { ok: true, event: "feedback", page, note, ...(reason === undefined ? {} : { reason }) }
}

/** The sent text of a card, or null when the tool never saw a write to it. */
function readSent(project: string, cardId: string): string | null {
  try {
    return readFileSync(resolveInProject(project, sentFile(cardId)), "utf8")
  } catch {
    return null
  }
}

/** True when both texts are the same after every run of white space is one space. */
function sameText(a: string, b: string): boolean {
  const flat = (text: string): string => text.replace(/\s+/g, " ").trim()
  return flat(a) === flat(b)
}

/**
 * The lines of `from` that `against` does not have, in the order of `from`. A line is compared without the white space
 * around it, and a line that `against` has once cancels one line of `from` only.
 */
function linesWithout(from: readonly string[], against: readonly string[]): string[] {
  const counts = new Map<string, number>()
  for (const line of against) counts.set(line.trim(), (counts.get(line.trim()) ?? 0) + 1)
  return from.filter((line) => {
    const count = counts.get(line.trim()) ?? 0
    if (count > 0) counts.set(line.trim(), count - 1)
    return count === 0
  })
}

/** The lines of a text that are not blank, without trailing white space. */
function contentLines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+$/, ""))
    .filter((line) => line.trim() !== "")
}

/**
 * The note for the next ingest. With a sent text it holds the lines the user added to the card and removed from it. It
 * holds the whole card when there is no sent text, or when the lines are the same and only their order changed.
 */
function feedbackNote(project: string, page: string, cardId: string, sent: string | null, card: string): string {
  const sections: [string, string[]][] = []
  if (sent !== null) {
    const sentLines = contentLines(sent)
    const cardLines = contentLines(card)
    const added = linesWithout(cardLines, sentLines)
    const removed = linesWithout(sentLines, cardLines)
    if (added.length > 0) sections.push(["Added", added])
    if (removed.length > 0) sections.push(["Removed", removed])
  }
  if (sections.length === 0) sections.push(["Card text", [card.replace(/\s+$/, "")]])

  const title = `Feedback on ${readWikiPage(project, page)?.title ?? slugOfPath(page)}`
  return [
    "---",
    "source_kind: note",
    `title: ${JSON.stringify(title)}`,
    `heptabase_card_id: ${cardId}`,
    `wiki_page: ${JSON.stringify(page)}`,
    "---",
    "",
    `User edits in Heptabase to the mirror card of ${page}.`,
    ...sections.flatMap(([heading, lines]) => ["", `## ${heading}`, "", lines.join("\n")]),
    "",
  ].join("\n")
}

/** The answer to a question of `plan-up`: `skip` leaves the card out, `this-wiki` makes it a source of this wiki. */
function recordUpDecision(context: RecordContext): CommandResult {
  const fields = new Fields(context.event, context.project)
  const cardId = fields.id("cardId")
  const decision = context.event.decision
  const problems = fields.problems
  if (decision !== "skip" && decision !== "this-wiki") {
    problems.push('event "decision" must be "skip" or "this-wiki"')
  }
  if (problems.length > 0 || typeof decision !== "string") return fail(problems)

  context.map.up_decisions = { ...context.map.up_decisions, [cardId]: decision }
  saveCardMap(context.project, context.map)
  return { ok: true, event: "up-decision", cardId, decision }
}

/** `<stem>.md`, or `<stem>-2.md`, `<stem>-3.md`, ... for the first name that is not a file yet. */
function freeNotePath(project: string, stem: string): string {
  for (let number = 1; ; number += 1) {
    const relative = `${stem}${number === 1 ? "" : `-${number}`}.md`
    if (!existsSync(resolveInProject(project, relative))) return relative
  }
}
