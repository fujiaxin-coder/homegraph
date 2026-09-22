# 054 verification

- Baseline: 053 `b9e65d3`; upstream main `aff8236` merged locally as `8c3badb` in a separate checkout. No push or package release.
- Correct remote: `git@gitcode.com:SMAT/HomeGraph.git`.
- `npm ci --ignore-scripts` installed the current lockfile, including ArkAnalyzer 1.0.94, into this checkout's own node_modules.
- Build passed. Full targeted run: **314 tests passed across 23 files**, zero failures/skips. After bounding SDK metadata to signatures (omitting full docstrings), the affected 23 context tests passed again.
- Real ArkAnalyzer/SQLite → ordinary MCP explore smoke passed: a complete static render path, imported Product fields, actual module manifest snapshot and two control summaries arrive together. The missing direct enabled binding on an icon remains explicit.
- The smoke also recorded and checked the opt-in audit's `arkts_pack_before_host_wrapping` stage and complete pack body.
- Existing 053 real-index smoke passed: appearance-only → `binding_not_observed`; stale source → `unknown`; reindexed direct enabled binding → `binding_observed`. Fixed planner fixture made exactly three requests for three separate queries; no inference-provider call was added.
- Tests cover alias imports, declared file dependencies, barrel exports, unrelated names, comments/stringified exports, shared components, SDK signature/type bundles, module ambiguity, cache freshness, source budget boundaries, symlink refusal and audit capacity.
- External **Headroom 0.37.0** preserved the entire generated explore text byte-for-byte. Repeated synthetic compiler text passed the existing lossless compression/roundtrip check. This is compatibility evidence, not a benchmark token or latency gain.
- Intermediate checks exposed absent type-import edges and split struct/component ownership. Exact source-backed module resolution and identity projection fixed the real-index gaps. A cache regression for queries with empty context summaries was fixed; the final full targeted run passed.
- Raw local records are retained in `validation/054/` (gitignored because they contain temporary/machine paths): build/test logs and JSON, real-index evidence, original accuracy checks and Headroom results.
- Original 053 working tree remains clean. No codingeval source/configuration, benchmark answers, hidden assertions or original experiment output were modified or used for implementation.

## Limits and next measurement

This is bounded static evidence, not runtime verification. SDK inheritance/indirect types, unmapped Kit modules, Native headers, inherited UI modifiers and asynchronous ordering can still be unresolved. No device execution or real model inference A/B was run.

For the next codingeval A/B, use the same merged source, model, Headroom, budgets, indexing timing and log policy in both arms, toggling `HOMEGRAPH_ARKTS_IMPLEMENTATION_CONTEXT` and `HOMEGRAPH_ARKTS_CONTROL_EVIDENCE`. This separates this batch from the upstream changes. Compare paired accuracy and rounds/tool calls, retaining failures and all intermediate results.
