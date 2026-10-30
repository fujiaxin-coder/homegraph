# harmony-graph-stability

Small Harmony fixture (5 modules × 5 `.ets`) plus split vitest cases that lock graph shape.

```
project/   # checked-in ohos multi-module tree
tests/     # one concern per file
```

Regenerate `project/` with `node test/harmony-graph-stability/_gen-project.mjs` if you change the generator. Goldens in `tests/golden.ts` are **source + indexing-rule priors** (not “match Received”).

## Locked and green

| Test | Prior |
| --- | --- |
| `ets-file-count` | 25 `.ets` file nodes |
| `cross-module-imports` | 24 `imports` edges |
| `heritage-edges` | 5 `extends` + 5 `implements` |
| `resolve-child-kind-fallback` | Spec 0063 (no kind-scan on name miss) |
| `ets-typescript-parser-fallback` | Spec 0062 |
| `double-index-stable` | two fresh indexes agree |

## Skipped — priors written, live index disagrees (do not “fix” by copying Received)

| Test | Source/rule prior | Why skipped |
| --- | --- | --- |
| `anonymous-nodes` | **40** `%AM` keys (8 λ × 5 mods), **20** files | Live graph has **55** keys — extra AA Lib line-1 `%AM*` shells not in source |
| `viewtree-edges` | **35** viewtree edges (7 × 5) | Live graph has **30** — one of the seven rule slots per module is missing or merged |
| `graph-totals` | edges **363**, `references` **35** (= viewtree prior); `nodes`/method/function/contains/calls still TODO | Live edges **358** / references **30**; full contains/calls/AM inventory not finished |
| `viewtree-am-declaring-file` | P3 declaring-file attribution | Production fix not landed (`describe.skip`) |

Until those gaps are closed (either correct HG to match the prior, or revise the prior with a completed per-edge/per-λ inventory), keep the skips. Do not weaken priors back to `>= 1`.
