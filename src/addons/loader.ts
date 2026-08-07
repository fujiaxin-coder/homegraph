/**
 * Runtime addon loading.
 *
 * Deterministic lookup, never a directory scan: read the registry
 * (`addons.json`), then for each enabled entry resolve its install directory
 * by name and validate + import it. Missing / invalid / disabled entries are
 * skipped with a warning — a broken addon must never break the host flow.
 *
 * @module addons/loader
 */

import * as fs from 'fs';
import * as path from 'path';
import { logWarn } from '../errors';
import { readRegistry } from './registry';
import { addonPkgDir } from './paths';
import { validateAddonPackage } from './validate';
import { LoadedAddon } from './types';

/**
 * Load all enabled, registered addons for a repository, in registry order.
 * Registry order is the deterministic priority order for consumers that need
 * one winner (e.g. `buildPrompt`).
 */
export async function loadAddons(repoRoot: string): Promise<LoadedAddon[]> {
  const registry = readRegistry(repoRoot);
  const out: LoadedAddon[] = [];

  for (const entry of registry.addons) {
    if (!entry.enabled) continue;

    const pkgDir = addonPkgDir(repoRoot, entry.name);
    if (!fs.existsSync(path.join(pkgDir, 'package.json'))) {
      logWarn(`Addon ${entry.name} is registered but not installed — skipping`, {
        repoRoot,
        name: entry.name,
      });
      continue;
    }

    const validation = await validateAddonPackage(pkgDir);
    if (!validation.ok) {
      logWarn(`Addon ${entry.name} failed validation — skipping`, {
        name: entry.name,
        reason: validation.reason,
      });
      continue;
    }

    out.push({
      name: entry.name,
      version: validation.version ?? entry.version,
      module: validation.module!,
    });
  }

  return out;
}
