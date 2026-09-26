// Firmware version comparison.
//
// The update nudge used to be a plain `running !== latest`, which offers an
// "update" whenever the two differ IN EITHER DIRECTION. A signer running
// firmware newer than the bundled manifest — a locally built image, or simply a
// manifest that lags a release — was told to install the older one, and doing
// so silently reverts whatever the newer build fixed. Compare properly and only
// offer a genuine upgrade.

interface ParsedVersion {
  core: number[]
  /** Dot-separated pre-release identifiers, or null when there is no pre-release. */
  prerelease: string[] | null
}

/** Parse "0.14.0" (or "v0.14.0", or "0.14.0-beta.17") into comparable parts, or
 *  null when it is not a version we can reason about. */
function parse(version: string): ParsedVersion | null {
  const cleaned = version.trim().replace(/^v/i, '')
  const [core, ...rest] = cleaned.split('-')
  if (!core || !/^\d+(\.\d+)*$/.test(core)) return null
  // A build-metadata suffix (+...) plays no part in precedence (SemVer 2.0 §10).
  const prereleaseRaw = rest.length > 0 ? rest.join('-').split('+')[0] : null
  return {
    core: core.split('.').map(Number),
    prerelease: prereleaseRaw ? prereleaseRaw.split('.') : null,
  }
}

/** Compare a single pair of pre-release identifiers per SemVer 2.0 §11.4. */
function compareIdentifier(a: string, b: string): number {
  const aNumeric = /^\d+$/.test(a)
  const bNumeric = /^\d+$/.test(b)
  if (aNumeric && bNumeric) return Number(a) - Number(b)
  // Numeric identifiers always have lower precedence than alphanumeric ones.
  if (aNumeric) return -1
  if (bNumeric) return 1
  if (a === b) return 0
  return a < b ? -1 : 1
}

/** Compare two pre-release identifier lists per SemVer 2.0 §11.4. */
function comparePrerelease(a: string[], b: string[]): number {
  const len = Math.max(a.length, b.length)
  for (let i = 0; i < len; i++) {
    if (a[i] === undefined) return -1 // fewer fields: lower precedence
    if (b[i] === undefined) return 1
    const cmp = compareIdentifier(a[i], b[i])
    if (cmp !== 0) return cmp
  }
  return 0
}

/**
 * Compare two version strings. Returns a negative number when `a` is older
 * than `b`, zero when they are equal, positive when `a` is newer. Returns null
 * when either side is unparseable, so callers can decline to act rather than
 * guess.
 *
 * A pre-release has lower precedence than its release (SemVer 2.0 §11):
 * `0.18.0-beta.17` < `0.18.0-beta.19` < `0.18.0`.
 */
export function compareVersions(a: string, b: string): number | null {
  const pa = parse(a)
  const pb = parse(b)
  if (!pa || !pb) return null
  const len = Math.max(pa.core.length, pb.core.length)
  for (let i = 0; i < len; i++) {
    // "0.14" and "0.14.0" are the same version.
    const diff = (pa.core[i] ?? 0) - (pb.core[i] ?? 0)
    if (diff !== 0) return diff
  }
  if (pa.prerelease === null && pb.prerelease === null) return 0
  if (pa.prerelease === null) return 1 // a is a release, b is a pre-release: a is newer
  if (pb.prerelease === null) return -1
  return comparePrerelease(pa.prerelease, pb.prerelease)
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
