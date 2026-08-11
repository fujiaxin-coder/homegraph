/**
 * Addon package validation.
 *
 * An addon package must:
 *   1. have a parseable `package.json`,
 *   2. declare `"homegraph": { "addon": true, "api": 1 }` (contract version),
 *   3. resolve to a loadable entry point (exports / main / index.js),
 *   4. export `enrich` or `buildPrompt` (at least one).
 *
 * Used both at install time (fail fast, before registering) and at runtime
 * (skip with a warning, never crash the host flow).
 *
 * @module addons/validate
 */

import * as fs from 'fs';
import * as path from 'path';
import { pathToFileURL } from 'url';
import { importESM } from './dynamic-import';

/** Result of validating an installed addon package. */
export interface AddonValidation {
  ok: boolean;
  /** Human-readable reason when `ok` is false. */
  reason?: string;
  /** Package version from package.json (set when `ok`). */
  version?: string;
  /** Resolved entry point relative to the package dir (set when `ok`). */
  entryPoint?: string;
  /** Loaded module namespace (set when `ok`). */
  module?: Record<string, unknown>;
}

/**
 * Resolve the addon entry point from package.json:
 * `exports` (string | { "." | "import" | "default" | nested conditions })
 * → `main` → `index.js`.
 */
export function resolveEntryPoint(pkg: unknown): string | null {
  if (!pkg || typeof pkg !== 'object') return null;
  const p = pkg as Record<string, unknown>;

  const isNonEmptyString = (v: unknown): v is string =>
    typeof v === 'string' && v.length > 0;

  const exports = p.exports;
  if (isNonEmptyString(exports)) return exports;
  if (exports && typeof exports === 'object') {
    const ex = exports as Record<string, unknown>;
    const direct = ex['.'] ?? ex['import'] ?? ex['default'];
    if (isNonEmptyString(direct)) return direct;
    // Nested condition form: { ".": { "import": ..., "default": ... } }
    if (direct && typeof direct === 'object') {
      const conditions = direct as Record<string, unknown>;
      const nested = conditions['import'] ?? conditions['default'] ?? conditions['require'];
      if (isNonEmptyString(nested)) return nested;
    }
  }
  if (isNonEmptyString(p.main)) return p.main;
  return 'index.js';
}

/**
 * Validate an installed addon package directory. Async because validation
 * loads the module (which also double-checks the export shape).
 */
export async function validateAddonPackage(
  pkgDir: string,
): Promise<AddonValidation> {
  const pkgJsonPath = path.join(pkgDir, 'package.json');

  let raw: string;
  try {
    raw = fs.readFileSync(pkgJsonPath, 'utf-8');
  } catch {
    return { ok: false, reason: 'package.json not found' };
  }

  let pkg: unknown;
  try {
    pkg = JSON.parse(raw);
  } catch (err) {
    return {
      ok: false,
      reason: `package.json is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  if (!pkg || typeof pkg !== 'object') {
    return { ok: false, reason: 'package.json is not a JSON object' };
  }
  const p = pkg as Record<string, unknown>;
  const marker = p.homegraph as Record<string, unknown> | undefined;
  if (!marker || marker.addon !== true) {
    return {
      ok: false,
      reason: 'not a HomeGraph addon (missing "homegraph": { "addon": true })',
    };
  }
  if (marker.api !== 1) {
    return {
      ok: false,
      reason: `incompatible addon API version ${JSON.stringify(marker.api)} (expected 1)`,
    };
  }

  const entryPoint = resolveEntryPoint(pkg);
  if (!entryPoint) {
    return { ok: false, reason: 'cannot resolve entry point (no exports/main)' };
  }
  const entryPath = path.join(pkgDir, entryPoint);
  if (!fs.existsSync(entryPath)) {
    return { ok: false, reason: `entry point not found: ${entryPoint}` };
  }

  let module: Record<string, unknown>;
  try {
    // Absolute-path import: the CLI is installed globally, so a bare
    // specifier would resolve against HomeGraph's own node_modules and
    // never find the repository-local addon.
    const imported = await importESM(pathToFileURL(entryPath).href);
    const defaultExport = imported.default;
    module =
      defaultExport && typeof defaultExport === 'object'
        ? { ...imported, ...(defaultExport as Record<string, unknown>) }
        : { ...imported };
  } catch (err) {
    return {
      ok: false,
      reason: `failed to load entry point: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  if (typeof module.enrich !== 'function' && typeof module.buildPrompt !== 'function') {
    return {
      ok: false,
      reason: 'addon exports neither enrich nor buildPrompt',
    };
  }

  return {
    ok: true,
    version: typeof p.version === 'string' ? p.version : '0.0.0',
    entryPoint,
    module,
  };
}
