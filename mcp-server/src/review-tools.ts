/**
 * The review tools of the MCP server: `llm_wiki_add_review` and `llm_wiki_resolve_review`.
 *
 * `index.ts` lists the tools and calls these functions. Everything here works on plain arguments and a context, so the
 * tests can run a tool without a running MCP server or a running app.
 */
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js"
import {
  LlmWikiApiUnreachableError,
  type ApiAddReviewInput,
  type ApiProject,
  type ApiReviewOption,
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
] as const

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
    const { id } = await ctx.client.addReview(scope.id, input)
    return withActiveProject(JSON.stringify({ id }, null, 2), scope.project, scope.id)
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
