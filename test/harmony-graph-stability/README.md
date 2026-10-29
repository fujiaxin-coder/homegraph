# harmony-graph-stability

Small Harmony fixture (5 modules × 5 `.ets`) plus split vitest cases that lock graph shape.

```
project/   # checked-in ohos multi-module tree
tests/     # one concern per file
```

Regenerate `project/` with `node test/harmony-graph-stability/_gen-project.mjs` if you change the generator. After intentional fixture edits, re-capture totals into `tests/golden.ts`.
