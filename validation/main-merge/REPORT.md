# Main merge verification

- Target remote: `git@gitcode.com:SMAT/HomeGraph.git`, branch `develop`.
- Integrated main: `2ebe761` (1.5.8 plus current index status / JSON5 changes).
- Build passed.
- 304 distinct tests across 23 files verified. Initial run: 302 passed, two assertions expected retired index-building copy. Updated those assertions to the main contract (`status=fast`) without changing runtime behavior; the full affected 22-test file then passed. Both original and follow-up logs are retained.
- Real ArkAnalyzer/SQLite accuracy smoke passed: appearance-only → `binding_not_observed`; stale index after edit → `unknown`; reindexed direct enabled binding → `binding_observed`.
- Existing directed-path smoke passed with `stopReason=supported`.
- External Headroom 0.37.0 preserved the entire current explore response byte-for-byte; synthetic repeated build logs passed lossless roundtrip.
- CHANGELOG conflict resolved by retaining upstream release history and the new unreleased accuracy entry. Accuracy spec renumbered to 0036 to avoid main's 0031–0035.
- No codingeval changes, model inference experiment, or package release. Generated logs use portable placeholders for local paths.
