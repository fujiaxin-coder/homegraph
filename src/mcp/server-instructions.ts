/**
 * MCP initialize 中的统一工具指引；工具描述必须遵守相同的按需策略。
 * 仅调整检索选择，不改变索引、查询语义或编码任务的验收要求。
 */

const SOURCE_AND_VALIDATION = `
- ArkTS evidence packs keep complete declarations and the source dependencies of displayed static relations together. Gaps identify omitted, stale or unindexed evidence; inspect only a gap relevant to the task. A static link does not prove runtime ordering or value propagation, and a complete declaration does not prove its enclosing call conditions.
- Reuse complete, unchanged, line-numbered source ranges already visible. An outline, path list, truncated body or SDK declaration cannot replace missing implementation evidence. A slice hash identifies that excerpt, not the whole file. Refresh affected ranges after edits.
- An empty edge set means the relation may be unindexed, not absent. For partial, stale or irrelevant results, inspect the exact missing source with scoped search/read. After a query adds no evidence, change the method or scope rather than paraphrasing the same explore.
- Retrieval completion is not task completion. Continue the requested edits and validation; check the original task's behavior and preservation constraints. Build success alone does not establish functional correctness.
`;

const ON_DEMAND = `## When to call (path-first, bash-first)

Use ordinary bash/search/read tools first for repository paths, symbols, literal strings and local changes. Skip HomeGraph when those tools provide sufficient evidence, including for difficult implementation tasks. A known path can be read directly; an adequate source result does not need a second graph lookup.

HomeGraph is optional. Use it only for a concrete unresolved relationship that benefits from graph evidence: cross-file state/event propagation, callers/callees, module dependencies or ArkTS-to-native registration. Name the missing relation and use anchors from the current task or source. There is no mandatory number of bash searches before a useful graph query.

Choose the smallest available tool for that gap:
- Exact usage/reference locations → \`homegraph_usages\`; callers/callees → the corresponding tool.
- Named module dependencies/cycles → \`homegraph_modules\`; native exports/registration → \`homegraph_native\`.
- One missing symbol body → \`homegraph_node\`; prefer direct read if its path is already known.
- An unresolved cross-symbol mechanism → \`homegraph_explore\`. Do not use it for routine pre-edit orientation, a literal search, or to re-confirm source already found with bash.
- ArkUI migration analysis → \`homegraph_arkui_migrate\` when that analysis is needed; SDK contracts → project declarations or SDK documentation.

Do not call explore after a focused tool already answered the relation. Keep working directly once the edit location and affected behavior are sufficiently supported. Task difficulty and file count alone do not require graph use.
`;

const QUERY = `## Query and recovery

Write one focused sentence: requested action + target + known anchors + unresolved relation + preservation constraints. Use the full public task as \`taskContext\` when needed. Keep UI labels verbatim; use exact symbols from the task or source instead of inventing names or piling up generic keywords. Use returned repository-relative paths without reconstructing an experiment directory; a path refusal requires valid in-repo relocation, not broader permissions.

A project map is navigation, not proof of a located feature. Preserve requested product/module scope and verify each candidate before editing. Start with one focused graph request; recover only a named missing body/relation. Budget: ≤2 \`homegraph_explore\` attempts per project, ≤1 focused depth recovery; existing runtime budgets may be tighter. These are ceilings, never a required sequence. If evidence is still missing, use targeted bash/search/read and continue implementation. Do not expand into unrelated files merely to exhaust a budget.
`;

export const SERVER_INSTRUCTIONS = `# HomeGraph — optional structural evidence for this repo

${ON_DEMAND}
${QUERY}
${SOURCE_AND_VALIDATION}
No index → use ordinary tools; indexing is managed by the host. Do not run HomeGraph initialization as part of solving the task.
`;

export const SERVER_INSTRUCTIONS_NO_ROOT_INDEX = `# HomeGraph — optional per-project evidence

Pass \`projectPath\` to an already indexed folder with \`.homegraph/\`. No index → use ordinary tools; indexing is managed by the host.

${ON_DEMAND}
${QUERY}
${SOURCE_AND_VALIDATION}
`;
