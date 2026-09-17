# 0036 ArkTS request constraints and behavioral evidence

- Date: 2026-09-17
- Status: Completed (local implementation and validation; inference accuracy not measured)
- Base: fe81141 (052). Initial implementation used an isolated, fixed baseline. Before develop publication, merged origin/main at 2ebe761 as explicitly requested by the user.

## Scope

Strengthen the existing query planner and explore, without modifying codingeval, changing pre-index timing, introducing another model call, or consuming benchmark answers. Keep 051/052 and external Headroom compatibility. No publication or experiment launch in this change.

## Contract

1. The optional planner output contains bounded request targets (page/literal/symbol/object; existing vs requested; optional object kind) and behavior obligations. Every text must be copied from the current query/task, not invented or certified by the planner. Old plans remain accepted; quoted request text survives omitted/empty literal arrays. Unknown/malformed new fields cause the existing rule fallback.
2. Candidate verification reads bounded local source/resource witnesses and validates page/literal/object evidence. Existing page and label constraints prioritize candidates with joint support; unresolved/ambiguous targets remain explicitly unconfirmed. Requested new labels are not required to exist. Dependent relation steps retain exact source bindings instead of rejecting helper nodes for lacking a UI label.
3. Source completeness and requirement evidence are separate. Explore adds bounded requirement coverage from actual emitted/current source. The first concrete checker covers ArkUI enabled bindings, including the negative case of disabled-looking controls with only images/colors/opacity. Other aspects remain unknown with explicit follow-up. A static binding is not proof of runtime correctness or of all acceptance conditions.
4. Use ordinary explore with existing query/taskContext inputs. No new compulsory tool choice, no hidden test text, no task-id rules. Optional typed planner data is semantic guidance; rule fallback remains deterministic.
5. Keep the source pack atomic, count added summaries in the shared budget, preserve source fingerprints, and do not claim/record omitted or stale source. Cache keys include new semantics and ablation switch; contract responses with missing proof must not become stale correctness claims.
6. Independent switches permit P0-A/P0-B comparison. Local-only changes do not automatically activate the external Headroom adapter.

## Acceptance

- [x] Planner accepts bounded grounded targets/obligations; rejects invented, invalid, oversized fields; retains original labels and step context.
- [x] Same-repo distractors (similar page names, widget vs visual card), new labels and missing/budget-limited evidence are handled without false certification.
- [x] Enabled checker distinguishes appearance-only, target-local binding, unrelated/commented binding, missing target and stale evidence; unknown for unsupported syntax/aspects.
- [x] Explore integration, cache semantics, budget and existing source-receipt/path regressions pass.
- [x] Build, synthetic real-index smoke and external Headroom byte-preservation check pass.
- [x] Documentation records boundaries and switches; old folders and codingeval untouched.

## Validation record

- `npm run build`: passed.
- 15 related test files, 245 tests passed (`validation/regression.log`), including 40 new contract/evidence checks.
- Real ArkAnalyzer/SQLite smoke: appearance-only → binding_not_observed; modified source against stale index → unknown; reindex with target binding → binding_observed (`validation/accuracy-smoke.json`). Planner responses are fixtures, no model requests.
- External Headroom 0.37.0: entire explore response byte-preserved; synthetic repeated build log passes lossless roundtrip (`validation/headroom-accuracy-compatibility.json`).
- Precise usage routes and resource-value/reference output retained. Resource indirection and unsupported controls have no new positive behavioral certification.
- `git diff --check`: passed. 052 source unchanged; all implementation writes are in 053; codingeval untouched.
- Implementation boundaries and optional switches: `docs/arkts-accuracy-contracts.md`. No real inference experiment or package release; develop publication follows the user-authorized main merge.

## Main integration

- Merged upstream `main` at `2ebe761` (1.5.8 plus index-status and JSON5 mapping updates).
- Renumbered the accuracy spec from 0031 to 0036 because upstream now owns spec numbers 0031–0035.
- Retained upstream index readiness, asset packaging and SQLite backend changes; retained 053 target/behavior evidence and Headroom compatibility.
- Integration validation: build passed; 304 distinct related tests verified (302 initial passes plus affected-suite rerun after two status-copy assertion updates); accuracy/path real-index smokes and Headroom compatibility passed. Records: `validation/main-merge/REPORT.md`.
