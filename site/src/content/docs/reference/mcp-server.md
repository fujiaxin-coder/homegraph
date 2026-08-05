---
title: MCP Server
description: The tools HomeGraph exposes to AI agents over MCP.
---

HomeGraph runs as a [Model Context Protocol](https://modelcontextprotocol.io/) server. Agents configured by the installer launch it automatically — you don't start it by hand:

```bash
homegraph serve mcp
```

When a `.homegraph/` index exists, the agent gets the tools below. In a workspace with **no** index, tools stay available — pass `projectPath` to a project that has an index.

## Tools (full surface by default)

HomeGraph exposes **all MCP tools by default** — search, callers, callees, impact, node, explore, status, files, and spec tools. For structural and flow questions, **`homegraph_explore`** is the primary entry point: give it a natural-language question or a bag of symbol and file names, and it returns the **verbatim, line-numbered source** of the relevant symbols grouped by file — the same shape the `Read` tool gives you — plus the call paths between them (including dynamic-dispatch hops like callbacks, React re-render, and JSX children that grep can't follow) and a blast-radius summary of what depends on them. One call usually answers the whole question.

## Tool reference

| Tool | Purpose |
|---|---|
| `homegraph_explore` | Primary: natural-language or symbol-bag query with source, flow paths, and blast radius |
| `homegraph_node` | One symbol's source + caller/callee trail, or a whole file read with line numbers (Read-parity). Returns every overload's body for an ambiguous name. |
| `homegraph_search` | Find symbols by name across the codebase (locations only) |
| `homegraph_callers` | Find what calls a function |
| `homegraph_callees` | Find what a function calls |
| `homegraph_impact` | Analyze what code is affected by changing a symbol |
| `homegraph_files` | Get the indexed file structure (faster than filesystem scanning) |
| `homegraph_status` | Check index health and statistics |
| `homegraph_spec_match` / `homegraph_spec_find` / `homegraph_spec_trace` | Commit4Spec knowledge-graph queries |

Trim the surface with the `HOMEGRAPH_MCP_TOOLS` environment variable — a comma-separated allowlist of short names:

```bash
HOMEGRAPH_MCP_TOOLS=explore,node,search,callers
```

Each also has a CLI equivalent (`homegraph node` / `query` / `callers` / `callees` / `impact` / `files` / `status`) for scripts and non-MCP harnesses.

## How agents should use it

HomeGraph *is* the pre-built search index. For "how does X work?", architecture, a flow ("how does X reach Y"), or where-is-X questions — and while editing code — an agent should answer with `homegraph_explore` and stop, typically with **zero file reads**, rather than re-deriving the answer with `grep` + `Read`. A direct HomeGraph answer is one to a few calls; a grep/read exploration is dozens.

The MCP server delivers this guidance to the main agent automatically, in the MCP `initialize` response. Because subagents and non-MCP harnesses never see that response, the installer also writes a short marker-fenced section into each agent's instructions file pointing at the `homegraph explore` CLI equivalent.
