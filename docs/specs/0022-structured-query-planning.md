# 0022 — Structured query planning for code retrieval

| Field | Value |
| --- | --- |
| Status | Completed — first-version implementation; live A/B remains a separate experiment |
| Date | 2026-09-04 |
| Scope | HomeGraph code retrieval only; no eval or AST/schema changes |
| Approval | User approved the six-part plan and implementation after merging main |

## Goal

Understand intent once per explore request and share a structured retrieval plan
across compatibility routing, bounded subqueries and broad context retrieval.
Preserve the original question; a rewritten retrieval query is not evidence or a
replacement for the user's constraints. L1/L2/L3 remain descriptive depth/range
categories, not three additional tools or mandatory model-selected modes.

## First-version contract

- Introduce a serializable, versioned QueryPlan containing original/canonical
  query, intent, route, anchors, search terms, dependent steps, route features,
  planning source, fallback reason and planning timing/usage metadata.
- Default local deterministic planning preserves existing successful routes.
  HOMEGRAPH_QUERY_PLANNER=off is the rollback. In llm mode, only ambiguous or
  compound queries need one bounded request to an explicitly configured
  compatible endpoint (URL/model/key); no inherited credentials or hidden
  default provider. Only the question is sent, never repository source files.
- Validate model JSON and cap lengths/steps/dependencies. Reject cycles, unknown
  intents and fabricated symbol anchors. Preserve original entity spellings;
  unresolved proposed anchors are not graph evidence. Planning failure falls
  back to the local plan; no retries or recursive model calls.
- Integrate at the explore entry, before ambiguous queries are discarded by
  lexical skip rules. Exact known shapes bypass model planning. The same plan
  travels with the worker request; client-supplied internal fields are stripped.
- Reuse existing specialized surveys and general explore. At most three bounded
  steps share one request deadline and output budget. Dependent steps consume
  symbols resolved from predecessor queries, not guessed identifiers or raw
  text scraped from a previous answer. No recursive public MCP invocation.
- Index readiness is checked before planning/execution and again in workers.
  homegraph_project remains a main-thread shallow map tool; a plan must not
  trigger auto-init or pretend shallow files prove a call chain. Partial
  indexing is not equivalent to complete evidence.
- ContextBuilder can consume planned symbol/search hints; general callers keep
  their existing defaults. The first version uses canonical queries as a
  compatibility adapter for legacy section builders; it does not claim to
  remove every heuristic in tools.ts.
- Plan-aware cache keys preserve relation direction, plan version and index
  state; never cache a transient planning/indexing failure. Session repeat and
  emission accounting remain one public call, not one per internal step.
- Multi-step output cannot inherit a child's global ANSWER NOW declaration.
  Report per-step coverage conservatively and reconcile partial directives.
- Add compact diagnostic metadata (not source dumps or secrets) for route,
  planning time/tokens, steps and fallbacks. Timing includes planning overhead.

## Non-goals

No graph extraction algorithm changes; no changes to spec retrieval or eval;
no new MCP tools; no live paid benchmark or claimed token/latency improvement;
no remote push, release, or credential lookup. This is a measured first version,
not a wholesale removal of all shape-specific survey heuristics.

## Acceptance

- [x] Main merge preserves upstream project-map support and local tool guidance.
- [x] Local plan and legacy-off behavior have regression coverage.
- [x] Model planning is opt-in, once-only, timed out and schema/anchor validated.
- [x] Invalid/timeout plans fall back without failing an answered tool call.
- [x] Dependent steps, caps, partial aggregation and client-field stripping tested.
- [x] Context hints and direction-sensitive cache identity tested.
- [x] Index-readiness, worker and session behavior covered by relevant regressions.
- [x] Build and targeted tests pass; remaining limitations documented.
- [x] README, server instructions and Unreleased changelog match actual behavior.

## Verification and handoff

Main merged locally at `1947829` (remote main `0e5be20`). Existing local changes
were restored and their pre-merge stash retained. Development branch:
`feat/structured-query-planning`; no remote push or release performed.

`npm run build` passes. Targeted regression collection covers query planning,
provider failure/timeout, actual worker transfer, context hints, cache, old
Explore routes, budgets, MCP validation/unindexed behavior, project map and
query pool. This is not a claim that the entire repository suite or a paid
model A/B was run. Setup, metadata semantics and limitations are documented in
[`docs/query-planning.md`](../query-planning.md).
