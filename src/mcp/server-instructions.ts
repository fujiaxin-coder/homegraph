/**
 * Server-level instructions emitted in the MCP `initialize` response.
 *
 * Single source of truth for agent-facing tool guidance (issue #529).
 * Edit here — not installer prompts or eval harness prompts.
 */

export const SERVER_INSTRUCTIONS = `# HomeGraph — when to call

HomeGraph is a **local structural index of THIS repo**: symbols + call/import/extends edges + files. Use it only when the answer needs that graph.

## Call HomeGraph (closed set)

Use \`homegraph_explore\` (primary) when **all** of these hold:

1. The evidence lives **in this repository's source** (not an external SDK manual).
2. You need **structure**: definition location, who calls whom, how A reaches B, multi-file wiring, or in-repo import/usage of a named API/\`@kit\` module.
3. You can put **concrete names** in \`query\` — symbol, \`Type.member\`, file basename, or \`@kit…\` (skip \`homegraph_search\` when names are already known).

Typical fits:

- How a **feature in this repo** is wired (mechanism / cross-file / click→handler flow)
- Callers / callees / blast radius of a **named** symbol
- What a **named component/method** does (include the name; one explore is enough)
- In-repo usages of an imported API (not the official feature catalog)

**One explore with names** beats search→explore→node→grep→read. Treat returned line-numbered source as already Read. After a full explore — **answer**; do not re-verify with grep/read/node for the same symbols. Busy/partial → retry that **same** explore once.

## Do not call HomeGraph otherwise

If the question is **outside the set above**, do **not** open any \`homegraph_*\` tool — use Read / Grep / Glob / SDK docs. HomeGraph is not a general Q&A layer; forcing it on the wrong shape costs time and tokens and often lowers quality.

## Tool roles

| Tool | Role |
|------|------|
| **homegraph_explore** | Primary for the closed set above |
| homegraph_diff_impact | PR/diff review: unified \`diff\` or \`hunks\` → changed symbols (line∩span) + capped callers/impact/UI edges |
| homegraph_node | One known symbol body (or indexed file) after explore named it |
| homegraph_callers / callees | Compact edge lists for a named symbol |
| homegraph_impact | Blast radius for one named symbol (not a whole PR) |
| homegraph_search | Rare — unknown spelling only |
| homegraph_files | Folder tree only |

## Tips

- **Deadline / partial** — success-shaped; retry ONE explore with the same names. Do not abandon to grep for those symbols.
- **Staleness banner** — Read only the listed edited files.
- **Not indexed** — built-in tools; user runs \`homegraph init\` — you do not.
`;

export const SERVER_INSTRUCTIONS_NO_ROOT_INDEX = `# HomeGraph — per-project (pass projectPath)

HomeGraph indexes a codebase into a symbol graph. Call it **only** for in-repo structural / flow / usage questions on a project that has \`.homegraph/\`. Pass that project as \`projectPath\`.

- Fits the closed set (structure, callers, wiring, named symbol/file) → \`homegraph_explore\`
- Anything else → Read/Grep/Glob — **do not call homegraph_***
- No index → Read/Grep/Glob; user runs \`homegraph init\` if they want indexing
`;
