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

Local symbol graph (defs / calls / imports / files). Use it to **coarse-locate** in-repo symbols (\`file:line\` + short source), then answer. Not general Q&A, not SDK docs.

## When to call (path-first)

- User task already names an in-repo **relative path** to **one** source file (e.g. \`features/.../Foo.ets\`) and is a **code change** → **Read that file** and edit. **Do not call \`homegraph_*\`** — explore on path-pinned edits is skipped (correct behavior).
- No clear path / need to locate symbols or cross-file wiring → \`homegraph_explore\` **once** with the user task as \`query\` (Chinese OK; add English Type / \`Type.member\` / \`@kit\` / \`@ohos\` tokens when you know them). Do **not** open with a Grep/Glob storm.
- Already know **one** exact symbol (no file path yet)? Prefer smaller tools: \`homegraph_callers\` / \`homegraph_callees\` / \`homegraph_node\`. Spelling unknown → \`homegraph_search\` last.

For a narrow inventory, call \`homegraph_usages\` (where-used), \`homegraph_modules\` (named module deps/cycles), or \`homegraph_native\` (NAPI exports). Existing clients may keep calling \`homegraph_explore\`: high-confidence shapes route to the same bounded handlers.

**Prefer explore when locating:** how/mechanism wiring, named Type / \`.member\`, in-repo \`@kit\`/\`@ohos\` **usages**, deps/cycles, NAPI / \`.d.ts\` wrap sites — when the task does **not** already pin a single file path.

ArkUI V1↔V2 / state-decorator migration on a named component → \`homegraph_arkui_migrate\` once (not explore stitching).

## How to write \`query\`

- Put **concrete anchors** in the bag: \`FooManager\`, \`BarEvent\`, \`Type.member\`, \`feature/foo\`, \`path/to/File.ets\`, \`@kit.X\`.
- Map Chinese entities to English symbol stems when you can (\`设置\`→\`Setting\`, \`新建\`→\`New\`) — search/explore cluster \`Entity\` / \`EntityManager\` / \`EntityViewModel\`.
- Keep **intent words** with the Type (\`来源\` / \`分发\` / \`依赖\` / \`NAPI\` / \`驱动\`) — bare Type alone may drop survey routing.
- Multi-app monorepo: pass \`projectPath\` to the app root; ignore sibling-app paths as noise.

## After one explore

- Returned line-numbered source = **already Read** for those symbols — do not re-Grep/Read/node the **same** symbols.
- Digests are for **named / hit files** — do not treat unrelated neighbor pages in the same folder as required reading.
- **Coarse locate / ANSWER NOW** → answer/edit from anchors; do not verify with a Grep storm.
- **Partial locator** → **ONE** tighter follow-up with the named **Next anchor** only — never a paraphrase or a different Type (server refuses). After Partial: **no** \`homegraph_callers\`/\`callees\`; at most **one** \`homegraph_node\`. A **second** Partial → stop HomeGraph; ONE narrow Grep then answer — never a repo-wide glob/Read storm.
- Busy/deadline → retry **once** tighter; then answer from anchors (narrow Grep OK for residuals).

Prefer smallest tool when the name is known: callers/callees/node ≪ explore ≪ search. Prefer **one** Type-wide inventory explore over fanning \`homegraph_callers\` per method. Session fuse: **≤2** \`homegraph_explore\` per project; after Partial follow-ups must name the **Next anchor**; **≤1** \`homegraph_node\` after Partial — further calls are refused.

## Do not call HomeGraph

Runtime Skip is a short blacklist (everything else is served if you call):

- **Single-file path pinned in the task** → Read + edit (Skip HomeGraph)
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

**When to call:** single-file path in the task → Read + edit (Skip HomeGraph). No path / need locate → \`homegraph_explore\` with task keywords (no Grep-first storm). Named Type / \`Type.member\` / usages / deps / NAPI / \`@kit\` → explore.

Narrow inventories may call \`homegraph_usages\`, \`homegraph_modules\`, or \`homegraph_native\` directly; pass the same \`projectPath\`.

**Skip:** path-pinned single-file edits, topic file-lists, concept compares, literal hunts, git history, media. No index → Read/Grep/Glob; user runs \`homegraph init\`.

**Query habit:** Chinese OK; add English Type/\`@kit\`/path tokens when known. Explore = coarse locate on **hit** files. Partial → one tighter follow-up with a concrete name from the list. ONE narrow Grep OK for residual unindexed wiring — not a Grep storm.
`;
