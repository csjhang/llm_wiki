/**
 * The review tools of the MCP server: `llm_wiki_reviews`, `llm_wiki_add_review`, and `llm_wiki_resolve_review`.
 *
 * `index.ts` lists the tools and calls these functions. Everything here works on plain arguments and a context, so the
 * tests can run a tool without a running MCP server or a running app.
 */
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js"
import {
  LlmWikiApiError,
  LlmWikiApiUnreachableError,
  type ApiAddReviewInput,
  type ApiProject,
  type ApiReviewItem,
  type ApiReviewOption,
  type ApiReviewStatus,
  type ApiReviewsResponse,
  type LlmWikiApiClient,
} from "./api-client.js"
import { withActiveProject } from "./project-binding.js"

/**
 * The review types that the app accepts. The list must equal the one in `REVIEW_TYPES` of
 * `src-tauri/src/api_server.rs` and the union in `src/stores/review-store.ts`
 * (`src/lib/review-types-parity.test.ts` checks it).
 */
export const REVIEW_TYPES = [
  "contradiction",
  "duplicate",
  "missing-page",
  "confirm",
  "suggestion",
  "new-domain",
  "new-mechanism",
  "duplicate-source",
  "research-result",
  "mirror-edited",
  "fusion-candidate",
] as const

/**
 * The words that `actionIsDismissal` in `src/components/review/review-view.tsx` accepts as a plain dismissal. The same
 * list is in `DISMISSAL_ACTION_WORDS` of `src-tauri/src/api_server.rs` and in `src/lib/review-option-actions.ts`
 * (`src/lib/review-option-actions.test.ts` checks it).
 */
export const DISMISSAL_ACTION_WORDS = ["skip", "dismiss", "ignore", "跳过", "忽略", "approve", "keep existing", "no"] as const

/** The `mech:` actions that an option may have. The other `mech:` actions write files, so the app refuses them. */
export const MECHANISM_ACTIONS = ["mech:propose-mechanism", "mech:start-fusion", "mech:dismiss-fusion"] as const

const OPEN_ACTION_PREFIX = "open:"

/** What an option `action` may be, as text for a tool description and for an error. */
export const ADD_REVIEW_ACTION_HELP =
  "What the button does. It must be a dismissal word (skip, dismiss, ignore, approve, keep existing, no, 跳过, 忽略), " +
  "mech:propose-mechanism, mech:start-fusion, mech:dismiss-fusion, or open:wiki/<path> (a path in wiki/ with no .. " +
  "segment). The app refuses every other action, because the Review tab runs it with the rights of the app."

/** A project-relative path in `wiki/`. The prefix rule also keeps out a leading `/` and a drive letter. */
function openPathAllowed(path: string): boolean {
  if (!path.startsWith("wiki/")) return false
  return path.length > "wiki/".length && !path.includes("\\") && !path.split("/").includes("..")
}

/**
 * Ruling S17: true when the app takes the action on an item that comes through the API. The rule is the one of
 * `review_action_allowed` in `src-tauri/src/api_server.rs`.
 */
export function isAllowedReviewAction(action: string): boolean {
  const trimmed = action.trim()
  if ((DISMISSAL_ACTION_WORDS as readonly string[]).includes(trimmed.toLowerCase())) return true
  if ((MECHANISM_ACTIONS as readonly string[]).includes(trimmed)) return true
  return trimmed.startsWith(OPEN_ACTION_PREFIX) && openPathAllowed(trimmed.slice(OPEN_ACTION_PREFIX.length))
}

/** What a tool needs from `index.ts`. */
export interface ReviewToolContext {
  client: LlmWikiApiClient
  /** Throws when the user turned MCP access off in the app. */
  assertMcpEnabled(): Promise<void>
  resolveProjectScope(args: Record<string, unknown>): Promise<{ id: string; project: ApiProject | null }>
}

function invalid(message: string): McpError {
  return new McpError(ErrorCode.InvalidParams, message)
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim() === "") throw invalid(`${name} is required`)
  return value
}

