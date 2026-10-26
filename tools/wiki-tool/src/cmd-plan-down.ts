/**
 * `wiki-tool hepta plan-down` - plan the changes from the wiki to Heptabase.
 *
 * Reads the wiki pages, the card map, heptabase.yaml, and wiki.yaml, and prints the
 * actions the wiki-sync skill must run. It never calls Heptabase and never writes the card map or a wiki page.
 * It writes the text each `create`, `update`, `relink`, and `retire` action sends to
 * `.llm-wiki/hepta/outbox/<sha256 of the page path>.md` and names that file as `bodyFile`: the skill sends the
 * text of the file, so the body is never typed again, and `hepta record` keeps the file as the text that was sent.
 * The skill runs each action, then tells `hepta record` what happened, so a run that
 * stops halfway is planned again from the map.
 *
 * A page whose card was created but not set up (the map says `setup_pending`: `record created` ran right after
 * `create_object`) gets a `setup` action and nothing else: tag membership and properties. The card is not in the
 * mirror tag yet, so it is not looked for in the tag list and a user edit is not checked. This is why a failure
 * after `create_object` never makes a second card.
 *
 * Pass 1 plans `create`, `update`, `retire`, and `skip-edited`. A new page links to the
 * pages that have a card already; a link to a page that gets its card in the same pass is
 * written as plain text. When no create, update, or retire is left, pass 2 plans a `relink`
 * for each page whose card was sent with such a link.
 *
 * The map keeps the hash of the card that was sent. A page is planned again when the hash of
 * its card now is another one. The hash covers the body (title, text, links, footer) and the
 * property values, but not the sync date.
 *
 * A mirror card that the user edited is never overwritten: its page gets a `skip-edited`, whether
 * the page changed or not, until `hepta record` saves the edit as feedback. The edit check needs the whole list
 * of the mirror tag, so `--mirror-cards` is required once a card is mapped, and a list that is a failed result or
 * stops before its last page is refused. A card of the map that the list does not hold (taken out of the tag, or
 * deleted) gets no action at all and a problem, so a half-read list never makes a write. Every action that writes
 * to a card names the time the card had when it was planned (`cardUpdatedAt`): the skill checks the card again right
 * before it writes. Two safety rules keep a
 * read error from looking like a deleted wiki: an unreadable `wiki/` folder stops the command, and a
 * plan that would retire most of the cards retires none. The user can confirm such a plan: with `--allow-mass-retire`
 * the retires are planned and `notes` names their count instead of a problem. `notes` is in the output only when it
 * has an entry. The skill passes the flag only after the user said yes (ruling U6).
 */
import { readFileSync } from "node:fs"
import type { HeptabaseConfig, PropertyKey } from "@/lib/wiki-config/heptabase-config"
import { UUID_PATTERN } from "@/lib/wiki-config/types"
import { isRecord } from "@/lib/wiki-config/yaml-util"
import { parseArgs, parseNowOption } from "./args"
import { type CardMap, contentHash, loadCardMap, type PageEntry } from "./card-map"
import { readDatabase } from "./cmd-init"
import { outboxFile } from "./hepta-files"
import { type CommandResult, isDirectory, resolveInProject, writeFileAtomic } from "./io"
import {
  cardHash,
  compareText,
  createRenderer,
  editsOf,
  frontmatterText,
  isSyncable,
  type MirrorRenderer,
  type PropertyEdit,
  pageProperties,
  readProjectConfig,
  readWikiPages,
  RETIRED_BODY,
  RETIRED_TITLE_PREFIX,
  slugOfPath,
  type WikiPage,
} from "./mirror-pages"
import { type CardRef, failedStatus, parseListCards, parsePagingTrailer } from "./parse-mcp"

export type { PropertyEdit }

/**
 * What the skill does for a page. `contentHash` is the hash of `body`: the skill gives it back
 * in the `created` or `updated` event, so the map keeps the hash of what was sent.
 */
