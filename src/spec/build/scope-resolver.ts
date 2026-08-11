/**
 * Commit message scope parsing and resolution.
 *
 * Replaces `commit4spec/reverse_engineer/scope_resolver.py`.
 * Extracts conventional-commit scopes, normalizes them, and resolves them to
 * spec IDs found on disk.
 *
 * @module spec/build/scope-resolver
 */

import { SpecConfig } from '../config';
import { logDebug } from '../../errors';

// ---------------------------------------------------------------------------
// extractScope
// ---------------------------------------------------------------------------

/**
 * Extract a scope from a commit message using the configured regex.
 *
 * Only searches the **first line** of the commit message.  Returns the
 * contents of the first capture group (the scope), or `null` when there is
 * no match or the regex has no capture group.
 */
export function extractScope(message: string, scopeRegex: string): string | null {
  const firstLine = message.split('\n', 1)[0] ?? '';
  let regex: RegExp;
  try {
    regex = new RegExp(scopeRegex);
  } catch {
    logDebug('extractScope: invalid regex from config, returning null', {
      scopeRegex,
    });
    return null;
  }
  const match = regex.exec(firstLine);

  if (match && match[1] !== undefined) {
    return match[1];
  }

  return null;
}

/**
 * Extract a spec reference from the commit message BODY (all lines after
 * the first). Opt-in second channel used only when `commitScope.bodyRegex`
 * is configured and the title channel missed.
 *
 * Each body line is trimmed so `^`/`$` anchors behave on CRLF commits.
 * Returns the contents of the first capture group, or `null` when there is
 * no match, the regex has no capture group, or the regex is invalid.
 */
export function extractBodyScope(message: string, bodyRegex: string): string | null {
  const body = message
    .split('\n')
    .slice(1)
    .map((line) => line.trim())
    .join('\n');
  if (!body) return null;

  let regex: RegExp;
  try {
    regex = new RegExp(bodyRegex, 'm');
  } catch {
    logDebug('extractBodyScope: invalid regex from config, returning null', {
      bodyRegex,
    });
    return null;
  }
  const match = regex.exec(body);

  if (match && match[1] !== undefined) {
    return match[1];
  }

  return null;
}

// ---------------------------------------------------------------------------
// normalizeScope
// ---------------------------------------------------------------------------

/**
 * Normalize a scope string.
 *
 * Steps applied in order:
 *
 * 1. **Strip prefixes** — for each prefix in `stripPrefixes`, if `scope`
 *    starts with it, remove it and stop (only the first matching prefix is
 *    stripped).
 * 2. **Lowercase** — if `lowercase` is `true`, convert to lower case.
 * 3. **Pad spec number** — if `padSpecNumber` is `true`, match the pattern
 *    `/^spec(\d+)$/i` and zero-pad the numeric portion to 2 digits
 *    (e.g. `spec3` → `spec03`).
 */
export function normalizeScope(
  scope: string,
  config: { stripPrefixes: string[]; lowercase: boolean; padSpecNumber: boolean },
): string {
  let normalized = scope;

  // Step 1: strip the first matching prefix
  for (const prefix of config.stripPrefixes) {
    if (normalized.startsWith(prefix)) {
      normalized = normalized.slice(prefix.length);
      break;
    }
  }

  // Step 2: lowercase
  if (config.lowercase) {
    normalized = normalized.toLowerCase();
  }

  // Step 3: pad spec number (e.g. spec3 → spec03)
  if (config.padSpecNumber) {
    const m = /^spec(\d+)$/i.exec(normalized);
    if (m && m[1] !== undefined) {
      normalized = `spec${m[1].padStart(2, '0')}`;
    }
  }

  return normalized;
}

// ---------------------------------------------------------------------------
// resolveScopeToSpec
// ---------------------------------------------------------------------------

/**
 * Resolve a commit message to a spec ID, if possible.
 *
 * Two channels are tried, each completing the full extract → normalize →
 * on-disk-existence cycle independently:
 *
 * 1. **Title** — conventional-commit scope on the first line. When it
 *    resolves to an existing spec it wins outright (the body is never
 *    consulted).
 * 2. **Body (opt-in)** — a `bodyRegex` footer/trailer reference, consulted
 *    when the title channel produces no scope, or a scope that does not
 *    resolve to an existing spec on disk.
 *
 * @param message - Full commit message (first line + body).
 * @param specIds - Known spec IDs (from `discoverSpecs`, hoisted by the
 *   caller so scanning N commits does not re-read the directory N times).
 * @param config  - Spec configuration (commitScope section).
 *
 * Returns the normalized spec ID when either channel resolves to an existing
 * spec, otherwise `null`.
 */
export function resolveScopeToSpec(
  message: string,
  specIds: Set<string>,
  config: SpecConfig,
): string | null {
  const normalize = config.commitScope.normalize;
  const resolve = (scope: string): string | null => {
    // Guard: normalize is user-configurable and may be absent — without it
    // the raw scope is used as-is.
    const normalized = normalize ? normalizeScope(scope, normalize) : scope;
    return specIds.has(normalized) ? normalized : null;
  };

  // Channel 1: conventional-commit scope on the first line. A title scope
  // that resolves to an existing on-disk spec wins outright.
  const titleScope = extractScope(message, config.commitScope.scopeRegex);
  if (titleScope) {
    const hit = resolve(titleScope);
    if (hit) return hit;
    // Title scope present but does not exist on disk — fall through to the
    // opt-in body channel instead of failing the whole resolution.
  }

  // Channel 2 (opt-in): a body/footer reference (e.g. a "Spec: spec03"
  // trailer). Consulted when the title channel is absent OR fails the
  // on-disk existence check.
  if (config.commitScope.bodyRegex) {
    const bodyScope = extractBodyScope(message, config.commitScope.bodyRegex);
    if (bodyScope) {
      const hit = resolve(bodyScope);
      if (hit) return hit;
    }
  }

  return null;
}
