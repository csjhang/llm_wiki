/**
 * `wiki-tool hepta plan-down` - plan the changes from the wiki to Heptabase.
 *
 * Reads the wiki pages, the card map, heptabase.yaml, and wiki.yaml, and prints the
 * actions the wiki-sync skill must run. It changes no file and never calls Heptabase.
 * The skill runs each action, then tells `hepta record` what happened, so a run that
 * stops halfway is planned again from the map.
 *
 * Pass 1 plans `create`, `update`, `retire`, and `skip-edited`. A new page links to the
 * pages that have a card already; a link to a page that gets its card in the same pass is
 * written as plain text. When no create, update, or retire is left, pass 2 plans a `relink`
 * for each page whose card was sent with such a link.
 *
 * The map keeps the hash of the card body that was sent. A page is planned again when the
 * hash of its body now is another one. The hash covers the title, the links, and the
 * footer, as well as the text. It does not cover the property values.
 */
import { readFileSync } from "node:fs"
import { type HeptabaseConfig, parseHeptabaseYaml, type PropertyKey } from "@/lib/wiki-config/heptabase-config"
import { type ParseResult, UUID_PATTERN } from "@/lib/wiki-config/types"
import { parseWikiYaml } from "@/lib/wiki-config/wiki-identity"
import { isRecord } from "@/lib/wiki-config/yaml-util"
import { parseArgs, parseNowOption } from "./args"
import { type CardMap, contentHash, loadCardMap, type PageEntry } from "./card-map"
import { readDatabase } from "./cmd-init"
import { type CommandResult, isDirectory, resolveInProject } from "./io"
import {
  compareText,
  createRenderer,
  isSyncable,
  type MirrorRenderer,
  readWikiPages,
  RETIRED_BODY,
  RETIRED_TITLE_PREFIX,
  slugOfPath,
  type WikiPage,
} from "./mirror-pages"
import { type CardRef, parseListCards } from "./parse-mcp"

export interface PropertyEdit {
  propertyId: string
  type: "select" | "text" | "date"
  /** A select value is the option name, a text value a string, a date value `{ start: <ISO time> }`. */
  value: unknown
}

/**
 * What the skill does for a page. `contentHash` is the hash of `body`: the skill gives it back
 * in the `created` or `updated` event, so the map keeps the hash of what was sent.
 */
export type DownAction =
  | { op: "create"; page: string; title: string; body: string; contentHash: string; properties: PropertyEdit[] }
  | {
      op: "update"
      page: string
      cardId: string
      title: string
      body: string
      contentHash: string
      properties: PropertyEdit[]
    }
  | { op: "relink"; page: string; cardId: string; body: string; contentHash: string }
  | {
      op: "retire"
      page: string
      cardId: string
      title: string
      body: string
      contentHash: string
      properties: PropertyEdit[]
    }
  | { op: "skip-edited"; page: string; cardId: string; cardUpdatedAt: string }
  | { op: "place"; page: string; cardId: string; whiteboardId: string }

/** A page that cannot be planned, and what the user must do. */
export interface PageProblem {
  page: string
  problem: string
}

const OPTION_SPEC = {
  values: ["project", "database", "now"],
  // One file for each page of the list_cards result.
  lists: ["mirror-cards"],
} as const

/** A card counts as edited when it changed this long after the last sync. */
const EDIT_GRACE_MS = 60_000

/** Up to this many links, every mix of resolved and unresolved links is tried. */
const MAX_ENUMERATED_LINKS = 10

const SELECT_KEYS: readonly PropertyKey[] = ["domain", "page_type", "wiki", "status", "hypothesis_status", "strength"]

/** The order of actions that are for the same page. */
const OP_ORDER: readonly DownAction["op"][] = ["create", "update", "relink", "retire", "skip-edited", "place"]

