/**
 * Tiny semver-ish comparator. Returns:
 *    1  if a > b
 *    0  if a == b
 *   -1  if a < b
 *
 * Tolerates "1.0", "1.0.0", "v1.0.0", "1.0.0-beta" by stripping the
 * non-numeric tail. We don't need full semver semantics — just enough
 * to drive the force-update modal off `min_supported_app_version`.
 */
export function compareVersions(a, b) {
  const parse = (v) => String(v || '0')
    .replace(/^v/i, '')
    .split(/[-+]/)[0]
    .split('.')
    .map((x) => parseInt(x, 10) || 0);

  const pa = parse(a);
  const pb = parse(b);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const xa = pa[i] || 0;
    const xb = pb[i] || 0;
    if (xa > xb) return 1;
    if (xa < xb) return -1;
  }
  return 0;
}

/** Convenience: true when `version` is older than `min`. */
export function isBelowMin(version, min) {
  return compareVersions(version, min) < 0;
}