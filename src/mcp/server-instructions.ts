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

- How / mechanism / wiring in this repo. Domain keywords in \`query\` are enough — no PascalCase names required first.
- **How to get** a system setting / capability **as used in this repo** — explore with the question (domain keywords OK); do not Grep-first
- **Named** Type / Component / Page / Dialog / \`Type.member\` / Type + co-named methods (\`CanPlace\`/\`Place\` ↔ owner) already in the question
- Callers / callees / blast radius / subtypes of a **named** symbol
- **In-repo usages / dependencies** of a named API, \`.member\` (incl. \`.drawModifier\` / DrawContext), ALL_CAPS constant, field/mutex (incl. where \`m_*\` is \`new\`/\`delete\`'d), or \`@kit\`/\`@ohos\` import — including "does calling Kit X need other deps?" / \`oh-package\` install questions
- **Declaration / attribute sites** of a named Type (which files declare it, ids, native bindings) — English rewrites OK (\`declaration\` / \`id\` / \`binding\`)
- **Who uses the return value** of a named member/fn (incl. after 通过/via) — explore; prefer that member's callers, not a preceding create/factory or SDK \`.d.ts\`
- Path-module / named-Type **NAPI** export surfaces (not a topic file-list), multi-module interdependence, or **circular deps** among named \`*common\` / path modules
- Named \`.d.ts\` wrap + where it is imported/called
- **ALL_CAPS / enum member** usages (\`FOO_BAR\` / \`Type.MEMBER\`) — explore, not Grep-first
- **Type + listed methods** callers (\`BinaryGrid\` Set/Test/Fill) — explore caller inventory
- **Field/mutex co-use** (\`m_*\` / \`*Mutex\` with co-named methods) — explore; do not Grep the field name
- **Assigned flag impact** (\`flag = true\` … how it affects later timing) — explore the assignment site
- **Named Toggle/control state sync** across surfaces — explore
- **\`lib*.so\` + GLES/EGL / OpenGL thread** (vs UI/JS thread) — explore; do not bash/grep CMake first
- **Step / download→parse→install call-chains** ("会走到哪些代码") — explore as mechanism, not a topic file-list
- Co-named **call + visibility** questions (who calls X / how Y becomes visible) — \`homegraph_explore\`, not \`homegraph_callers\` alone / not light-mechanism
- **Conditional wiring** on a named \`Type::method\` / \`Export\` ("失败时还会…") — explore/node the method body first

After one explore → **answer**. Do not re-verify with Grep/Read/node for the same symbols.
Do **not** follow a successful explore with \`homegraph_files\` / another explore of the same bag.
Do **not** open SDK \`.d.ts\` stubs when the inventory already says in-repo sites (or zero in-repo sites).

Prefer the **smallest** tool when the name is already known: \`homegraph_callers\` / \`homegraph_callees\` / \`homegraph_node\` for one symbol; \`homegraph_explore\` for multi-file / how-wired / usage inventories (prefer explore over \`homegraph_files\` for structural questions); \`homegraph_search\` only for unknown spelling.

## Do not call HomeGraph (skip → Grep / Glob / Read / SDK docs)

Open **zero** \`homegraph_*\` tools when:

- **Topic → file list** with no concrete Type / file basename / constant / path
- **Existence / concept / pure UI behavior** with no named in-repo Type, file, or \`@kit\`/\`@ohos\` target
- **Literal / layout copy hunts** (全搜文案、字面量) with no code anchors
- **Official SDK / \`@kit\` feature catalogs** (what APIs a kit *provides*) — opposite of in-repo *usages*
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

- How/mechanism/wiring, named Type/Component/\`Type.member\`, declaration/usage inventories, constants/fields, path NAPI/deps, in-repo \`@kit\` usages → \`homegraph_explore\` first (no Grep-first)
- Topic file-lists, concept compares, literal copy hunts, SDK *catalogs* → Read/Grep/Glob — **do not call homegraph_***
- No index → Read/Grep/Glob; user runs \`homegraph init\` if they want indexing
`;