export type DownAction =
  | {
      op: "setup"
      page: string
      cardId: string
      /** The title the card has now, for the skill to check. The file name of a page that is gone. */
      title: string
      /** The hash of the card as it was sent (from the map). */
      contentHash: string
      /** Empty for a page that is gone or not synced any more. */
      properties: PropertyEdit[]
    }
  | {
      op: "create"
      page: string
      title: string
      body: string
      /** The project-relative file that holds the text to send. */
      bodyFile: string
      contentHash: string
      properties: PropertyEdit[]
    }
  | {
      op: "update"
      page: string
      cardId: string
      title: string
      body: string
      bodyFile: string
      contentHash: string
      properties: PropertyEdit[]
      /** The `updatedAt` of the card in the list. Left out when the list has no times. */
      cardUpdatedAt?: string
    }
  | { op: "relink"; page: string; cardId: string; body: string; bodyFile: string; contentHash: string; cardUpdatedAt?: string }
  | {
      op: "retire"
      page: string
      cardId: string
      title: string
      /** The text after the title in the card. The file holds the title as a heading, an empty line, and this body. */
      body: string
      bodyFile: string
      contentHash: string
      properties: PropertyEdit[]
      cardUpdatedAt?: string
    }
  | { op: "skip-edited"; page: string; cardId: string; cardUpdatedAt: string }
  | { op: "place"; page: string; cardId: string; whiteboardId: string; cardUpdatedAt?: string }

/** A page that cannot be planned, and what the user must do. */
export interface PageProblem {
  page: string
  problem: string
}

const OPTION_SPEC = {
  values: ["project", "database", "now"],
  // One file for each page of the list_cards result.
  lists: ["mirror-cards"],
  // Plan the retires of a plan that the mass-retire rule would refuse.
  flags: ["allow-mass-retire"],
} as const

const NEEDS_MIRROR_LIST = "pass every page of list_cards for the mirror tag with --mirror-cards"

/**
 * A card counts as edited when it changed this long after the last write that the map recorded, when both times are
 * on the clock of Heptabase (the `card_updated_at` of the map and the `updatedAt` of the list).
 */
const EDIT_GRACE_MS = 2_000

/**
 * The same, when the map has no card time and the sync time stands in for it. That time is on the clock of this
 * machine, which can run ahead of or behind Heptabase, so the grace is wide.
 */
const EDIT_GRACE_FALLBACK_MS = 60_000

/** A plan that retires this many cards, and more than half of the active ones, is refused. */
const MASS_RETIRE_MINIMUM = 5

/** Up to this many links, every mix of resolved and unresolved links is tried. */
const MAX_ENUMERATED_LINKS = 10

const SELECT_KEYS: readonly PropertyKey[] = ["domain", "page_type", "wiki", "status", "hypothesis_status", "strength"]

/** The order of actions that are for the same page. */
const OP_ORDER: readonly DownAction["op"][] = ["setup", "create", "update", "relink", "retire", "skip-edited", "place"]

export function planDown(args: string[]): CommandResult {
  const { parsed, problems: optionProblems } = parseArgs(args, OPTION_SPEC)
  const problems = [...optionProblems]
  const project = parsed.values.project
  if (project === undefined) problems.push("missing option: --project")
  if (problems.length > 0 || project === undefined) return { ok: false, problems }
  if (!isDirectory(project)) return { ok: false, problems: [`project folder not found: ${project}`] }

  const config = readProjectConfig(project, problems)
  let map: CardMap | null = null
  try {
    map = loadCardMap(project)
  } catch (error) {
    problems.push(error instanceof Error ? error.message : String(error))
  }
  const now = parseNowOption(parsed.values.now, problems)
  const mirrorFiles = parsed.lists["mirror-cards"]
  if (map && mirrorFiles.length === 0 && Object.values(map.pages).some((entry) => entry.status === "active")) {
    problems.push(NEEDS_MIRROR_LIST)
  }
  const cards = readMirrorCards(mirrorFiles, problems)
  let options: OptionIndex | null = null
  if (parsed.values.database !== undefined) {
    const database = readDatabase(parsed.values.database, problems)
    if (database) options = indexOptions(database.schema)
  }
  if (config && options) checkConfiguredProperties(config.heptabase, options, problems)
  if (problems.length > 0 || !config || !map || !now) return { ok: false, problems }

  // A project that has no active card yet may have no wiki folder. Otherwise a missing folder is an error,
  // because every card would look like a page that was deleted.
  const hasActiveCard = Object.values(map.pages).some((entry) => entry.status === "active")
  const pages = readWikiPages(project, { allowMissingWiki: !hasActiveCard })
  const plan = planPages({
    project,
    map,
    pages,
    cards,
    listed: mirrorFiles.length > 0,
    options,
    properties: config.heptabase.properties,
    wikiId: config.wiki.id,
    syncedOn: { start: `${now.toISOString().slice(0, 10)}T00:00:00.000Z` },
    allowMassRetire: parsed.flags["allow-mass-retire"],
  })
  writeOutbox(project, plan.actions)
  return {
    ok: true,
    pass: plan.pass,
    actions: plan.actions,
    problems: plan.problems,
    ...(plan.notes.length > 0 ? { notes: plan.notes } : {}),
  }
}

