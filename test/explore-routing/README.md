# Explore-routing regression suite

Shape-level probes for `homegraph_explore` routing + live output budgets.
**Not** eval question IDs — categories only.

## Run (whole suite — preferred)

```powershell
# Always: build + routing classifiers
npm run test:explore-routing

# Full gate (routing + live size/mustContain against an indexed repo):
$env:HOMEGRAPH_PROBE_ROOT='D:\code\scene_board_ext'
npm run test:explore-routing
```

Or: `node scripts/run-explore-routing.mjs`

Exit code ≠ 0 if **any** case fails. Do not land a shape fix that only greened one probe.

## Layout

| File | Role |
|---|---|
| `corpus.ts` | Shared cases: route, maxChars, mustContain |
| `routing.test.ts` | CI always — exclusive routes + anti-regression |
| `live-explore.test.ts` | Needs `HOMEGRAPH_PROBE_ROOT` — real explore size/kind |

Add new shapes to `corpus.ts` first; both tests consume it.
