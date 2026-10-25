import assert from "node:assert/strict"
import { test } from "node:test"
import { LlmWikiApiClient, type ApiProject } from "../src/api-client.js"
import {
  REVIEW_TYPES,
  addReviewTool,
  parseAddReviewArgs,
  parseResolveReviewArgs,
  resolveReviewTool,
  type ReviewToolContext,
} from "../src/review-tools.js"

const demo: ApiProject = { id: "p1", name: "Demo", path: "/tmp/demo", current: true }

interface Call {
  url: string
  method: string
  body: unknown
}

function context(fetchImpl: typeof fetch, calls: Call[] = []): ReviewToolContext {
  const recording: typeof fetch = async (url, init) => {
    calls.push({
      url: String(url),
      method: String(init?.method ?? "GET"),
      body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
    })
    return fetchImpl(url, init)
  }
  const client = new LlmWikiApiClient({ baseUrl: "http://localhost:19828", fetchImpl: recording })
  return {
    client,
    // Same order as the server: the health check, then the project lookup, then the call.
    assertMcpEnabled: async () => {
      await client.health()
    },
    resolveProjectScope: async (args) => {
      await client.projects()
      return { id: typeof args.project_id === "string" ? args.project_id : "current", project: demo }
    },
  }
}

/** The error that Node's fetch throws when nothing listens on the port. */
function connectionRefused(): TypeError {
  return new TypeError("fetch failed", { cause: Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:19828"), { code: "ECONNREFUSED" }) })
}

function route(handlers: Record<string, () => Response>): typeof fetch {
  return async (url, init) => {
    const key = `${init?.method ?? "GET"} ${new URL(String(url)).pathname}`
    const handler = handlers[key]
    if (!handler) throw new Error(`unexpected request ${key}`)
    return handler()
  }
}

const json = (value: unknown, status = 200): Response => new Response(JSON.stringify(value), { status })

const baseRoutes = {
  "GET /api/v1/health": () => json({ ok: true, status: "running", mcpEnabled: true }),
  "GET /api/v1/projects": () => json({ ok: true, projects: [demo], currentProject: demo }),
}

test("REVIEW_TYPES lists the app's review types and mirror-edited", () => {
  for (const type of ["contradiction", "duplicate", "missing-page", "confirm", "suggestion", "mirror-edited"]) {
    assert.ok((REVIEW_TYPES as readonly string[]).includes(type), type)
  }
})

test("add_review posts the item to the reviews route of the project and returns the id", async () => {
  const calls: Call[] = []
  const ctx = context(route({
    ...baseRoutes,
    "POST /api/v1/projects/%2Ftmp%2Fdemo/reviews": () => json({ ok: true, projectId: "p1", id: "review-abc12345" }),
  }), calls)

  const text = await addReviewTool(ctx, {
    project_id: "/tmp/demo",
    type: "mirror-edited",
    title: "Mirror card edited: wiki/mechanisms/attention.md",
    description: "The note is raw/sources/heptabase/attention-edit.md.",
    affectedPages: ["wiki/mechanisms/attention.md"],
  })

  const post = calls.find((call) => call.method === "POST")
  assert.equal(post?.url, "http://localhost:19828/api/v1/projects/%2Ftmp%2Fdemo/reviews")
  assert.deepEqual(post?.body, {
    type: "mirror-edited",
    title: "Mirror card edited: wiki/mechanisms/attention.md",
    description: "The note is raw/sources/heptabase/attention-edit.md.",
    affectedPages: ["wiki/mechanisms/attention.md"],
  })
  assert.match(text, /^\[activeProject: Demo \(p1\)\]/)
  assert.deepEqual(JSON.parse(text.slice(text.indexOf("{"))), { id: "review-abc12345" })
})

test("add_review sends options and search queries, and defaults the project to current", async () => {
  const calls: Call[] = []
  const ctx = context(route({
    ...baseRoutes,
    "POST /api/v1/projects/current/reviews": () => json({ ok: true, id: "review-1" }),
  }), calls)

  await addReviewTool(ctx, {
    type: "confirm",
    title: "Check this",
    description: "Look at it.",
    options: [{ label: "Open page", action: "open:wiki/a.md" }],
    searchQueries: ["attention heads"],
  })

  const post = calls.find((call) => call.method === "POST")
  assert.equal(post?.url, "http://localhost:19828/api/v1/projects/current/reviews")
  assert.deepEqual(post?.body, {
    type: "confirm",
    title: "Check this",
    description: "Look at it.",
    options: [{ label: "Open page", action: "open:wiki/a.md" }],
    searchQueries: ["attention heads"],
  })
})

test("add_review reports app offline", async () => {
  const ctx = context(async () => {
    throw connectionRefused()
  })

  await assert.rejects(
    () => addReviewTool(ctx, { type: "confirm", title: "T", description: "D" }),
    (error: Error) => {
      assert.match(error.message, /the LLM Wiki app is not running, or its local API is off/i)
      assert.match(error.message, /review item was not added/i)
      assert.match(error.message, /fetch failed, ECONNREFUSED/)
      return true
    },
  )
})

test("the offline text names the error code from either level of the cause, and works without one", async () => {
  const flat = context(async () => {
    throw Object.assign(new Error("connect failed"), { code: "ECONNREFUSED" })
  })
  await assert.rejects(() => addReviewTool(flat, { type: "confirm", title: "T", description: "D" }), /connect failed, ECONNREFUSED/)

  const plain = context(async () => {
    throw new Error("socket hang up")
  })
  await assert.rejects(
    () => addReviewTool(plain, { type: "confirm", title: "T", description: "D" }),
    (error: Error) => {
      assert.match(error.message, /\(socket hang up\)/)
      return true
    },
  )
})

test("add_review passes an API error on, and does not call it an offline app", async () => {
  const ctx = context(route({
    ...baseRoutes,
    "POST /api/v1/projects/current/reviews": () => json({ ok: false, error: "Unknown review type 'x'" }, 400),
  }))

  await assert.rejects(
    () => addReviewTool(ctx, { type: "confirm", title: "T", description: "D" }),
    (error: Error) => {
      assert.match(error.message, /LLM Wiki API 400: Unknown review type 'x'/)
      assert.doesNotMatch(error.message, /not running/)
      return true
    },
  )
})

test("add_review checks its arguments before it calls the app", async () => {
  let calls = 0
  const ctx = context(async () => {
    calls += 1
    return json({ ok: true })
  })

  await assert.rejects(() => addReviewTool(ctx, { type: "nope", title: "T", description: "D" }), /type must be one of/)
  assert.equal(calls, 0)
})

test("resolve_review patches the item and returns ok", async () => {
  const calls: Call[] = []
  const ctx = context(route({
    ...baseRoutes,
    "PATCH /api/v1/projects/current/reviews/review-abc12345": () =>
      json({ ok: true, projectId: "p1", reviewId: "review-abc12345", resolved: true }),
  }), calls)

  const text = await resolveReviewTool(ctx, { id: "review-abc12345", action: "Dismiss" })

  const patch = calls.find((call) => call.method === "PATCH")
  assert.equal(patch?.url, "http://localhost:19828/api/v1/projects/current/reviews/review-abc12345")
  assert.deepEqual(patch?.body, { resolved: true, action: "Dismiss" })
  assert.deepEqual(JSON.parse(text.slice(text.indexOf("{"))), { ok: true })
})

test("resolve_review reports an unknown id and an offline app", async () => {
  const unknown = context(route({
    ...baseRoutes,
    "PATCH /api/v1/projects/current/reviews/nope": () => json({ ok: false, error: "Review item 'nope' not found" }, 404),
  }))
  await assert.rejects(() => resolveReviewTool(unknown, { id: "nope", action: "Skip" }), /404: Review item 'nope' not found/)

  const offline = context(async () => {
    throw connectionRefused()
  })
  await assert.rejects(
    () => resolveReviewTool(offline, { id: "r1", action: "Skip" }),
    /the LLM Wiki app is not running, or its local API is off.*review item was not resolved.*ECONNREFUSED/is,
  )
})

test("parseAddReviewArgs requires type, title and description", () => {
  assert.throws(() => parseAddReviewArgs({ title: "T", description: "D" }), /type is required/)
  assert.throws(() => parseAddReviewArgs({ type: "confirm", description: "D" }), /title is required/)
  assert.throws(() => parseAddReviewArgs({ type: "confirm", title: "T" }), /description is required/)
  assert.throws(() => parseAddReviewArgs({ type: "bogus", title: "T", description: "D" }), /type must be one of: .*mirror-edited/)
})

test("parseAddReviewArgs checks options and drops non-string list entries", () => {
  assert.throws(
    () => parseAddReviewArgs({ type: "confirm", title: "T", description: "D", options: [{ label: "Only label" }] }),
    /options/,
  )
  assert.throws(
    () => parseAddReviewArgs({ type: "confirm", title: "T", description: "D", options: "Dismiss" }),
    /options must be an array/,
  )
  const parsed = parseAddReviewArgs({
    type: "confirm",
    title: "T",
    description: "D",
    affectedPages: ["wiki/a.md", 7, " "],
  })
  assert.deepEqual(parsed.affectedPages, ["wiki/a.md"])
  assert.equal(parsed.options, undefined)
})

test("parseAddReviewArgs reads only the names of the schema", () => {
  const parsed = parseAddReviewArgs({
    type: "confirm",
    title: "T",
    description: "D",
    affected_pages: ["wiki/a.md"],
    search_queries: ["q"],
  })
  assert.equal(parsed.affectedPages, undefined)
  assert.equal(parsed.searchQueries, undefined)
})

test("parseResolveReviewArgs requires id and action", () => {
  assert.deepEqual(parseResolveReviewArgs({ id: "r1", action: "Skip" }), { id: "r1", action: "Skip" })
  assert.throws(() => parseResolveReviewArgs({ action: "Skip" }), /id is required/)
  assert.throws(() => parseResolveReviewArgs({ id: "r1" }), /action is required/)
})
