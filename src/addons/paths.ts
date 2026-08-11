/**
 * Path resolution for the repository-level addon store.
 *
 * Layout (next to the spec feature's `commit4spec/` data directory):
 *
 *   <repo>/.homegraph/
 *   ├── addons.json              registry (see ./registry)
 *   ├── addons/                  npm install --prefix target
 *   │   └── node_modules/
 *   │       └── @scope/name/     one directory per installed addon
 *   └── commit4spec/             spec data (SPEC_DATA_DIR)
 *
 * @module addons/paths
 */

import * as path from 'path';
import { getHomeGraphDir } from '../directory';

/** Directory holding all installed addon packages (npm install --prefix target). */
export function addonsRootDir(repoRoot: string): string {
  return path.join(getHomeGraphDir(repoRoot), 'addons');
}

/**
 * Resolve an installed addon package directory from its registry name.
 * Scoped names (`@scope/name`) nest naturally under `node_modules`.
 */
export function addonPkgDir(repoRoot: string, name: string): string {
  return path.join(addonsRootDir(repoRoot), 'node_modules', name);
}
