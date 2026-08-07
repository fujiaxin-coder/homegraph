/**
 * Dynamic ESM import for CJS builds.
 *
 * tsc compiles `import()` to `require()` under `module: commonjs`, which
 * fails for ESM-only addon packages. `new Function` bypasses the transform
 * and works in the production CLI (plain CJS Node). Some host contexts
 * (e.g. vitest worker realms) have no dynamic-import callback on
 * Function-created globals — tests mock this module with a plain
 * module-scope `import()`, which works there.
 *
 * @module addons/dynamic-import
 */

// eslint-disable-next-line @typescript-eslint/no-implied-eval
const importViaFunction = new Function('specifier', 'return import(specifier)') as (
  specifier: string,
) => Promise<Record<string, unknown>>;

/**
 * Import an ESM module by specifier. For addons the specifier is an
 * absolute `file://` URL of the resolved entry point.
 */
export function importESM(specifier: string): Promise<Record<string, unknown>> {
  return importViaFunction(specifier);
}
