/**
 * Server-level instructions emitted in the MCP `initialize` response.
 *
 * Single source of truth for agent-facing tool guidance (issue #529).
 * Edit here — not installer prompts or eval harness prompts.
 */

export const SERVER_INSTRUCTIONS = `# HomeGraph — when to call

HomeGraph is a **local structural index of THIS repo**: symbols + call/import/extends edges + files. Use it when the answer needs that graph.

## Call HomeGraph first (do this before Grep/Read)

For these shapes, open \`homegraph_explore\` **immediately** — do **not** Grep/Glob/Read first (and do **not** parallel-Grep on the same turn):

- **How / mechanism / wiring** in this repo. Domain keywords in \`query\` are enough — no PascalCase names required first.
- **Named** Type / Component / Page / Dialog / \`Type.member\` already in the question
- Callers / callees / blast radius / subtypes of a **named** symbol
- **In-repo usages / dependencies** of a named API or \`@kit\`/\`@ohos\` import (e.g. which files \`import { foo } from '@kit.X'\`) — pass the user question as \`query\`

After one explore → **answer**. Do not re-verify with Grep/Read/node for the same symbols.

Prefer the **smallest** tool when the name is already known: \`homegraph_callers\` / \`homegraph_callees\` / \`homegraph_node\` for one symbol; \`homegraph_explore\` for multi-file / how-wired / usage inventories; \`homegraph_search\` only for unknown spelling.

## Do not call HomeGraph (skip → Grep / Glob / Read / SDK docs)

Open **zero** \`homegraph_*\` tools when:

- **Topic → file list** with no concrete Type / file basename
- **Existence / concept / pure UI behavior** with no named in-repo Type, file, or \`@kit\`/\`@ohos\` target
- **Official SDK / \`@kit\` feature catalogs** (what APIs a kit *provides*) — opposite of in-repo *usages*
- **Literal string / copy-paste pattern hunts**
- Evidence lives only in **external manuals**

\`@kit\` **usages in this repo** ≠ SDK catalog. Usages → explore. Catalogs → SDK docs.

If explore/search returns **Skip HomeGraph**, treat as final — do not retry homegraph_*.

## Tips

- Busy/partial → retry that **same** explore once; then answer.
- **Staleness banner** — Read only the listed edited files.
- **Not indexed** — built-in tools; user runs \`homegraph init\` — you do not.
`;

export const SERVER_INSTRUCTIONS_NO_ROOT_INDEX = `# HomeGraph — per-project (pass projectPath)

HomeGraph indexes a codebase into a symbol graph. Pass \`projectPath\` to a project with \`.homegraph/\`.

- How/mechanism/wiring, named Type/Component/\`Type.member\`, in-repo \`@kit\` usages/dependencies, inheritance → \`homegraph_explore\` first (no Grep-first)
- Topic file-lists, concept compares, SDK *catalogs*, literal greps → Read/Grep/Glob — **do not call homegraph_***
- No index → Read/Grep/Glob; user runs \`homegraph init\` if they want indexing
`;