export function planDown(args: string[]): CommandResult {
  const { parsed, problems: optionProblems } = parseArgs(args, OPTION_SPEC)
  const problems = [...optionProblems]
  const project = parsed.values.project
  if (project === undefined) problems.push("missing option: --project")
  if (problems.length > 0 || project === undefined) return { ok: false, problems }
  if (!isDirectory(project)) return { ok: false, problems: [`project folder not found: ${project}`] }

  const heptabase = readConfig(project, "heptabase.yaml", parseHeptabaseYaml, problems)
  const wiki = readConfig(project, "wiki.yaml", parseWikiYaml, problems)
  let map: CardMap | null = null
  try {
    map = loadCardMap(project)
  } catch (error) {
    problems.push(error instanceof Error ? error.message : String(error))
  }
  const now = parseNowOption(parsed.values.now, problems)
  const cards = readMirrorCards(parsed.lists["mirror-cards"], problems)
  let options: OptionIndex | null = null
  if (parsed.values.database !== undefined) {
    const database = readDatabase(parsed.values.database, problems)
    if (database) options = indexOptions(database.schema)
  }
  if (heptabase && options) checkConfiguredProperties(heptabase, options, problems)
  if (problems.length > 0 || !heptabase || !wiki || !map || !now) return { ok: false, problems }

  const pages = readWikiPages(project)
  const plan = planPages({
    project,
    map,
    pages,
    cards,
    options,
    properties: heptabase.properties,
    wikiId: wiki.id,
    syncedOn: { start: `${now.toISOString().slice(0, 10)}T00:00:00.000Z` },
  })
  return { ok: true, pass: plan.pass, actions: plan.actions, problems: plan.problems }
}

// --- inputs ------------------------------------------------------------

/** Read and parse a config file of the project. Every issue of the parser becomes a problem. */
function readConfig<T>(
  project: string,
  name: string,
  parse: (text: string) => ParseResult<T>,
  problems: string[],
): T | null {
  const path = resolveInProject(project, name)
  let text: string
  try {
    text = readFileSync(path, "utf8").replace(/^\uFEFF/, "")
  } catch {
    problems.push(`cannot read ${name}: ${path}`)
    return null
  }
  const result = parse(text)
  if (result.ok) return result.value
  for (const issue of result.issues) {
    problems.push(`invalid ${name}: ${issue.path === "" ? "" : `${issue.path}: `}${issue.message}`)
  }
  return null
}

