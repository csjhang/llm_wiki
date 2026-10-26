# LLM Wiki MCP Server

This package exposes the running LLM Wiki desktop app as a Model Context Protocol server.

It does **not** scan project folders directly and does **not** copy the app's search or graph logic. Every tool calls the local desktop API at `http://127.0.0.1:19828/api/v1`, so MCP clients use the same project registry, file permissions, search backend, graph backend, and Source Watch rules as the app.

## Requirements

- Node.js 20+
- LLM Wiki desktop app running
- Settings → API + MCP → "Enable local HTTP API"
- Settings → API + MCP → "Enable MCP access"
- Either:
  - Settings → API + MCP → "Allow access without a token", or
  - `LLM_WIKI_API_TOKEN` set to the configured API token

Optional:

- `LLM_WIKI_API_BASE_URL` to override the default API base URL.

## Build

```bash
cd mcp-server
npm install
npm run build
```

## Run

```bash
LLM_WIKI_API_TOKEN=your-token node dist/src/index.js
```

Example MCP client config:

```json
{
  "mcpServers": {
    "llm-wiki": {
      "command": "node",
      "args": ["/absolute/path/to/llm_wiki/mcp-server/dist/src/index.js"],
      "env": {
        "LLM_WIKI_API_TOKEN": "your-token"
      }
    }
  }
}
```

When API unauthenticated mode is enabled, you can omit `LLM_WIKI_API_TOKEN` for the read tools. `llm_wiki_add_review` always needs `LLM_WIKI_API_TOKEN`, even in unauthenticated mode. Without it the tool fails with `LLM Wiki API 401: Unauthorized` and a hint to set the token. If MCP access is disabled in Settings, `llm_wiki_status` still works for diagnosis but other tools return an explicit disabled error.

## Tools

- `llm_wiki_status`: health and current project summary.
- `llm_wiki_projects`: known projects and active project.
- `llm_wiki_set_project`: pin the MCP process session to a project. Once pinned, other project tools reject attempts to access a different project.
- `llm_wiki_files`: list project files. `project_id` can be a project UUID, a project filesystem path, or `current`.
- `llm_wiki_read_file`: read an allowed text file such as `wiki/index.md`.
- `llm_wiki_reviews`: list Review tab items. Defaults to unresolved items and supports `status`, `type`, `id`, `title_prefix`, and `limit` filters. The list is oldest first and ends at `limit` (default 200, at most 1000). `id` and `title_prefix` pick items before the list is cut, so use them to find one item. `title_prefix` is case-sensitive and a space at its end counts.
- `llm_wiki_add_review`: add one item to the Review tab (`type`, `title`, `description`, optional `options`, `affectedPages`, `searchQueries`). `type` is one of the review types of the app, which include `mirror-edited` and `fusion-candidate`. The `action` of an option must be a dismissal word (`skip`, `dismiss`, `ignore`, `approve`, `keep existing`, `no`), `mech:propose-mechanism`, `mech:start-fusion`, `mech:dismiss-fusion`, `mech:discard-mirror-edit`, or `open:wiki/<path>`. The tool refuses every other action before it calls the app. The Review tab runs the action of a button with the rights of the app. Returns `{ id }`; the same type and title give the same id and merge into one item. Needs the desktop app to run, and needs `LLM_WIKI_API_TOKEN` even in unauthenticated mode.
- `llm_wiki_resolve_review`: mark one Review item as resolved (`id`, `action`, the label the card shows). Returns `{ ok }`. Needs the desktop app to run.
- `llm_wiki_search`: search with the app's shared keyword/vector backend.
- `llm_wiki_chat`: ask the backend Agent chat endpoint and receive answer text, references, usage, and tool events. `mode: deep` broadens backend evidence collection; full Deep Research workflows still live in the desktop app.
- `llm_wiki_graph`: query the app's knowledge graph endpoint.
- `llm_wiki_rescan_sources`: trigger a Source Watch rescan using the user's configured rules.

## Security model

The MCP server inherits the desktop API's security model:

- It only talks to `127.0.0.1` by default.
- It uses the same API token or unauthenticated setting as Settings → API + MCP.
- File reads go through the API path allow-list. Internal app state files are not exposed.
- Review data is exposed only through the dedicated Review endpoint/tool, which defaults to unresolved items rather than opening internal state files directly.
- Search and graph tools operate on projects known to the app; use `project_id: "current"` for the active project.
- For multi-project use, call `llm_wiki_set_project` once. The resolved project ID remains fixed for the lifetime of the MCP subprocess even if the desktop UI switches projects, and every project-tool response includes an `activeProject` marker.

Do not pass API tokens via command-line arguments. Prefer environment variables so they do not appear in shell history.