/** The text a `create`, `update`, `relink`, or `retire` action sends to its card. A retire sends the title as a heading too. */
function textToSend(action: DownAction): string | null {
  if (action.op === "create" || action.op === "update" || action.op === "relink") return action.body
  return action.op === "retire" ? `# ${action.title}\n\n${action.body}` : null
}

/** Writes the text of each action that sends one to its `bodyFile`, exactly as it is (no line feed is added). */
function writeOutbox(project: string, actions: readonly DownAction[]): void {
  for (const action of actions) {
    const text = textToSend(action)
    if (text !== null && "bodyFile" in action) writeFileAtomic(resolveInProject(project, action.bodyFile), text)
  }
}

// --- inputs ------------------------------------------------------------

/**
 * The cards of the `list_cards` files, by id. A later file wins for a card that two files list. A file that is the
 * result of a failed call, and a last file that still has a next page, are refused: both read like a shorter list.
 */
function readMirrorCards(paths: readonly string[], problems: string[]): Map<string, CardRef> {
  const cards = new Map<string, CardRef>()
  let last: string | null = null
  for (const path of paths) {
    let text: string
    try {
      text = readFileSync(path, "utf8")
    } catch {
      problems.push(`cannot read --mirror-cards file: ${path}`)
      last = null
      continue
    }
    last = text
    const status = failedStatus(text)
    if (status !== null) {
      problems.push(`--mirror-cards file ${path} is the result of a call that did not succeed (status: ${status})`)
      continue
    }
    for (const card of parseListCards(text)) cards.set(card.id, card)
  }
  const trailer = last === null ? null : parsePagingTrailer(last)
  if (trailer) {
    problems.push(
      `the last --mirror-cards file has a next page (showing ${trailer.shown[0]}-${trailer.shown[1]} of ${trailer.total}); pass every page of the list`,
    )
  }
  return cards
}

interface SelectProperty {
  name: string
  options: Set<string>
}

/** The select properties of a `read_database` schema, by property id. */
type OptionIndex = Map<string, SelectProperty>

function indexOptions(schema: Record<string, unknown>): OptionIndex {
  const index: OptionIndex = new Map()
  for (const [propertyId, definition] of Object.entries(schema)) {
    if (!isRecord(definition) || definition.type !== "select") continue
    const options = Array.isArray(definition.options) ? definition.options : []
    index.set(propertyId, {
      name: typeof definition.name === "string" ? definition.name : propertyId,
      options: new Set(options.flatMap((option) => (isRecord(option) && typeof option.name === "string" ? [option.name] : []))),
    })
  }
  return index
}

/** A select property of heptabase.yaml must be in the database, or its options cannot be checked. */
function checkConfiguredProperties(config: HeptabaseConfig, options: OptionIndex, problems: string[]): void {
  for (const key of SELECT_KEYS) {
    const propertyId = config.properties[key]
    if (propertyId !== undefined && !options.has(propertyId)) {
      problems.push(`heptabase.yaml property "${key}" (${propertyId}) is not a select property of the --database file`)
    }
  }
}

// --- planning ----------------------------------------------------------

interface PlanInput {
  project: string
  map: CardMap
  pages: WikiPage[]
  /** The cards of the mirror tag, by id. Empty when the skill gave no list. */
  cards: Map<string, CardRef>
  /** True when the skill gave a list. Without one, only a map without active cards is planned. */
  listed: boolean
  /** Null when the skill gave no database. */
  options: OptionIndex | null
  properties: HeptabaseConfig["properties"]
  wikiId: string
  syncedOn: { start: string }
  /** The user confirmed a plan that retires most of the cards. */
  allowMassRetire: boolean
}

