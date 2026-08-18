/**
 * Node.js version compatibility check.
 *
 * Enforces the supported floor (see {@link MIN_NODE_MAJOR}). Kept side-effect-free
 * so it's safe to import from tests without triggering CLI bootstrap.
 *
 * Node ≥22 can hit a V8 turboshaft WASM JIT Zone OOM when compiling tree-sitter
 * grammars; that is mitigated by `--liftoff-only` relaunch (see
 * ../extraction/wasm-runtime-flags.ts), not by blocking majors.
 */

/**
 * Lowest supported Node.js major version. Matches the `engines` floor in
 * package.json. Below this, HomeGraph relies on language features / native APIs
 * that aren't present, and the combination is untested. `engines` alone only
 * *warns* on install (unless the user set `engine-strict`), so the CLI bootstrap
 * also hard-blocks here to actually enforce the floor.
 */
export const MIN_NODE_MAJOR = 22;

/**
 * Build the bordered banner shown when HomeGraph detects a Node.js major below
 * {@link MIN_NODE_MAJOR}. Pinned via unit test so the recovery commands and the
 * override env var can't be silently stripped by future edits.
 *
 * Uses ASCII glyphs to stay readable on Windows OEM-codepage consoles
 * (see ../ui/glyphs.ts for the rationale).
 */
export function buildNodeTooOldBanner(nodeVersion: string): string {
  const sep = '-'.repeat(72);
  return [
    sep,
    `[HomeGraph] Unsupported Node.js version: ${nodeVersion}`,
    sep,
    `HomeGraph requires Node.js ${MIN_NODE_MAJOR} or newer. Older versions lack`,
    'language features and native APIs HomeGraph depends on, and are not',
    'tested or supported.',
    '',
    'Fix: install Node.js 22 LTS:',
    '  nvm install 22 && nvm use 22                          # nvm',
    '  brew install node@22 && brew link --overwrite --force node@22  # Homebrew',
    '',
    'To override (NOT recommended - unsupported; for majors below the floor only):',
    '  HOMEGRAPH_ALLOW_UNSAFE_NODE=1 homegraph ...',
    sep,
  ].join('\n');
}
