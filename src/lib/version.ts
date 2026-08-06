// Firmware version comparison.
//
// The update nudge used to be a plain `running !== latest`, which offers an
// "update" whenever the two differ IN EITHER DIRECTION. A signer running
// firmware newer than the bundled manifest — a locally built image, or simply a
// manifest that lags a release — was told to install the older one, and doing
// so silently reverts whatever the newer build fixed. Compare properly and only
// offer a genuine upgrade.

/** Parse "0.14.0" (or "v0.14.0", or "0.14.0-rc1") into comparable parts, or
 *  null when it is not a version we can reason about. */
function parse(version: string): number[] | null {
  const cleaned = version.trim().replace(/^v/i, '')
  // Pre-release suffixes are dropped for ordering: the numeric release is what
  // the manifest and the device agree on, and treating "0.14.0-rc1" as 0.14.0
  // is closer to right than refusing to compare at all.
  const core = cleaned.split(/[-+]/)[0] ?? ''
  if (!/^\d+(\.\d+)*$/.test(core)) return null
  return core.split('.').map(Number)
}

/**
 * Compare two version strings. Returns a negative number when `a` is older
 * than `b`, zero when they are equal, positive when `a` is newer. Returns null
 * when either side is unparseable, so callers can decline to act rather than
 * guess.
 */
export function compareVersions(a: string, b: string): number | null {
  const pa = parse(a)
  const pb = parse(b)
  if (!pa || !pb) return null
  const len = Math.max(pa.length, pb.length)
  for (let i = 0; i < len; i++) {
    // "0.14" and "0.14.0" are the same version.
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (diff !== 0) return diff
  }
  return 0
}

/**
 * Whether `candidate` is a genuine upgrade over `running`.
 *
 * False when they match, when the candidate is older, and when either cannot be
 * parsed. Declining on unparseable input is deliberate: a nudge that cannot be
 * justified should not appear, and the manual picker still exists.
 */
export function isUpgrade(running: string | null, candidate: string | null): boolean {
  if (!running || !candidate) return false
  const cmp = compareVersions(candidate, running)
  return cmp !== null && cmp > 0
}
