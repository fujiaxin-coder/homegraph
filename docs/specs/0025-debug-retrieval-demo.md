# 0025 — Reproducible Python retrieval debugger

Status: approved scope from the user's 2026-09-07 request; implemented and verified; see ../debug-retrieval-demo.md for observed limits.

Provide a standard-library Python script that exercises the real built HomeGraph
MCP server and optionally its real Planner. Select ArkTs_Exp_218 for broad UI,
ArkTS/native, registration, references and dependency coverage. Read only its
task statement and original base source; do not access benchmark gold patches.

The script must prepare an independent git-archive checkout, index it, show
tool selection and planning metadata, and retain complete MCP/Planner artifacts.
Default execution is rules-only with no external provider. LLM mode requires an
explicit endpoint, or an explicit SSH tunnel configuration. Record no API keys.
Bound subprocess/network waits; clean up only processes created by this script.
Separate the natural task scenario from guided tool diagnostics and clearly
identify session boundaries. Empty results, unsupported graph edges, provider
failures and guarded requests are observations, not task success.

Acceptance:
- [x] Python CLI supports step selection, interactive stepping and rules/LLM comparison.
- [x] Fresh output directories preserve original repositories and previous runs.
- [x] MCP transcripts, raw Planner JSON, tool evidence and a readable summary persist.
- [x] Tests cover framing/EOF, endpoint failure, archive boundaries and reporting.
- [x] A real base-source demo is executed and its observed limitations documented.

No Agent code generation, SDK/device validation, new benchmark batch or automatic
push is part of this debugger task.
