/**
 * Spec 0044 — explore locate contract helpers (Located / Miss / Partial,
 * literal-first demotion of log/toast spines, filename≠declaration hint,
 * depth-fuse exemption for already-located symbols).
 */

import type { ExploreEmission, ExploreCallRecord, ExploreProjectState } from './explore-session-state';
import { inferExploreEvidenceStatus } from './explore-session-state';
import { latestCountedExplore } from './explore-repeat-guard';

export type LocateOutcome = 'located' | 'partial' | 'miss';

/** Marker strings (idempotent checks). */
export const LOCATED_MARKER = '**Located**';
export const MISS_MARKER = '**Miss**';
export const FILENAME_DECL_MISMATCH_MARKER = 'Filename does not match primary declaration';

const LOG_TOAST_NAME_RE =
  /^(?:Logger|Hilog|HiLog|Toast|promptAction|log(?:Info|Error|Warn|Debug|Fatal)?|hilog)$/i;

/** Query explicitly names a log/toast API — then those nodes may stay on the spine. */
export function queryNamesLogOrToast(query: string): boolean {
  return /\b(?:Logger|hilog|HiLog|Toast|promptAction|logInfo|logError|logWarn|logDebug)\b/i.test(query)
    || /日志|弹窗|吐司/.test(query);
}

export function isLogOrToastSpineName(name: string): boolean {
  return LOG_TOAST_NAME_RE.test(name.trim());
}

/** Demote log/toast when the user did not ask for them. */
export function shouldDemoteLogToastSpine(name: string, query: string): boolean {
  return isLogOrToastSpineName(name) && !queryNamesLogOrToast(query);
}

/**
 * Classify locate outcome for explore (Spec 0044 §8–9).
 * Exact anchor / literal witness beats fuzzy-only FTS.
 */
export function classifyLocateOutcome(opts: {
  hasExactAnchorHit: boolean;
  hasLiteralWitness: boolean;
  hasFullDeclarations: boolean;
  missingStaticRelation: boolean;
  budgetPartial: boolean;
}): LocateOutcome {
  if (!opts.hasExactAnchorHit && !opts.hasLiteralWitness) return 'miss';
  if (opts.budgetPartial || opts.missingStaticRelation) return 'partial';
  if (opts.hasFullDeclarations && (opts.hasExactAnchorHit || opts.hasLiteralWitness)) {
    return 'located';
  }
  return 'partial';
}

export function formatLocatedBanner(): string {
  return (
    `> ${LOCATED_MARKER} — exact anchor declaration(s) are in this reply. `
    + 'Reuse them; do **not** Grep the same symbol names again. '
    + 'Runtime behavior may still need validation after edits.'
  );
}

export function formatPartialBanner(): string {
  return (
    '> **Partial** — evidence is incomplete (missing relation or budget). '
    + 'Next: `homegraph_node` / `homegraph_usages` / `homegraph_search` for the named gap — '
    + 'do **not** Grep the same symbol names already shown.'
  );
}

/** Miss: paths only, no source bodies. */
export function formatMissBanner(candidatePaths: readonly string[]): string {
  const paths = candidatePaths
    .map((p) => p.replace(/\\/g, '/').trim())
    .filter(Boolean)
    .slice(0, 12);
  const list = paths.length
    ? paths.map((p) => `- \`${p}\``).join('\n')
    : '- _(no fuzzy path candidates)_';
  return [
    `> ${MISS_MARKER} — no exact in-repo anchor or literal witness. Source bodies omitted.`,
    'Fuzzy candidate paths (no source):',
    list,
    'Next: `homegraph_search` with a more precise symbol, file basename, or quoted UI label.',
  ].join('\n');
}

/**
 * When file basename (sans extension) ≠ primary declaration name.
 * Returns null when names match or inputs are empty.
 */
export function formatFilenameDeclarationMismatch(
  filePath: string,
  primaryDeclName: string | null | undefined,
): string | null {
  if (!primaryDeclName?.trim()) return null;
  const base = filePath.replace(/\\/g, '/').split('/').pop() ?? '';
  const stem = base.replace(/\.[^.]+$/, '');
  if (!stem) return null;
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (norm(stem) === norm(primaryDeclName)) return null;
  return (
    `> ⚠ ${FILENAME_DECL_MISMATCH_MARKER}: file \`${stem}\` vs \`${primaryDeclName.trim()}\` — `
    + 'prefer the declaration name for edits and follow-up queries.'
  );
}

/** Names recorded on the latest counted explore emission. */
export function locatedNamesFromEmission(
  emission: ExploreEmission | ExploreCallRecord | null | undefined,
): string[] {
  if (!emission?.locatedNodes?.length) return [];
  const out = new Set<string>();
  for (const n of emission.locatedNodes) {
    if (n?.name) out.add(n.name);
    if (n?.qualifiedName) {
      out.add(n.qualifiedName);
      const leaf = n.qualifiedName.split(/[.::]/).pop();
      if (leaf) out.add(leaf);
    }
  }
  return [...out];
}

export function symbolMatchesLocatedNames(
  symbol: string | undefined,
  locatedNames: readonly string[],
): boolean {
  const raw = symbol?.trim();
  if (!raw || locatedNames.length === 0) return false;
  const needle = raw.toLowerCase();
  const leaf = needle.split(/[.::]/).pop() ?? needle;
  for (const n of locatedNames) {
    const ln = n.toLowerCase();
    if (ln === needle || ln === leaf) return true;
    if (ln.endsWith(`.${leaf}`) || ln.endsWith(`::${leaf}`)) return true;
  }
  return false;
}

/**
 * Spec 0044 §10.2 — do not depth-fuse-refuse a symbol already present on the
 * latest explore locate list (even after Partial spent its one generic drill).
 */
export function shouldExemptDepthFuseForLocatedSymbol(
  prior: ExploreProjectState | null | undefined,
  symbol: string | undefined,
): boolean {
  const last = latestCountedExplore(prior);
  if (!last) return false;
  // Closed explores already skip the fuse; exemption matters for Partial/Miss.
  if (inferExploreEvidenceStatus(last) === 'complete') return false;
  return symbolMatchesLocatedNames(symbol, locatedNamesFromEmission(last));
}

/** Strip CJK→ASCII synonym seeds when Miss-bound (Spec 0044 §9). */
export function shouldSuppressSynonymExpansion(opts: {
  hasExactAnchorHit: boolean;
  hasLiteralWitness: boolean;
}): boolean {
  return !opts.hasExactAnchorHit && !opts.hasLiteralWitness;
}