interface PagePlan {
  /** The action that changes the card. */
  main?: DownAction
  place?: DownAction
  /** What stops the plan of this page: no action is planned for it. */
  blockers: string[]
  /** Problems that stop the placement only. */
  notes: string[]
}

function planPages(input: PlanInput): { pass: 1 | 2; actions: DownAction[]; problems: PageProblem[]; notes: string[] } {
  const pageByPath = new Map(input.pages.map((page) => [page.path, page]))
  const renderer = createRenderer(input.project, input.map, input.pages)
  const paths = [...new Set([...pageByPath.keys(), ...Object.keys(input.map.pages)])].sort(compareText)

  const actions: DownAction[] = []
  const relinks: DownAction[] = []
  const problems: PageProblem[] = []
  for (const path of paths) {
    const page = pageByPath.get(path)
    const entry = input.map.pages[path]
    const plan = page ? planPage(input, renderer, page, entry) : planGone(input, path, entry)
    for (const message of [...plan.blockers, ...plan.notes]) problems.push({ page: path, problem: message })
    if (plan.blockers.length > 0) continue
    if (plan.main?.op === "relink") relinks.push(plan.main)
    else if (plan.main) actions.push(plan.main)
    if (plan.place) actions.push(plan.place)
  }

  const notes: string[] = []
  const mass = massRetire(input, actions)
  if (mass !== null) {
    if (input.allowMassRetire) {
      notes.push(`retiring ${mass.retires} of ${mass.active} mirror cards, as --allow-mass-retire says`)
    } else {
      dropRetires(actions)
      problems.push({ page: "wiki/", problem: `refusing to retire ${mass.retires} of ${mass.active} mirror cards; check the wiki folder` })
    }
  }

  // A relink waits until nothing is left to create, update, or retire: those change which pages have a card.
  const pending = actions.some((action) => action.op === "create" || action.op === "update" || action.op === "retire")
  if (!pending) actions.push(...relinks)
  actions.sort((a, b) => compareText(a.page, b.page) || OP_ORDER.indexOf(a.op) - OP_ORDER.indexOf(b.op))
  return { pass: !pending && relinks.length > 0 ? 2 : 1, actions, problems, notes }
}

/**
 * A wiki folder that cannot be read right is the likely cause of many pages that seem deleted. A plan that would retire at
 * least 5 cards and more than half of the active ones is a mass retire: the counts, or null when the plan is fine.
 */
function massRetire(input: PlanInput, actions: readonly DownAction[]): { retires: number; active: number } | null {
  const retires = actions.filter((action) => action.op === "retire").length
  const active = Object.values(input.map.pages).filter((entry) => entry.status === "active").length
  return retires < MASS_RETIRE_MINIMUM || retires * 2 <= active ? null : { retires, active }
}

/** Remove every retire from the planned actions. */
function dropRetires(actions: DownAction[]): void {
  for (let index = actions.length - 1; index >= 0; index -= 1) {
    if (actions[index].op === "retire") actions.splice(index, 1)
  }
}

/** A mapped page whose file is not there (or is not a wiki page any more). */
function planGone(input: PlanInput, path: string, entry: PageEntry | undefined): PagePlan {
  if (!entry || entry.status !== "active") return { blockers: [], notes: [] }
  if (entry.setup_pending) return planSetup(input, undefined, path, entry)
  const card = input.cards.get(entry.card_id)
  return finish(input, path, retire(input, path, entry, card?.title ?? slugOfPath(path)), undefined, [])
}

