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

Local symbol graph (defs / calls / imports / files). Use it to locate in-repo symbols (\`file:line\` + source), then continue the user's requested explanation, edits and validation. Retrieval completion is not task completion.

## Call first: choose exactly ONE first tool (do not Grep/Glob/Read first)

Use the narrow tool when the task is exactly one of these inventories:

- **Where is this named API/member/constant/field used?** → \`homegraph_usages\`
- **How do these named modules depend on each other / is there a cycle?** → \`homegraph_modules\`
- **Which NAPI/native exports or registration sites does this named path/Type expose?** → \`homegraph_native\`

Otherwise, if you will **explain or edit in-repo code**, call \`homegraph_explore\` **once** with the user task as \`query\` (Chinese OK; add English Type / \`Type.member\` / \`@kit\` / \`@ohos\` tokens when known). Do not call explore after a focused tool already answered the inventory. Older clients that call explore still get the same focused handler through conservative compatibility routing.

Engineering overview / module→file map (including while the full index is still building) → \`homegraph_project\`.

Already know **one** exact symbol body or call direction? Prefer \`homegraph_callers\` / \`homegraph_callees\` / \`homegraph_node\`. Spelling unknown → \`homegraph_search\` last.

**Must explore-first:** how/mechanism wiring, cross-Type/component behavior, \`.d.ts\` wrap flows, and general pre-edit orientation that is not one of the three narrow inventories above.

ArkUI V1↔V2 / state-decorator migration on a named component → \`homegraph_arkui_migrate\` once (not explore stitching).

## How to write \`query\`

- Preserve the task's intent, relation direction and scope; do not stuff keywords or invent symbols. For edits, include the requested action, target product/module, exclusions and acceptance requirements in query or optional taskContext. Do not replace a deletion/refactoring request with a bare component name. When optional query planning is enabled, explore can plan bounded dependent lookups internally; scoped natural-language queries can be planned even when a lexical route matches, while exact symbol/path lookups stay cheap. No extra tool or explicit depth tier is required. Planned subquestion evidence is not a completeness claim for the whole task.
- Planned steps keep separate retrieval focuses. Located source candidates carry file/line identity, not proof that the intended business feature is correct; check them against the original task constraints before editing. A missing dependency is reported as unexecuted, not as evidence that the code does not exist.
- Before editing, verify that the evidence belongs to the requested product/module and that referenced symbols actually exist. A project map is only navigation, not proof that a feature has been located. If source evidence is ambiguous or belongs to another product, use a bounded follow-up instead of editing that hit. Read-duplication guidance never forbids checks needed to avoid an incorrect edit.
- Put **concrete anchors** in the bag: \`FooManager\`, \`BarEvent\`, \`Type.member\`, \`feature/foo\`, \`@kit.X\`.
- Map Chinese entities to English symbol stems when you can (\`设置\`→\`Setting\`, \`新建\`→\`New\`) — search/explore cluster \`Entity\` / \`EntityManager\` / \`EntityViewModel\`.
- Keep **intent words** with the Type (\`来源\` / \`分发\` / \`依赖\` / \`NAPI\` / \`驱动\`) — bare Type alone may drop survey routing.
- Multi-app monorepo: pass \`projectPath\` to the app root; ignore sibling-app paths as noise.

## After one explore

- Reuse returned line-numbered source for the ranges actually shown. An outline, anchor, candidate list, truncated body or SDK declaration is not a substitute for missing business code.
- Check source relevance and every requested change before editing. A retrieval status or completion banner never authorizes ending a coding task or skipping implementation and validation.
- Empty, SDK-only or partial evidence → **one** bounded recovery aimed at the missing evidence. The suggested **Next anchor** is advisory; a newly scoped obligation may need another file or Type. One focused \`homegraph_node\`, \`homegraph_callers\` or \`homegraph_callees\` can recover a missing body or relation.
- If evidence is still missing after the retrieval budget, inspect it with targeted Read/Grep and continue the requested work. Do not infer that the feature is absent or that the task is complete.
- Busy/deadline → retry **once** tighter; then inspect the missing source directly.

Prefer the smallest tool when the name is known and reuse unchanged evidence. Session budget: **≤2** \`homegraph_explore\` attempts per project, including empty responses; **≤1** focused depth recovery after incomplete evidence. Identical requests with usable evidence may be deduplicated; lexical overlap alone does not prove a new obligation was answered.

## Do not call HomeGraph

Runtime Skip is a short blacklist (everything else is served if you call):

- Topic → file list with no Type/file basename
- Pure layout-copy or media hunts with no code behavior to locate
- Pure existence / concept-compare with no graph anchors
- Official website/docs only · scaffold empty project · git/blame/diff · media/binary inventories

\`@kit\` / OHOS **API usage in this repo** is not Skip: exact where-used → \`homegraph_usages\`; mechanism/API-symbol flow → \`homegraph_explore\`. Feature **catalogs** of an SDK → SDK docs, not HomeGraph.

For UI behavior, preserve the verbatim label in the query: resource strings may lead to their source references, event handler and route. If a tool reports unsupported scope or an exhausted budget, use targeted built-ins for the missing evidence and continue the user's task.

## Tips

- Empty callers/callees = **edges not indexed**, not “missing symbol” — use the definition anchor; narrow Grep for registration if needed.
- **Staleness banner** — refresh the listed changed source before relying on it.
- **Not indexed** — use built-ins; user runs \`homegraph init\` (you do not).
`;

export const SERVER_INSTRUCTIONS_NO_ROOT_INDEX = `# HomeGraph — per-project (pass projectPath)

Pass \`projectPath\` to a folder that has \`.homegraph/\`.

**Choose exactly one first tool:** named where-used → \`homegraph_usages\`; named module deps/cycles → \`homegraph_modules\`; named NAPI/native exports → \`homegraph_native\`; every other in-repo explanation/edit → \`homegraph_explore\`. Pass the same \`projectPath\`. Do not call explore after a focused inventory already answered.

**Skip:** topic file-lists, concept compares, git history, media. No index → Read/Grep/Glob; user runs \`homegraph init\`.

**Query habit:** Chinese OK; keep UI labels verbatim and add English Type/\`@kit\` tokens only when known. Preserve requested edits and scope. Empty/SDK-only/partial evidence permits one focused recovery, then targeted source inspection. Retrieval completion is not task completion: continue the requested edits and validation.
`;
