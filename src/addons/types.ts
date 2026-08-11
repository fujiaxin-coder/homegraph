/**
 * HomeGraph addon registry types.
 *
 * The addon registry is repository-level state stored in
 * `${getHomeGraphDir(repoRoot)}/addons.json`. The loader only ever loads
 * addons that are explicitly registered AND enabled — scanning installed
 * packages is deliberately unsupported (an addon is executable code; loading
 * it requires an explicit user action).
 *
 * @module addons/types
 */

/** A single registered addon entry in `addons.json`. */
export interface AddonRegistryEntry {
  /**
   * npm package name — the registry primary key
   * (e.g. `"@scope/homegraph-jira"`).
   */
  name: string;
  /**
   * Concrete version resolved at install time — never a range, so the
   * registry stays reproducible and audit-friendly.
   */
  version: string;
  /** Whether the addon is loaded at runtime. */
  enabled: boolean;
  /**
   * Where the package was installed from. Drives the install version gate
   * (a local path is re-pointed by npm, never downgraded by us) and
   * `update --latest` (registry packages only — local paths have no dist-tag).
   */
  source: 'registry' | 'local';
}

/** Shape of the repository-level addon registry file. */
export interface AddonRegistry {
  addons: AddonRegistryEntry[];
}

/**
 * An addon that passed validation and was loaded at runtime. Consumers
 * filter by export shape (e.g. spec-mine looks for `enrich`/`buildPrompt`);
 * the generic layer does not know about any specific hook.
 */
export interface LoadedAddon {
  name: string;
  version: string;
  /**
   * Module namespace. A `default` export is merged into the namespace so
   * both `export default { ... }` and named exports work.
   */
  module: Record<string, unknown>;
}
