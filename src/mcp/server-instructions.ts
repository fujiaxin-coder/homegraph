/**
 * Server-level instructions emitted in the MCP `initialize` response.
 *
 * Single source of truth for agent-facing tool guidance (issue #529).
 * Edit here — not installer prompts or eval harness prompts.
 *
 * Keep this short: long essays are low-salience and rarely change tool choice.
 * Prefer concrete habits (query shape, which tool, when to stop).
 */

export const SERVER_INSTRUCTIONS = `# HomeGraph — structural locator for THIS repo

Local symbol graph (defs / calls / imports / files). Use it to **stop blind Grep**, get \`file:line\` anchors + source, then answer. Not general Q&A, not SDK docs.

## Call first (do not Grep/Glob/Read first)

Will you **explain or edit in-repo code**? → \`homegraph_explore\` **once** with the user task as \`query\` (Chinese OK; add English Type / \`Type.member\` / \`@kit\` / \`@ohos\` tokens when you know them).

Already know **one** exact symbol? Prefer smaller tools: \`homegraph_callers\` / \`homegraph_callees\` / \`homegraph_node\`. Spelling unknown → \`homegraph_search\` last.

**Must explore-first:** how/mechanism wiring, named Type / \`.member\`, in-repo \`@kit\`/\`@ohos\` **usages**, deps/cycles, NAPI / \`.d.ts\` wrap sites, pre-edit orientation.

ArkUI V1↔V2 / state-decorator migration on a named component → \`homegraph_arkui_migrate\` once (not explore stitching).

## How to write \`query\`

- Put **concrete anchors** in the bag: \`FooManager\`, \`BarEvent\`, \`Type.member\`, \`feature/foo\`, \`@kit.X\`.
- Map Chinese entities to English symbol stems when you can (\`设置\`→\`Setting\`, \`新建\`→\`New\`) — search/explore cluster \`Entity\` / \`EntityManager\` / \`EntityViewModel\`.
- Keep **intent words** with the Type (\`来源\` / \`分发\` / \`依赖\` / \`NAPI\`) — bare Type alone may drop survey routing.
- Multi-app monorepo: pass \`projectPath\` to the app root; ignore sibling-app paths as noise.

## After one explore

- Returned line-numbered source = **already Read** — do not re-Grep/Read/node the same symbols.
- **ANSWER NOW** → answer/edit; do not verify with a Grep storm.
- **Partial locator** → **ONE** tighter follow-up with a **Manager / file / member** from the list — never re-explore a paraphrase of the same bag (server may refuse overlaps). Then ONE narrow Grep only for residual literals / unindexed wiring.
- Busy/deadline → retry **once** tighter; then answer.

Prefer smallest tool when the name is known: callers/callees/node ≪ explore ≪ search.

## Do not call HomeGraph

Runtime Skip is a short blacklist (everything else is served if you call):

- Topic → file list with no Type/file basename
- Literal / layout copy hunts with no Type/file/\`@kit\`/\`@ohos\`
- Pure existence / concept-compare with no graph anchors
- Official website/docs only · scaffold empty project · git/blame/diff · media/binary inventories

\`@kit\` / OHOS **API usage in this repo** → explore (not Skip). Feature **catalogs** of an SDK → SDK docs, not HomeGraph.

If a tool returns **Skip HomeGraph**, stop — do not retry \`homegraph_*\`.

## Tips

- Empty callers/callees = **edges not indexed**, not “missing symbol” — use the definition anchor; narrow Grep for registration if needed.
- **Staleness banner** — Read only listed edited files.
- **Not indexed** — use built-ins; user runs \`homegraph init\` (you do not).
`;

export const SERVER_INSTRUCTIONS_NO_ROOT_INDEX = `# HomeGraph — per-project (pass projectPath)

Pass \`projectPath\` to a folder that has \`.homegraph/\`.

**Call first:** explain/edit in-repo code → \`homegraph_explore\` with task keywords (no Grep-first). Named Type / \`Type.member\` / usages / deps / NAPI / \`@kit\` → explore.

**Skip:** topic file-lists, concept compares, literal hunts, git history, media. No index → Read/Grep/Glob; user runs \`homegraph init\`.

**Query habit:** Chinese OK; add English Type/\`@kit\` tokens when known. Partial → one tighter follow-up with a concrete name from the list — not a Grep storm.
`;
