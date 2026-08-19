# 0015 — Specialized explore routing

- Type: design / performance
- Status: complete
- Date: 2026-08-19
- Scope: MCP query routing and focused read-only inventories

## Background

`homegraph_explore` already recognizes usage, module dependency, and native-export questions, but its broad inventory path may prepare unrelated sections before returning. On a large index, a narrow question can therefore pay for unnecessary graph/source work, hit the MCP deadline, and push the agent back to Grep.

Adding new tools alone is insufficient because existing agents reliably call `homegraph_explore`. The compatibility entry point must route high-confidence queries to the same bounded handlers.

## Goals

1. Add three read-only tools:
   - `homegraph_usages`: usage inventory for named APIs, members, fields, or constants.
   - `homegraph_modules`: dependency/cycle inventory for named modules.
   - `homegraph_native`: NAPI/native export inventory for a named path or Type.
2. Route high-confidence `homegraph_explore` queries to exactly one focused handler before the broad inventory path.
3. Keep ambiguous flow/mechanism queries on the existing explore path.
4. Report the selected route, completion status, and coverage in the result.
5. Cover constant-only symbol bags with a bounded text sweep because constant reads may have no graph edge.

## Behavior

Routing precedence is modules → native → usages. Usage intent routing requires existing usage/member classifiers; the additional shape gate accepts only a short bag of ALL_CAPS constants. Type/method bags and queries carrying flow/mechanism wording remain on general explore.

Direct specialized calls always run their requested handler. Results use three states:

- `complete`: the bounded survey ran and found evidence.
- `no_indexed_evidence`: the survey ran but found none.
- `not_surveyed`: no usable symbol was supplied, so no survey ran.

The usage text sweep is capped at 3 seconds, 20,000 indexed files, and 256 MiB, and can be disabled with `HOMEGRAPH_EXPLORE_USAGE_SWEEP=0`. Shape routing can be disabled with `HOMEGRAPH_EXPLORE_SHAPE_ROUTING=0`.

## Non-goals

- Graph schema or extractor changes.
- Replacing general call-flow, UI, or mechanism exploration.
- Query-pool cancellation/deadline changes.
- Removing the broad inventory path.

## Acceptance criteria

- [x] All three tools appear in `tools/list` with read-only annotations.
- [x] Direct calls return the matching specialized route marker.
- [x] Equivalent high-confidence explore calls route to the same handler.
- [x] Generic flow/mechanism queries stay on general explore.
- [x] Bare constant usage finds non-call references across indexed files.
- [x] Empty direct usage queries report `not_surveyed`, not false absence.
- [x] Build and focused tests pass.
