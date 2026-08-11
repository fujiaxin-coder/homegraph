/**
 * Generated-file detection for symbol-disambiguation down-ranking.
 *
 * When a query like "Send" matches 17 symbols across protobuf scaffolding,
 * test mocks, and the hand-written implementation, the FTS ranker often
 * surfaces the generated stubs first because their names are identical
 * to the implementation's name (validated empirically on cosmos-sdk —
 * see project_go_multi_module_audit memory). Generated stubs frequently
 * have no body to trace from, so the agent ends up reading source anyway.
 *
 * This is a relevance hint consulted at disambiguation time (findSymbol /
 * findAllSymbols / explore ranking / homegraph_search formatting), NOT a
 * hard filter — generated nodes are still in the graph and remain
 * reachable; they just rank LAST when there's a real implementation with
 * the same name.
 *
 * Two signals, deliberately separate:
 *
 *  1. {@link isGeneratedFile} — PATH only, pure and synchronous. Most
 *     generated files follow the `<basename>.<tool>.<ext>` convention
 *     (`.pb.go`, `_grpc.pb.go`, `.g.dart`, `_pb2.py`). Free to call
 *     anywhere, including in a sort comparator.
 *
 *  2. {@link hasGeneratedHeader} — CONTENT banner in the file's head. Go's
 *     own convention is a content marker, not a filename one, so a
 *     generated `payroll.go` sitting beside hand-written use-cases is
 *     invisible to (1). Evaluated ONCE at index time (the file's content
 *     is already in memory for parsing) and persisted on the file record
 *     as `files.generated`; readers get it from the DB rather than
 *     re-reading headers per request. See GENERATED_CONTENT_PATTERNS
 *     below for the banners recognized.
 *
 * Consumers that have a bounded candidate list should union the DB flag
 * with the path-only check so both signals apply; the path-only check
 * remains the fallback for callers with no database in hand and for
 * indexes built before the flag existed.
 *
 * NOTE for future editors: the banner literals quoted in this file sit
 * BELOW the header window this detector scans, so the module does not
 * classify itself. `generated-detection.test.ts` pins that — if you move
 * the pattern table upward, the test fails rather than the repo silently
 * demoting its own file.
 */

const GENERATED_PATTERNS: ReadonlyArray<RegExp> = [
  // Go — protobuf / gRPC / pulsar
  /\.pb\.go$/,
  /\.pulsar\.go$/,
  /_grpc\.pb\.go$/,
  // Go — mockgen output. Default emits `mock_<src>.go`; many projects
  // (cosmos-sdk uses `expected_*_mocks.go`) rename to `*_mock.go` /
  // `*_mocks.go`. Matching either suffix catches both conventions
  // without false-positive risk on hand-written sources.
  /_mock\.go$/,
  /_mocks\.go$/,
  /^mock_[^/]+\.go$/,
  // TypeScript / JavaScript — common codegen suffixes (Apollo / GraphQL
  // codegen, Prisma, Hasura, ts-proto, gRPC-web, swagger-codegen).
  /\.generated\.[jt]sx?$/,
  /\.gen\.[jt]sx?$/,
  /\.pb\.[jt]s$/,
  /_pb\.[jt]s$/,
  /_grpc_pb\.[jt]s$/,
  // Minified bundles vendored into a repo (docs sites, examples).
  /\.min\.m?js$/,
  // Python — protobuf / gRPC / openapi-codegen
  /_pb2(_grpc)?\.py$/,
  /_pb2\.pyi$/,
  // C++ — protobuf
  /\.pb\.(cc|h)$/,
  // C# — protobuf / gRPC
  /\.g\.cs$/,
  /Grpc\.cs$/,
  // Java — protobuf / gRPC
  /OuterClass\.java$/,
  /Grpc\.java$/,
  // Swift — protobuf
  /\.pb\.swift$/,
  // Dart — build_runner / freezed / json_serializable / chopper
  /\.g\.dart$/,
  /\.freezed\.dart$/,
  /\.pb\.dart$/,
  /\.pbgrpc\.dart$/,
  /\.chopper\.dart$/,
  // Rust — in-tree generated files often use `*.generated.rs`.
  /\.generated\.rs$/,
];

/**
 * Whether `filePath` looks like a tool-generated source file based on
 * its filename. Path-only — does not read content. The result is a
 * relevance hint for disambiguation, not a hard claim.
 */
export function isGeneratedFile(filePath: string): boolean {
  return GENERATED_PATTERNS.some((p) => p.test(filePath));
}

// =============================================================================
// Content-header detection (#1500)
// =============================================================================