/** The strings of a list argument. A missing or empty list gives undefined. */
function stringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const strings = value
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "")
  return strings.length > 0 ? strings : undefined
}

function parseOptions(value: unknown): ApiReviewOption[] | undefined {
  if (value === undefined || value === null) return undefined
  if (!Array.isArray(value)) throw invalid("options must be an array of { label, action }")
  return value.map((entry, index) => {
    const option = entry && typeof entry === "object" && !Array.isArray(entry) ? entry as Record<string, unknown> : {}
    const label = typeof option.label === "string" ? option.label.trim() : ""
    const action = typeof option.action === "string" ? option.action.trim() : ""
    if (!label || !action) throw invalid(`options[${index}] needs a non-empty label and action`)
    if (!isAllowedReviewAction(action)) {
      throw invalid(`options[${index}].action '${action}' is not allowed. ${ADD_REVIEW_ACTION_HELP}`)
    }
    return { label, action }
  })
}

/** Check the arguments of `llm_wiki_add_review`. The result is the body of the request to the app. */
export function parseAddReviewArgs(args: Record<string, unknown>): ApiAddReviewInput {
  const type = requiredString(args.type, "type")
  if (!(REVIEW_TYPES as readonly string[]).includes(type)) {
    throw invalid(`type must be one of: ${REVIEW_TYPES.join(", ")}`)
  }
  const input: ApiAddReviewInput = {
    type,
    title: requiredString(args.title, "title").trim(),
    description: requiredString(args.description, "description"),
  }
  const options = parseOptions(args.options)
  if (options && options.length > 0) input.options = options
  const affectedPages = stringList(args.affectedPages)
  if (affectedPages) input.affectedPages = affectedPages
  const searchQueries = stringList(args.searchQueries)
  if (searchQueries) input.searchQueries = searchQueries
  return input
}

/** Check the arguments of `llm_wiki_resolve_review`. */
export function parseResolveReviewArgs(args: Record<string, unknown>): { id: string; action: string } {
  return {
    id: requiredString(args.id, "id"),
    action: requiredString(args.action, "action"),
  }
}

/** The `code` of an error, for example ECONNREFUSED. Node's fetch puts it one level down, in `cause`. */
function errorCode(error: unknown): string | undefined {
  for (const level of [error, (error as { cause?: unknown } | null | undefined)?.cause]) {
    const code = (level as { code?: unknown } | null | undefined)?.code
    if (typeof code === "string" && code !== "") return code
  }
  return undefined
}

/** What went wrong in a failed fetch: its message, and the error code when there is one. */
function unreachableDetail(error: LlmWikiApiUnreachableError): string {
  const message = error.cause instanceof Error ? error.cause.message : String(error.cause)
  const code = errorCode(error.cause)
  return code && !message.includes(code) ? `${message}, ${code}` : message
}

/**
 * Run `run`. When the app cannot be reached, throw an error that says so, and what did not happen.
 * An error that the app itself answered with (a 400, a 404) is not changed.
 */
async function whenAppRuns<T>(notDone: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run()
  } catch (error) {
    if (error instanceof LlmWikiApiUnreachableError) {
      throw new Error(
        `The LLM Wiki app is not running, or its local API is off, so the ${notDone}. ` +
        `Start the desktop app, check that its API is on, then call the tool again. (${unreachableDetail(error)})`,
        { cause: error },
      )
    }
    throw error
  }
}

/** `llm_wiki_add_review`: add one item to the Review tab. The answer is `{ id }`. */
export async function addReviewTool(ctx: ReviewToolContext, args: Record<string, unknown>): Promise<string> {
  const input = parseAddReviewArgs(args)
  return whenAppRuns("review item was not added", async () => {
    await ctx.assertMcpEnabled()
    const scope = await ctx.resolveProjectScope(args)
    let added: { id: string }
    try {
      added = await ctx.client.addReview(scope.id, input)
    } catch (error) {
      // The add route always checks the token, also when the app allows unauthenticated API access.
      if (error instanceof LlmWikiApiError && error.status === 401) {
        throw new Error(
          `${error.message}. Adding a review item needs LLM_WIKI_API_TOKEN, even when the app allows unauthenticated API access. ` +
          "Set LLM_WIKI_API_TOKEN in the env of this MCP server to the token of Settings > API + MCP, then call the tool again.",
          { cause: error },
        )
      }
      throw error
    }
    return withActiveProject(JSON.stringify({ id: added.id }, null, 2), scope.project, scope.id)
  })
}