function planPage(input: PlanInput, renderer: MirrorRenderer, page: WikiPage, entry: PageEntry | undefined): PagePlan {
  const none: PagePlan = { blockers: [], notes: [] }
  if (entry?.status === "active" && entry.setup_pending) return planSetup(input, page, page.path, entry)
  if (!entry) return isSyncable(page) ? finish(input, page.path, create(input, renderer, page), undefined, []) : none
  if (entry.status === "active" && !page.hasFrontmatter) {
    // The card stays as it is: a broken page is not a reason to retire it.
    return { blockers: ["the frontmatter of this page cannot be read, so its card is left as it is"], notes: [] }
  }
  if (!isSyncable(page)) {
    return entry.status === "active" ? finish(input, page.path, retire(input, page.path, entry, page.title), undefined, []) : none
  }

  const resolved: string[] = []
  const body = renderer.render(page, new Set(), (slug) => {
    if (!resolved.includes(slug)) resolved.push(slug)
  })
  const hash = cardHash(body, pageProperties(page, input))
  let main: DownAction | undefined
  if (entry.status !== "active" || hash !== entry.content_hash) {
    const linksOnly = entry.status === "active" && onlyLinksChanged(input, renderer, page, entry.content_hash, resolved)
    main = linksOnly
      ? { op: "relink", page: page.path, cardId: entry.card_id, body, bodyFile: outboxFile(page.path), contentHash: hash }
      : {
          op: "update",
          page: page.path,
          cardId: entry.card_id,
          title: page.title,
          body,
          bodyFile: outboxFile(page.path),
          contentHash: hash,
          properties: pageProperties(page, input, input.syncedOn),
        }
  }
  const { place, notes } = entry.status === "active" ? placement(page, entry) : { place: undefined, notes: [] }
  return finish(input, page.path, main, place, notes)
}

/**
 * The only action of a page whose card waits for setup. The properties are those of a new card; a page that is gone,
 * not synced any more, or without readable frontmatter gets none, and its card is then retired in a later round.
 */
function planSetup(input: PlanInput, page: WikiPage | undefined, path: string, entry: PageEntry): PagePlan {
  const syncable = page !== undefined && page.hasFrontmatter && isSyncable(page)
  const properties = syncable ? pageProperties(page, input, input.syncedOn) : []
  const setup: DownAction = {
    op: "setup",
    page: path,
    cardId: entry.card_id,
    title: page?.title ?? slugOfPath(path),
    contentHash: entry.content_hash,
    properties,
  }
  return { main: setup, blockers: missingOptions(properties, input.options), notes: [] }
}

function create(input: PlanInput, renderer: MirrorRenderer, page: WikiPage): DownAction {
  const body = renderer.render(page)
  return {
    op: "create",
    page: page.path,
    title: page.title,
    body,
    bodyFile: outboxFile(page.path),
    contentHash: cardHash(body, pageProperties(page, input)),
    properties: pageProperties(page, input, input.syncedOn),
  }
}

function retire(input: PlanInput, path: string, entry: PageEntry, title: string): DownAction {
  const base = title.startsWith(RETIRED_TITLE_PREFIX) ? title.slice(RETIRED_TITLE_PREFIX.length) : title
  return {
    op: "retire",
    page: path,
    cardId: entry.card_id,
    title: `${RETIRED_TITLE_PREFIX}${base}`,
    body: RETIRED_BODY,
    bodyFile: outboxFile(path),
    contentHash: contentHash(RETIRED_BODY),
    properties: editsOf(input.properties, [
      ["status", "select", "retired"],
      ["last_synced", "date", input.syncedOn],
    ]),
  }
}

/**
 * Applies the checks that every plan of a page passes. The card must be in the list of the mirror tag, or the page gets
 * no action: a card that is gone from the tag is not touched. A card that the user edited is not overwritten: the page
 * gets a `skip-edited` instead of its action, or alone when it has none. And a select value must be an option of the
 * database. An action that writes to the card gets the time the card has in the list.
 */
function finish(
  input: PlanInput,
  path: string,
  main: DownAction | undefined,
  place: DownAction | undefined,
  notes: string[],
): PagePlan {
  const entry = input.map.pages[path]
  let checked = main
  let planned = place
  // The state of a retired card matters only when the page wants to write to it, and only when there is a list to look in.
  if (entry && (entry.status === "active" || (main && input.listed))) {
    const card = input.cards.get(entry.card_id)
    if (!card) {
      return { blockers: [`card ${entry.card_id} of ${path} is not in the mirror tag (removed from the tag or deleted?)`], notes: [] }
    }
    checked = editedCard(entry, path, card) ?? main
    const stamp = card.updatedAt
    if (stamp !== undefined) {
      if (checked?.op === "update" || checked?.op === "relink" || checked?.op === "retire") checked = { ...checked, cardUpdatedAt: stamp }
      if (planned?.op === "place") planned = { ...planned, cardUpdatedAt: stamp }
    }
  }
  const blockers = checked && "properties" in checked ? missingOptions(checked.properties, input.options) : []
  return { main: checked, place: planned, blockers, notes }
}

