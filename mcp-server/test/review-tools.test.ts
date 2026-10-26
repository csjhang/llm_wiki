import assert from "node:assert/strict"
import { test } from "node:test"
import { LlmWikiApiClient, type ApiProject } from "../src/api-client.js"
import {
  ADD_REVIEW_ACTION_HELP,
  REVIEW_TYPES,
  addReviewTool,
  isAllowedReviewAction,
  parseAddReviewArgs,
  parseResolveReviewArgs,
  resolveReviewTool,
  reviewsTool,
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

// ---- ruling S17: an API review item carries only safe option actions ----

const DANGEROUS_ACTIONS = [
  "delete:/home/user",
  "delete:wiki/a.md",
  "save:SGVsbG8=",
  "__deep_research__",
  "__create_page__:Attention",
  "mech:replace-source",
  "mech:approve-domain",
  "mech:accept-research",
  "Create page X",
  "research attention",
  "open",
  "view page",
]

test("parseAddReviewArgs refuses an option action that is not allowed, and names it", () => {
  for (const action of DANGEROUS_ACTIONS) {
    assert.throws(
      () => parseAddReviewArgs({ type: "confirm", title: "T", description: "D", options: [{ label: "Dismiss", action }] }),
      (error: Error) => {
        assert.ok(error.message.includes("options[0]"), error.message)
        assert.ok(error.message.includes(`'${action}'`), error.message)
        assert.match(error.message, /mech:start-fusion/)
        assert.match(error.message, /open:wiki\//)
        return true
      },
      action,
    )
  }
})

test("parseAddReviewArgs checks every option, not only the first", () => {
  assert.throws(
    () => parseAddReviewArgs({
      type: "confirm",
      title: "T",
      description: "D",
      options: [{ label: "Skip", action: "Skip" }, { label: "Dismiss", action: "delete:/home/user" }],
    }),
    /options\[1\].*'delete:\/home\/user'/,
  )
})

test("parseAddReviewArgs accepts the dismissal words, the three mech actions, and open:wiki paths", () => {
  const allowed = [
    "skip", "Skip", "DISMISS", "Ignore", "跳过", "忽略", "approve", "Keep existing", "No",
    "mech:propose-mechanism", "mech:start-fusion", "mech:dismiss-fusion",
    "open:wiki/mechanisms/attention.md", "open:wiki/a b/c.md",
  ]
  for (const action of allowed) {
    const parsed = parseAddReviewArgs({ type: "confirm", title: "T", description: "D", options: [{ label: "Button", action }] })
    assert.deepEqual(parsed.options, [{ label: "Button", action }], action)
    assert.equal(isAllowedReviewAction(action), true, action)
  }
})

test("an open: action must name a path inside wiki/", () => {
  for (const action of [
    "open:../x", "open:/etc/x", "open:raw/x", "open:wiki/../raw/x", "open:wiki/..", "open:wiki\\a.md",
    "open:C:/x", "open:C:\\x", "open:", "open:wiki/", "open:Wiki/a.md",
  ]) {
    assert.equal(isAllowedReviewAction(action), false, action)
    assert.throws(
      () => parseAddReviewArgs({ type: "confirm", title: "T", description: "D", options: [{ label: "Open", action }] }),
      /is not allowed/,
      action,
    )
  }
})

test("add_review refuses a dangerous action before any call to the app", async () => {
  let calls = 0
  const ctx = context(async () => {
    calls += 1
    return json({ ok: true })
  })
  await assert.rejects(
    () => addReviewTool(ctx, {
      type: "confirm",
      title: "T",
      description: "D",
      options: [{ label: "Dismiss", action: "delete:/home/user" }],
    }),
    /'delete:\/home\/user' is not allowed/,
  )
  assert.equal(calls, 0)
})

test("the tool description lists what an option action may be", () => {
  for (const word of ["skip", "dismiss", "mech:propose-mechanism", "mech:start-fusion", "mech:dismiss-fusion", "open:wiki/<path>"]) {
    assert.ok(ADD_REVIEW_ACTION_HELP.includes(word), word)
  }
  assert.doesNotMatch(ADD_REVIEW_ACTION_HELP, /Action id that the Review tab runs/)
})

// ---- M2: the add route needs the token in every mode ----

test("add_review maps a 401 to a hint about LLM_WIKI_API_TOKEN", async () => {
  const ctx = context(route({
    ...baseRoutes,
    "POST /api/v1/projects/current/reviews": () => json({ ok: false, error: "Unauthorized" }, 401),
  }))
  await assert.rejects(
    () => addReviewTool(ctx, { type: "confirm", title: "T", description: "D" }),
    (error: Error) => {
      assert.match(error.message, /LLM Wiki API 401: Unauthorized/)
      assert.match(error.message, /LLM_WIKI_API_TOKEN/)
      assert.match(error.message, /even when the app allows unauthenticated/)
      return true
    },
  )
})

test("a 401 from another tool is not changed", async () => {
  const ctx = context(route({
    ...baseRoutes,
    "PATCH /api/v1/projects/current/reviews/r1": () => json({ ok: false, error: "Unauthorized" }, 401),
  }))
  await assert.rejects(
    () => resolveReviewTool(ctx, { id: "r1", action: "Skip" }),
    (error: Error) => {
      assert.match(error.message, /LLM Wiki API 401: Unauthorized/)
      assert.doesNotMatch(error.message, /LLM_WIKI_API_TOKEN/)
      return true
    },
  )
})

// ---- ruling S18: look an item up by id or by title prefix ----

test("llm_wiki_reviews passes id and title_prefix on to the reviews route", async () => {
  const calls: Call[] = []
  const ctx = context(route({
    ...baseRoutes,
    "GET /api/v1/projects/current/reviews": () => json({
      ok: true,
      status: "all",
      count: 1,
      reviews: [{ id: "review-1", type: "suggestion", title: "Verify (a): claim", description: "d", options: [], resolved: false }],
    }),
  }), calls)

  const text = await reviewsTool(ctx, { status: "all", type: "suggestion", id: "review-1", title_prefix: "Verify (a): ", limit: 1000 })

  const get = calls.find((call) => call.url.includes("/reviews"))
  const params = new URL(get?.url ?? "").searchParams
  assert.equal(params.get("id"), "review-1")
  assert.equal(params.get("title_prefix"), "Verify (a): ")
  assert.equal(params.get("status"), "all")
  assert.equal(params.get("type"), "suggestion")
  assert.equal(params.get("limit"), "1000")
  assert.match(text, /^\[activeProject: Demo \(p1\)\]/)
  assert.match(text, /ID: review-1/)
  assert.match(text, /Count: 1/)
})

test("llm_wiki_reviews leaves id and title_prefix out when they are empty or not strings", async () => {
  const calls: Call[] = []
  const ctx = context(route({
    ...baseRoutes,
    "GET /api/v1/projects/current/reviews": () => json({ ok: true, status: "unresolved", count: 0, reviews: [] }),
  }), calls)
  const text = await reviewsTool(ctx, { id: " ", title_prefix: 7 })
  const params = new URL(calls.find((call) => call.url.includes("/reviews"))?.url ?? "").searchParams
  assert.equal(params.has("id"), false)
  assert.equal(params.has("title_prefix"), false)
  assert.match(text, /No unresolved review items found\./)
})

// ---- final review, M6: say who closed a resolved item ----

test("llm_wiki_reviews prints the resolved action of a resolved item", async () => {
  const ctx = context(route({
    ...baseRoutes,
    "GET /api/v1/projects/current/reviews": () => json({
      ok: true,
      status: "all",
      count: 3,
      reviews: [
        { id: "r1", type: "suggestion", title: "Lint (a): one", description: "d", options: [], resolved: true, resolvedAction: "llm-judged" },
        { id: "r2", type: "suggestion", title: "Lint (a): two", description: "d", options: [], resolved: true, resolvedAction: "Dismiss" },
        { id: "r3", type: "suggestion", title: "Lint (a): three", description: "d", options: [], resolved: false },
      ],
    }),
  }))
  const text = await reviewsTool(ctx, { status: "all" })
  assert.match(text, /ID: r1\nType: suggestion\nResolved: yes\nResolved action: llm-judged\n/)
  assert.match(text, /ID: r2\nType: suggestion\nResolved: yes\nResolved action: Dismiss\n/)
})

test("llm_wiki_reviews prints no resolved action for an open item, and none that the app did not send", async () => {
  const ctx = context(route({
    ...baseRoutes,
    "GET /api/v1/projects/current/reviews": () => json({
      ok: true,
      status: "all",
      count: 2,
      reviews: [
        // An open item has no action, also when the app sends a stale one.
        { id: "r1", type: "suggestion", title: "Open", description: "d", options: [], resolved: false, resolvedAction: "Dismiss" },
        { id: "r2", type: "suggestion", title: "Closed", description: "d", options: [], resolved: true },
      ],
    }),
  }))
  const text = await reviewsTool(ctx, { status: "all" })
  assert.match(text, /ID: r1\nType: suggestion\nResolved: no\n/)
  assert.doesNotMatch(text, /Resolved action:/)
})