/** `llm_wiki_resolve_review`: mark one item as resolved, with the label that the card shows. The answer is `{ ok }`. */
export async function resolveReviewTool(ctx: ReviewToolContext, args: Record<string, unknown>): Promise<string> {
  const { id, action } = parseResolveReviewArgs(args)
  return whenAppRuns("review item was not resolved", async () => {
    await ctx.assertMcpEnabled()
    const scope = await ctx.resolveProjectScope(args)
    const { ok } = await ctx.client.resolveReview(scope.id, id, action)
    return withActiveProject(JSON.stringify({ ok }, null, 2), scope.project, scope.id)
  })
}

const REVIEW_STATUSES: readonly ApiReviewStatus[] = ["unresolved", "resolved", "all"]

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined
}

/** Check the arguments of `llm_wiki_reviews`. A value of the wrong kind is left out. */
export function parseReviewsArgs(args: Record<string, unknown>): {
  status: ApiReviewStatus
  type?: string
  id?: string
  titlePrefix?: string
  limit?: number
} {
  const status = REVIEW_STATUSES.find((candidate) => candidate === args.status) ?? "unresolved"
  return {
    status,
    type: optionalString(args.type),
    id: optionalString(args.id)?.trim(),
    // Not trimmed: the prefix of a title can end in a space, like "Verify (slug): ".
    titlePrefix: optionalString(args.title_prefix),
    limit: typeof args.limit === "number" && Number.isFinite(args.limit) ? args.limit : undefined,
  }
}

/**
 * `llm_wiki_reviews`: list Review items. The app lists the oldest item first and cuts the list at `limit`. `id` and
 * `title_prefix` pick items before the cut, so they find a new item in a long list.
 */
export async function reviewsTool(ctx: ReviewToolContext, args: Record<string, unknown>): Promise<string> {
  const query = parseReviewsArgs(args)
  await ctx.assertMcpEnabled()
  const scope = await ctx.resolveProjectScope(args)
  const reviews = await ctx.client.reviews(scope.id, query)
  return withActiveProject(formatReviews(reviews), scope.project, scope.id)
}

export function formatReviews(response: ApiReviewsResponse): string {
  const { reviews } = response
  if (reviews.length === 0) return `No ${response.status} review items found.`
  const lines = [
    "# Review items",
    "",
    `Status: ${response.status}`,
    `Count: ${response.count}`,
    "",
  ]
  reviews.forEach((review, index) => {
    lines.push(`## ${index + 1}. ${review.title || review.id}`)
    lines.push(`ID: ${review.id}`)
    lines.push(`Type: ${review.type}`)
    lines.push(`Resolved: ${review.resolved ? "yes" : "no"}`)
    if (review.sourcePath) lines.push(`Source: ${review.sourcePath}`)
    if (review.affectedPages && review.affectedPages.length > 0) {
      lines.push(`Affected pages: ${review.affectedPages.join(", ")}`)
    }
    if (review.searchQueries && review.searchQueries.length > 0) {
      lines.push(`Search queries: ${review.searchQueries.join(", ")}`)
    }
    if (review.description) lines.push(`Description: ${review.description}`)
    const optionSummary = formatReviewOptions(review)
    if (optionSummary) lines.push(`Options: ${optionSummary}`)
    lines.push("")
  })
  return lines.join("\n")
}

function formatReviewOptions(review: ApiReviewItem): string {
  if (!review.options || review.options.length === 0) return ""
  return review.options
    .map((option) => option.label ? `${option.label} (${option.action})` : option.action)
    .join(", ")
}