/**
 * A `skip-edited` action when the card changed more than 2 seconds after the last write that the map recorded
 * (the card time of that write, which is on the clock of Heptabase like the time in the list), and after the last
 * edit that `hepta record` saved as feedback. The sync time is on the clock of this machine and is used only when
 * the map has no card time; it gets a grace of 60 seconds, for the difference between the two clocks.
 */
function editedCard(entry: PageEntry, path: string, card: CardRef): DownAction | null {
  if (!card.updatedAt) return null
  const changed = Date.parse(card.updatedAt)
  const written = Date.parse(entry.card_updated_at ?? "")
  const baseline = Number.isNaN(written) ? Date.parse(entry.last_synced_at) : written
  const grace = Number.isNaN(written) ? EDIT_GRACE_FALLBACK_MS : EDIT_GRACE_MS
  if (Number.isNaN(changed) || Number.isNaN(baseline) || changed - baseline <= grace) return null
  const handled = entry.feedback_card_updated_at === undefined ? Number.NaN : Date.parse(entry.feedback_card_updated_at)
  if (changed <= handled) return null
  return { op: "skip-edited", page: path, cardId: entry.card_id, cardUpdatedAt: card.updatedAt }
}

// --- links -------------------------------------------------------------

/**
 * True when the hash the map keeps is the hash of this page with some of its card links written
 * as plain text: the page was sent before those pages had a card, and nothing else changed.
 */
function onlyLinksChanged(
  input: PlanInput,
  renderer: MirrorRenderer,
  page: WikiPage,
  storedHash: string,
  resolved: string[],
): boolean {
  const properties = pageProperties(page, input)
  for (const unresolved of unresolvedSets(resolved)) {
    if (cardHash(renderer.render(page, unresolved), properties) === storedHash) return true
  }
  return false
}

/** The sets of slugs that may have been plain text when the page was sent; not the empty set. */
function* unresolvedSets(slugs: readonly string[]): Generator<Set<string>> {
  if (slugs.length <= MAX_ENUMERATED_LINKS) {
    for (let mask = 1; mask < 2 ** slugs.length; mask += 1) {
      yield new Set(slugs.filter((_slug, index) => (mask >> index) & 1))
    }
    return
  }
  // Too many links to try every mix: try all of them, each one alone, and all but one.
  yield new Set(slugs)
  for (const slug of slugs) {
    yield new Set([slug])
    yield new Set(slugs.filter((other) => other !== slug))
  }
}

// --- properties --------------------------------------------------------

/** One message for each select value that is not an option of its property. Empty without a database. */
function missingOptions(properties: readonly PropertyEdit[], options: OptionIndex | null): string[] {
  if (!options) return []
  const messages: string[] = []
  for (const edit of properties) {
    const property = edit.type === "select" ? options.get(edit.propertyId) : undefined
    if (!property || property.options.has(String(edit.value))) continue
    const message = `add the option "${String(edit.value)}" to the "${property.name}" property in Heptabase`
    if (!messages.includes(message)) messages.push(message)
  }
  return messages
}

// --- placement ---------------------------------------------------------

/** A hypothesis card goes on the whiteboard its page names, once. */
function placement(page: WikiPage, entry: PageEntry): { place?: DownAction; notes: string[] } {
  if (page.type !== "hypothesis") return { notes: [] }
  const whiteboardId = frontmatterText(page, "heptabase_whiteboard")
  if (whiteboardId === null || entry.placements.includes(whiteboardId)) return { notes: [] }
  if (!UUID_PATTERN.test(whiteboardId)) {
    return { notes: [`heptabase_whiteboard is not a whiteboard id: "${whiteboardId}"`] }
  }
  return { place: { op: "place", page: page.path, cardId: entry.card_id, whiteboardId }, notes: [] }
}