/** The cards of the `list_cards` files, by id. A later file wins for a card that two files list. */
function readMirrorCards(paths: readonly string[], problems: string[]): Map<string, CardRef> {
  const cards = new Map<string, CardRef>()
  for (const path of paths) {
    let text: string
    try {
      text = readFileSync(path, "utf8")
    } catch {
      problems.push(`cannot read --mirror-cards file: ${path}`)
      continue
    }
    for (const card of parseListCards(text)) cards.set(card.id, card)
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
  /** Null when the skill gave no database. */
  options: OptionIndex | null
  properties: HeptabaseConfig["properties"]
  wikiId: string
  syncedOn: { start: string }
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

function planPages(input: PlanInput): { pass: 1 | 2; actions: DownAction[]; problems: PageProblem[] } {
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

  // A relink waits until nothing is left to create, update, or retire: those change which pages have a card.
  const pending = actions.some((action) => action.op === "create" || action.op === "update" || action.op === "retire")
  if (!pending) actions.push(...relinks)
  actions.sort((a, b) => compareText(a.page, b.page) || OP_ORDER.indexOf(a.op) - OP_ORDER.indexOf(b.op))
  return { pass: !pending && relinks.length > 0 ? 2 : 1, actions, problems }
}

/** A mapped page whose file is not there (or is not a wiki page any more). */
function planGone(input: PlanInput, path: string, entry: PageEntry | undefined): PagePlan {
  if (!entry || entry.status !== "active") return { blockers: [], notes: [] }
  const card = input.cards.get(entry.card_id)
  return finish(input, retire(input, path, entry, card?.title ?? slugOfPath(path)), undefined, [])
}

function planPage(input: PlanInput, renderer: MirrorRenderer, page: WikiPage, entry: PageEntry | undefined): PagePlan {
  const none: PagePlan = { blockers: [], notes: [] }
  if (!entry) return isSyncable(page) ? finish(input, create(input, renderer, page), undefined, []) : none
  if (entry.status === "active" && !page.hasFrontmatter) {
    // The card stays as it is: a broken page is not a reason to retire it.
    return { blockers: ["the frontmatter of this page cannot be read, so its card is left as it is"], notes: [] }
  }
  if (!isSyncable(page)) {
    return entry.status === "active" ? finish(input, retire(input, page.path, entry, page.title), undefined, []) : none
  }

  const resolved: string[] = []
  const body = renderer.render(page, new Set(), (slug) => {
    if (!resolved.includes(slug)) resolved.push(slug)
  })
  const hash = contentHash(body)
  let main: DownAction | undefined
  if (entry.status !== "active" || hash !== entry.content_hash) {
    const linksOnly = entry.status === "active" && onlyLinksChanged(renderer, page, entry.content_hash, resolved)
    main = linksOnly
      ? { op: "relink", page: page.path, cardId: entry.card_id, body, contentHash: hash }
      : {
          op: "update",
          page: page.path,
          cardId: entry.card_id,
          title: page.title,
          body,
          contentHash: hash,
          properties: pageProperties(input, page),
        }
  }
  const { place, notes } = entry.status === "active" ? placement(page, entry) : { place: undefined, notes: [] }
  return finish(input, main, place, notes)
}

function create(input: PlanInput, renderer: MirrorRenderer, page: WikiPage): DownAction {
  const body = renderer.render(page)
  return {
    op: "create",
    page: page.path,
    title: page.title,
    body,
    contentHash: contentHash(body),
    properties: pageProperties(input, page),
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
    contentHash: contentHash(RETIRED_BODY),
    properties: editsOf(input.properties, [
      ["status", "select", "retired"],
      ["last_synced", "date", input.syncedOn],
    ]),
  }
}

/**
 * Applies the two checks that every plan of a page passes: a card that the user edited is not
 * overwritten, and a select value must be an option of the database.
 */
function finish(input: PlanInput, main: DownAction | undefined, place: DownAction | undefined, notes: string[]): PagePlan {
  let checked = main
  if (main && (main.op === "update" || main.op === "relink" || main.op === "retire")) {
    const edited = editedCard(input, main.cardId, main.page)
    if (edited) checked = edited
  }
  const blockers = checked && "properties" in checked ? missingOptions(checked.properties, input.options) : []
  return { main: checked, place, blockers, notes }
}

/** A `skip-edited` action when the card changed after the last sync of the page. */
function editedCard(input: PlanInput, cardId: string, path: string): DownAction | null {
  const entry = input.map.pages[path]
  const card = input.cards.get(cardId)
  if (!entry || !card?.updatedAt) return null
  const changed = Date.parse(card.updatedAt)
  const synced = Date.parse(entry.last_synced_at)
  if (Number.isNaN(changed) || Number.isNaN(synced) || changed - synced <= EDIT_GRACE_MS) return null
  return { op: "skip-edited", page: path, cardId, cardUpdatedAt: card.updatedAt }
}

// --- links -------------------------------------------------------------

/**
 * True when the hash the map keeps is the hash of this page with some of its card links written
 * as plain text: the page was sent before those pages had a card, and nothing else changed.
 */
function onlyLinksChanged(renderer: MirrorRenderer, page: WikiPage, storedHash: string, resolved: string[]): boolean {
  for (const unresolved of unresolvedSets(resolved)) {
    if (contentHash(renderer.render(page, unresolved)) === storedHash) return true
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

type EditEntry = readonly [PropertyKey, PropertyEdit["type"], unknown]

/** The edits of the properties that heptabase.yaml names, for the values that are not null. */
function editsOf(ids: HeptabaseConfig["properties"], entries: readonly EditEntry[]): PropertyEdit[] {
  const edits: PropertyEdit[] = []
  for (const [key, type, value] of entries) {
    const propertyId = ids[key]
    if (propertyId !== undefined && value !== null) edits.push({ propertyId, type, value })
  }
  return edits
}

function frontmatterText(page: WikiPage, key: string): string | null {
  const value = page.frontmatter[key]
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null
}

/** The properties of an active card: domain (not for a mechanism), page type, wiki, status, page path, sync date. */
function pageProperties(input: PlanInput, page: WikiPage): PropertyEdit[] {
  const domain =
    page.type === "mechanism" ? null : frontmatterText(page, page.type === "hypothesis" ? "to_domain" : "domain")
  const entries: EditEntry[] = [
    ["domain", "select", domain],
    ["page_type", "select", page.type],
    ["wiki", "select", input.wikiId],
    ["status", "select", "active"],
    ["wiki_page", "text", page.path],
    ["last_synced", "date", input.syncedOn],
  ]
  if (page.type === "hypothesis") {
    entries.push(["hypothesis_status", "select", frontmatterText(page, "status")])
    entries.push(["strength", "select", frontmatterText(page, "strength")])
  }
  return editsOf(input.properties, entries)
}

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
