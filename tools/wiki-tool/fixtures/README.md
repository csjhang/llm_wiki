# Fixtures

Samples of Heptabase MCP tool output, used by the parser tests in `src/parse-mcp.test.ts`. `read_whiteboard_fusion.txt` is a
fusion board (a source section, a target section with the mind map of `read_object_mindmap.txt`, and a section that is neither),
used by `src/fuse/resolve-board.test.ts`.
They keep the line shapes of real output. Every id is `00000000-0000-4000-8000-0000000000NN`, and every
title, whiteboard name, section name, and mind map node is placeholder text (`Board A2`, `Section One`,
`Node 1.1`). The titles keep the special characters the parsers must handle: `"`, `[`, `]`, `|`, `｜`, `：`, `／`, and `, `.
The tags `wiki-test` and `ingest-test` and the database option names are generic examples. None of this is real data.
