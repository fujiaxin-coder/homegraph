# 0017 — Specialized tool adoption

- Type: change / agent affordance
- Status: completed
- Date: 2026-08-25
- Scope: MCP initialize guidance, focused-tool metadata, and compatibility routing tests
- Related: `0015-specialized-explore-routing.md`

## Background

The focused `homegraph_usages`, `homegraph_modules`, and `homegraph_native`
handlers are exposed and `homegraph_explore` already routes high-confidence
queries to them internally. In two external 68-case UI batches, however, direct
tool selection remained very low: usages appeared in 1 and 6 cases,
respectively, while modules and native were never selected.

The current initialize instructions give conflicting advice: they first tell
agents to call `homegraph_explore` for every in-repo edit, then mention the
focused tools, and later classify usages/dependencies/NAPI as explore-first.
The generic instruction wins, so the direct tools are hidden in practice.

## Goals

1. Present one mutually exclusive first-tool decision instead of overlapping
   explore-first rules.
2. Make each focused tool the primary choice only for its narrow intent:
   where-used, named module dependency/cycle, or NAPI/native exports.
3. Keep `homegraph_explore` as the primary general structural/pre-edit tool.
4. Preserve the existing conservative internal explore routing so older hosts
   and agents still receive the bounded focused implementation.
5. Avoid encouraging extra calls: one intent selects one first tool.

## Non-goals

- Forcing all three tools into every task.
- Changing graph extraction, query output, budgets, or session fuses.
- Removing `homegraph_explore` compatibility routing.
- Modifying the external evaluation harness or its scoring.

## Behavior

The initialize instructions expose this precedence:

1. Named usage/reference inventory → `homegraph_usages`.
2. Named module dependency/cycle inventory → `homegraph_modules`.
3. NAPI/native export or registration inventory → `homegraph_native`.
4. Other in-repo explanation/edit orientation → `homegraph_explore`.

The three focused definitions start with an explicit `PRIMARY` intent and say
to choose them instead of general explore for that intent. `homegraph_explore`
points clear narrow inventories to the focused tools while retaining its
automatic compatibility router. The focused definitions are listed before the
general Explore definition so hosts that preserve tool order see the decision
before the broad fallback.

This is targeted adoption, not call inflation: a focused tool replaces the
general first call for a matching task; it is not an extra call after explore.

## Acceptance criteria

- [x] Indexed and no-root initialize instructions contain the same exclusive
      focused-tool decision.
- [x] No instruction simultaneously labels usage/dependency/NAPI questions as
      both direct-focused and mandatory explore-first.
- [x] Focused definitions have distinct human-readable titles and primary
      intent descriptions.
- [x] Focused definitions appear before the broad Explore fallback.
- [x] Explore remains the general fallback and its high-confidence internal
      routing tests continue to pass.
- [x] Tests pin the guidance/metadata contract.
- [x] `npm run build` and focused MCP/routing tests pass.
