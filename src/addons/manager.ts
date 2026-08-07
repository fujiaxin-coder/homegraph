/**
 * Addon install management (npm as the install engine).
 *
 * `npm install --prefix <addonsRoot>` handles all package mechanics —
 * resolution, integrity, transitive dependencies, local paths, git URLs —
 * so HomeGraph never reimplements package resolution. The registry records
 * the concrete resolved version (never the requested range) to prevent
 * silent drift.
 *
 * @module addons/manager
 */

import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { logWarn } from '../errors';
import { addonsRootDir, addonPkgDir } from './paths';
import { readRegistry, upsertEntry, removeEntry } from './registry';
import { validateAddonPackage } from './validate';
import { AddonRegistryEntry } from './types';

/** Result of a successful install. */
export interface InstallResult {
  name: string;
  version: string;
}

/** Options for `installAddon`. */
export interface InstallOptions {
  /** Whether the new entry starts enabled (default true). */
  enable: boolean;
  /** Pre-resolved package name (from `npm view`/local package.json). */
  name?: string;
}

function runNpm(args: string[]): string {
  return execFileSync('npm', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

/**
 * Resolve the npm package name for an install spec, or `null` when it cannot
 * be determined without running the install itself (e.g. git URLs).
 *
 * - Local paths (`./x`, `../x`, absolute, `file:`) → read package.json.
 * - Everything else (names, scoped names, ranges, dist-tags) → `npm view`.
 */
export function resolvePackageName(pkgSpec: string): string | null {
  const spec = pkgSpec.trim();

  const local =
    spec.startsWith('./') ||
    spec.startsWith('../') ||
    spec.startsWith('/') ||
    spec.startsWith('file:');

  if (local) {
    const dir = spec.startsWith('file:') ? spec.slice('file:'.length) : spec;
    try {
      const pkg = JSON.parse(
        fs.readFileSync(path.join(path.resolve(dir), 'package.json'), 'utf-8'),
      ) as { name?: unknown };
      if (typeof pkg.name === 'string' && pkg.name.length > 0) return pkg.name;
    } catch {
      // Fall through to npm view for the error path.
    }
  }

  try {
    const out = runNpm(['view', spec, 'name', '--json']);
    const parsed: unknown = JSON.parse(out.trim());
    if (typeof parsed === 'string' && parsed.length > 0) return parsed;
  } catch {
    return null;
  }
  return null;
}

/**
 * List top-level packages currently installed in the addons store
 * (`node_modules` one level deep, scoped packages two levels).
 */
function listTopLevelPackages(addonsRoot: string): Set<string> {
  const out = new Set<string>();
  const nodeModules = path.join(addonsRoot, 'node_modules');
  if (!fs.existsSync(nodeModules)) return out;

  for (const entry of fs.readdirSync(nodeModules)) {
    if (entry.startsWith('@')) {
      const scopedDir = path.join(nodeModules, entry);
      let stat: fs.Stats;
      try {
        stat = fs.statSync(scopedDir);
      } catch {
        continue;
      }
      if (!stat.isDirectory()) continue;
      for (const sub of fs.readdirSync(scopedDir)) {
        out.add(`${entry}/${sub}`);
      }
    } else {
      out.add(entry);
    }
  }
  return out;
}

/**
 * Install an addon package and register it.
 *
 * Throws on failure (npm error, invalid addon, unresolvable name); the
 * registry is written only after validation succeeds, and a failed install
 * is rolled back so nothing half-installed lingers.
 */
export async function installAddon(
  repoRoot: string,
  pkgSpec: string,
  options: InstallOptions,
): Promise<InstallResult> {
  const addonsRoot = addonsRootDir(repoRoot);
  fs.mkdirSync(addonsRoot, { recursive: true });

  let name = options.name ?? resolvePackageName(pkgSpec);
  if (!name) {
    // Last resort: snapshot before/after and diff the top-level packages.
    const before = listTopLevelPackages(addonsRoot);
    runNpm(['install', '--prefix', addonsRoot, '--no-audit', '--no-fund', pkgSpec]);
    const added = [...listTopLevelPackages(addonsRoot)].filter((p) => !before.has(p));
    if (added.length !== 1) {
      throw new Error(
        `Cannot resolve the installed package name for "${pkgSpec}" ` +
          `(${added.length} new package(s) detected). Install by name or a local path.`,
      );
    }
    name = added[0]!;
  } else {
    runNpm(['install', '--prefix', addonsRoot, '--no-audit', '--no-fund', pkgSpec]);
  }

  const pkgDir = addonPkgDir(repoRoot, name);
  const validation = await validateAddonPackage(pkgDir);
  if (!validation.ok) {
    // Roll back: do not register something that would fail at load time.
    try {
      runNpm(['uninstall', '--prefix', addonsRoot, '--no-audit', '--no-fund', name]);
    } catch {
      // Best effort — the unregistered files are inert (never loaded).
    }
    throw new Error(`Installed package is not a valid HomeGraph addon: ${validation.reason}`);
  }

  const version = validation.version!;
  upsertEntry(repoRoot, { name, version, enabled: options.enable });
  return { name, version };
}

/**
 * Unregister an addon, optionally deleting its files. Returns `false` when
 * the name was not registered.
 */
export function removeAddon(
  repoRoot: string,
  name: string,
  options: { purge: boolean },
): boolean {
  const removed = removeEntry(repoRoot, name);
  if (!removed) return false;

  if (options.purge) {
    try {
      runNpm(['uninstall', '--prefix', addonsRootDir(repoRoot), '--no-audit', '--no-fund', name]);
    } catch (err) {
      logWarn(`Failed to purge addon files for ${name}`, {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return true;
}

/**
 * List registered addons with their on-disk status (installed vs missing).
 */
export function listAddons(
  repoRoot: string,
): Array<AddonRegistryEntry & { installed: boolean }> {
  const registry = readRegistry(repoRoot);
  return registry.addons.map((entry) => ({
    ...entry,
    installed: fs.existsSync(
      path.join(addonPkgDir(repoRoot, entry.name), 'package.json'),
    ),
  }));
}

/**
 * Update registered addon(s) to the latest version within the configured
 * range (re-running `npm install` on the registered name, then recording the
 * newly resolved version). Returns the names that were updated.
 */
export async function updateAddon(
  repoRoot: string,
  name?: string,
): Promise<string[]> {
  const registry = readRegistry(repoRoot);
  const targets = name
    ? registry.addons.filter((e) => e.name === name)
    : registry.addons;

  if (name && targets.length === 0) {
    throw new Error(`Addon not registered: ${name}`);
  }
  if (targets.length === 0) return [];

  const addonsRoot = addonsRootDir(repoRoot);
  fs.mkdirSync(addonsRoot, { recursive: true });

  const updated: string[] = [];
  for (const entry of targets) {
    runNpm(['install', '--prefix', addonsRoot, '--no-audit', '--no-fund', entry.name]);
    const validation = await validateAddonPackage(addonPkgDir(repoRoot, entry.name));
    if (!validation.ok) {
      logWarn(`Addon ${entry.name} failed validation after update — keeping previous version`, {
        reason: validation.reason,
      });
      continue;
    }
    upsertEntry(repoRoot, { ...entry, version: validation.version ?? entry.version });
    updated.push(entry.name);
  }
  return updated;
}
