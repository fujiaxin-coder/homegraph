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
 * Extract a scope from a commit message, normalize it, then check whether the
 * resulting spec ID exists among the known on-disk spec IDs.
 *
 * @param message - Commit message (only the first line is searched).
 * @param specIds - Known spec IDs (from `discoverSpecs`, hoisted by the
 *   caller so scanning N commits does not re-read the directory N times).
 * @param config  - Spec configuration (commitScope section).
 *
 * Returns the normalized spec ID when the scope resolves to an existing spec,
 * otherwise `null`.
 */
export function resolveScopeToSpec(
  message: string,
  specIds: Set<string>,
  config: SpecConfig,
): string | null {
  const scope = extractScope(message, config.commitScope.scopeRegex);
  if (!scope) {
    return null;
  }

  const normalized = normalizeScope(scope, config.commitScope.normalize);

  return specIds.has(normalized) ? normalized : null;
}