/**
 * How much of a file's head to consider "the header". Generous enough for a
 * build-tag block + an Apache-2.0 license preamble (~15 lines) sitting above
 * the banner, tight enough that a `"// Code generated ... DO NOT EDIT."`
 * string constant in the *body* of a code generator's own source can't
 * masquerade as a banner.
 */
const HEADER_SCAN_CHARS = 8192;
const HEADER_SCAN_LINES = 60;

/**
 * Cheap pre-filter run on the header of EVERY indexed file. Every marker
 * below contains the stem "generat", so one unanchored scan rejects ~all
 * hand-written source before any line splitting happens.
 */
const GENERATED_STEM = /generat/i;

/**
 * Line-comment leaders across the languages we index. A banner must sit on a
 * comment line (or inside an open block comment, tracked below).
 */
const COMMENT_LEADER =
  /^\s*(?:\/\/|\/\*+|\*+\/?|#+|--+|<!--|%+|;+|'|!|\(\*|\{-|"""|'''|=begin|<#|@rem\b|rem\b)/i;

/**
 * Openers/closers for block comments, so a banner on an unprefixed line
 * inside `/* … *\/` (or `<!-- … -->`, or a Python module docstring) still
 * counts.
 */
const BLOCK_DELIMS: ReadonlyArray<{ open: string; close: string }> = [
  { open: '/*', close: '*/' },
  { open: '<!--', close: '-->' },
  { open: '"""', close: '"""' },
  { open: "'''", close: "'''" },
  { open: '=begin', close: '=end' },
  { open: '<#', close: '#>' },
];

/**
 * The banners themselves. Precision-first — a false positive silently
 * demotes hand-written code in every ranking path.
 */
const GENERATED_CONTENT_PATTERNS: ReadonlyArray<RegExp> = [
  // Go's codified convention — `// Code generated … DO NOT EDIT.`
  /\bcode generated\b.{0,200}?\bdo not edit\b/i,
  // protoc / ANTLR / Dagger / FlatBuffers / rust-bindgen / …
  /\b(?:automatically |auto[- ]?)?generated (?:by|from|with)\b.{0,200}?\bdo not (?:edit|modify|change)\b/i,
  // `@generated` (Relay, GraphQL codegen, protobuf-es/Buf, …)
  /(?:^|[^\p{L}\p{N}_@])@generated\b/u,
  // .NET `<auto-generated>` / `<auto-generated />`
  /<auto-?generated\s*\/?>/i,
  // swagger-codegen / OpenAPI Generator / Thrift / FlatBuffers
  /\b(?:automatically generated|auto[- ]?generated|autogenerated) by\b/i,
  // Wrangler-style: "Generated by <tool> by running …"
  /\bgenerated by\s+\S.{0,80}?\bby running\b/i,
  // Self-declaring in-house banners
  /\bthis (?:file|class|code|module) (?:is|was) (?:auto[- ]?)?generated\b/i,
  // Reverse ordering: "DO NOT EDIT — this is a generated file"
  /\bdo not (?:edit|modify)\b.{0,120}?\b(?:auto[- ]?generated|generated file|generated code)\b/i,
];

/**
 * Whether the head of `content` carries a recognized machine-generation
 * banner. Bounded to {@link HEADER_SCAN_CHARS} / {@link HEADER_SCAN_LINES},
 * and the marker must sit on a comment line.
 */
export function hasGeneratedHeader(content: string): boolean {
  if (!content) return false;

  const head = content.length > HEADER_SCAN_CHARS ? content.slice(0, HEADER_SCAN_CHARS) : content;
  if (!GENERATED_STEM.test(head)) return false;

  const lines = head.split('\n');
  const limit = Math.min(lines.length, HEADER_SCAN_LINES);
  let openBlock: (typeof BLOCK_DELIMS)[number] | null = null;

  for (let i = 0; i < limit; i++) {
    const line = lines[i]!;
    const inBlock = openBlock !== null;

    if (inBlock || COMMENT_LEADER.test(line)) {
      for (const pattern of GENERATED_CONTENT_PATTERNS) {
        if (pattern.test(line)) return true;
      }
    }

    if (openBlock) {
      if (line.includes(openBlock.close)) openBlock = null;
      continue;
    }
    for (const delim of BLOCK_DELIMS) {
      const at = line.indexOf(delim.open);
      if (at < 0) continue;
      if (line.indexOf(delim.close, at + delim.open.length) < 0) openBlock = delim;
      break;
    }
  }

  return false;
}

/**
 * The union signal: path convention OR content banner. Persisted to
 * `files.generated` at index time.
 */
export function detectGeneratedFile(filePath: string, content: string): boolean {
  return isGeneratedFile(filePath) || hasGeneratedHeader(content);
}
