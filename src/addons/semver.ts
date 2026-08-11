/**
 * Minimal semver comparison for addon version gating.
 *
 * HomeGraph deliberately does not depend on a semver library: the versions
 * compared here always come from npm (`npm view`) or a package.json that
 * `validateAddonPackage` already accepted, so they are well-formed semver.
 * Only the comparisons needed for the install gate (`<`, `=`, `>`) are
 * implemented — no ranges, no coercion, no build-metadata significance.
 *
 * @module addons/semver
 */

/** x.y.z with optional prerelease and build metadata (build metadata ignored). */
const SEMVER_RE =
  /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

/**
 * Compare prerelease identifiers (semver §11.4).
 *
 * `undefined` (no prerelease) sorts after any prerelease: `1.0.0 > 1.0.0-alpha`.
 * Numeric identifiers compare numerically, alphanumeric compare ASCII, and
 * numeric < alphanumeric. A shorter list sorts first when otherwise equal.
 */
function comparePrerelease(a: string | undefined, b: string | undefined): number {
  if (a === undefined && b === undefined) return 0;
  if (a === undefined) return 1;
  if (b === undefined) return -1;

  const as = a.split('.');
  const bs = b.split('.');
  const len = Math.max(as.length, bs.length);
  for (let i = 0; i < len; i++) {
    const x = as[i];
    const y = bs[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;

    const xn = /^\d+$/.test(x);
    const yn = /^\d+$/.test(y);
    if (xn && yn) {
      const nx = parseInt(x, 10);
      const ny = parseInt(y, 10);
      if (nx !== ny) return nx < ny ? -1 : 1;
    } else {
      if (xn !== yn) return xn ? -1 : 1;
      if (x !== y) return x < y ? -1 : 1;
    }
  }
  return 0;
}

/**
 * Compare two semver strings: negative when `a < b`, zero when equal,
 * positive when `a > b`. Build metadata (`+...`) is ignored.
 *
 * A version that does not parse as semver compares equal to anything
 * (returns 0) — callers treat an unparseable version conservatively as
 * "not a downgrade" rather than refusing the install.
 */
export function compareSemver(a: string, b: string): number {
  const ma = SEMVER_RE.exec(a.trim());
  const mb = SEMVER_RE.exec(b.trim());
  if (!ma || !mb) return 0;

  for (let i = 1; i <= 3; i++) {
    const x = parseInt(ma[i]!, 10);
    const y = parseInt(mb[i]!, 10);
    if (x !== y) return x < y ? -1 : 1;
  }
  return comparePrerelease(ma[4], mb[4]);
}
