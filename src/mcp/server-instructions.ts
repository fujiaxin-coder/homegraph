/**
 * Server-level instructions emitted in the MCP `initialize` response.
 *
 * Single source of truth for agent-facing tool guidance (issue #529).
 * Edit here — not installer prompts or eval harness prompts.
 */
export const SERVER_INSTRUCTIONS = `# HomeGraph — indexed code: explore instead of grep/read

When a project has a \`.homegraph/\` index, **\`homegraph_explore\` is the default way to find and read code there** — before grep, glob, or Read. One call returns **verbatim, line-numbered source** (\`<n>\\t<line>\`, safe to Edit from) plus call paths and blast radius. Treat returned source as **already Read**; do not grep/read the same symbols again.

## When to call homegraph_explore (indexed code only)

Use **first** for:

- **Find related files** — put symbol names or domain terms from the question in \`query\`
- **Where is X used / defined** — \`query\` = the symbol or API name from the question
- **Imports / dependencies in this repo** — \`query\` = the imported symbol(s); answers from indexed source, not external docs
- **A named source file** — \`query\` = file basename (no directory) plus any symbol named in the question
- **Config / manifest filenames** — include the filename (e.g. \`*.json5\`, \`*.yaml\`) in \`query\`
- **\`@kit.*\` imports (HarmonyOS/OpenHarmony)** — \`query\` = kit module + API/symbol from the question
- **How A reaches B** — name symbols on the path in one \`query\`
- **Read a symbol or file** — put the path or symbol in \`query\`; overloads return every body in one call

Query = **symbol names, file basenames, or a short question**. No prior \`homegraph_search\` needed.

**After explore:** need another area? Call \`homegraph_explore\` again with more names — not grep/read for indexed source.

**Not indexed** (configs, docs, no \`.homegraph/\`): use built-in Read/Grep/Glob for that gap only.

## Tool roles

| Tool | Role |
|------|------|
| **homegraph_explore** | **Primary** — find + read + flow in one call |
| homegraph_node | One symbol or file depth after explore |
| homegraph_search | Name hint only — then explore |
| homegraph_files | Folder tree only — not for code Q&A |

## Anti-patterns

- **Don't grep/glob first** to discover or read indexed source — explore already returns paths and bodies.
- **Don't fetch external SDK docs first** when the question is about code **in this repo** (imports, usages, dependencies) — explore the imported symbol names from the index.
- **Don't re-verify explore output with grep** — it is AST-derived; trust it unless the staleness banner lists a file.
- **Don't hand-reconstruct flows** — name endpoints in one explore query.
- **Pure literal text patterns** (exact string chains with no symbol names) — explore may not enumerate every match; use grep only after explore does not cover the question.
- **Staleness banner** — if listed files were edited since sync, Read those files only; others stay authoritative.
- **Inventory sections** (dependency list, caller paths, config file) may omit full source when the graph has no flow path — answer from those sections directly.

## Limits

- Index lags writes ~1s. Ambiguous symbols may return multiple candidates.
- If a project isn't indexed, use built-in tools there; mention \`homegraph init\` if relevant — don't run it yourself.
`;

export const SERVER_INSTRUCTIONS_NO_ROOT_INDEX = `# HomeGraph — per-project (pass projectPath)

HomeGraph indexes a codebase into a symbol graph. **\`homegraph_explore\`** returns line-numbered source + call paths in one call — use it **instead of grep/read/glob** for any project that has a \`.homegraph/\` index.

This server root has no index. For a project **with** \`.homegraph/\`, pass its path as \`projectPath\` on \`homegraph_explore\` (and other homegraph tools).

- **Indexed project** → \`homegraph_explore\` first for where/what/how and file/symbol lookup.
- **No index** → Read/Grep/Glob. User runs \`homegraph init\` if they want indexing (picked up live).
`;
