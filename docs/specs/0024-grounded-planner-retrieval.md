# 0024 Grounded Planner retrieval and evidence recovery

Status: implementation and inference validation completed on 2026-09-07. Baseline: HomeGraph 1947829 with the preceding structured-planning changes. Experiment snapshots remain separate from this source branch.

The user accepted the tool audit proposals and specifically requested prompt/output-contract improvements before keyword rules. The new experiment remains Qwen3-32B, same 103 tasks, original base commits, concurrency and inference budgets. User authorization overrides previous keyword-fuse and Sonnet experiment guidance for this work.

## Scope and contract

1. Planner emits short retrieval concepts, verbatim literal UI texts, validated symbol hints and explicit relation intent. Natural-language planner instructions must not become exact symbol seeds. Avoid growing task-specific keyword lists. Preserve original task constraints. Keep useful semantic plans when prose such as hotel/restaurant resembles a path; never promote invented identifiers to verified evidence.
2. Prefer local business evidence for business queries; retain explicit SDK queries. Add bounded literal/resource value to resource key to source/UI/handler lookup, then use existing graph links for downstream context. Preserve source provenance, budget and project scope.
3. Evidence status comes from actual emitted source/bindings, not prose claiming completion. Retrieval completion is not task completion. Retain bounded repeat protection while allowing recovery after SDK-only/empty/incomplete evidence and newly scoped evidence obligations. Do not relax step binding validation.
4. Distinguish incoming references/registrations from outgoing calls, module dependencies and cycles. Component removal should retrieve registration/reference sites, not a module-cycle summary.
5. Canonicalize same-source duplicate declarations and prioritize complete relevant methods over boilerplate/synthetic nodes. Record truncation and coverage accurately.

## Acceptance

- [x] Prompt and plan parsing tests prevent prose-seed pollution, preserve literal labels and reject invented code anchors while accepting prose slash expressions.
- [x] Integration tests cover SDK distractors, UI resource lookup and mixed ArkTS/native entry evidence with bounded output.
- [x] Empty/SDK-only evidence does not close the coding task or prevent one bounded recovery; completed identical evidence still deduplicates.
- [x] Removal/reference routes and duplicate declaration output have meaningful regression tests.
- [x] Build and affected test suites pass; preserved real-case queries receive offline verification where feasible.
- [x] Immutable source/build/settings snapshots, all Agent/Planner HTTP and MCP traces, patches and sessions are retained for a new full103 run.
- [x] The full103 inference run completed, including a separately recorded continuation after a host interruption. Per user instruction, no recurring monitor was enabled. Findings distinguish tool evidence quality from model completion and runtime evaluation.

Validation: build and 255 tests across 15 affected HomeGraph suites pass. Evaluator seed/safety/trace suites: 67 pass. Real Planner smoke requests and literal/resource replays are retained in the parent workspace's runtime/toolopt-validation. The first new real Planner response exceeded the term bound and omitted dependsOn; the prompt now requests silent shape/count validation. Later valid unanchored usage plans exposed an empty-survey edge case; discovery now returns partial source and leaves reference coverage open. These are retrieval checks, not task correctness results.

No benchmark gold patch/test_patch/ground_truth.diff is consulted. No benchmark-specific behavior or hardcoded task identifiers in tool implementation. Official device verification remains unavailable; no success-rate claim without evidence.

Completion record (2026-09-07): all 103 result files and per-case session/MCP/Agent logs were retained across the original and continuation segments. 100 executions were confirmed complete, 84 patches were nonempty, and three executions were not confirmed complete. These are execution/artifact counts, not correctness or UI acceptance results.
