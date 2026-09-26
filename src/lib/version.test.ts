import { describe, it, expect } from 'vitest'
import { compareVersions, isUpgrade } from './version.js'

describe('compareVersions', () => {
  it('orders by each numeric component', () => {
    expect(compareVersions('0.14.0', '0.13.9')).toBeGreaterThan(0)
    expect(compareVersions('0.13.9', '0.14.0')).toBeLessThan(0)
    expect(compareVersions('1.0.0', '0.99.99')).toBeGreaterThan(0)
    // Not a string comparison: 10 > 9 even though "10" sorts before "9".
    expect(compareVersions('0.10.0', '0.9.0')).toBeGreaterThan(0)
  })

  it('treats equal and zero-padded versions as equal', () => {
    expect(compareVersions('0.14.0', '0.14.0')).toBe(0)
    expect(compareVersions('0.14', '0.14.0')).toBe(0)
    expect(compareVersions('v0.14.0', '0.14.0')).toBe(0)
  })

  it('orders a pre-release below its own release (SemVer 2.0 §11)', () => {
    expect(compareVersions('0.14.0-rc1', '0.14.0')).toBeLessThan(0)
    expect(compareVersions('0.14.0', '0.14.0-rc1')).toBeGreaterThan(0)
    expect(compareVersions('0.14.0-rc1', '0.13.9')).toBeGreaterThan(0)
  })

  it('orders pre-release identifiers numerically, not lexically', () => {
    expect(compareVersions('0.18.0-beta.17', '0.18.0-beta.19')).toBeLessThan(0)
    expect(compareVersions('0.18.0-beta.9', '0.18.0-beta.10')).toBeLessThan(0)
    expect(compareVersions('0.18.0-beta.19', '0.18.0-beta.19')).toBe(0)
  })

  it('ignores build metadata, with or without a pre-release', () => {
    expect(compareVersions('0.14.0+abc123', '0.14.0')).toBe(0)
    expect(compareVersions('0.18.0-beta.19+abc123', '0.18.0-beta.19')).toBe(0)
    expect(compareVersions('0.18.0-beta.17+abc123', '0.18.0-beta.19')).toBeLessThan(0)
  })

  it('returns null rather than guessing at unparseable input', () => {
    expect(compareVersions('', '0.14.0')).toBeNull()
    expect(compareVersions('unknown', '0.14.0')).toBeNull()
    expect(compareVersions('0.14.0', 'dev')).toBeNull()
  })
})

describe('isUpgrade', () => {
  it('is true only for a genuinely newer candidate', () => {
    expect(isUpgrade('0.13.9', '0.14.0')).toBe(true)
  })

  it('is false for a downgrade', () => {
    // The bug this exists to prevent: a signer running a newer build than the
    // bundled manifest was offered the older one, silently reverting its fixes.
    expect(isUpgrade('0.14.0', '0.13.9')).toBe(false)
  })

  it('is false when the versions match', () => {
    expect(isUpgrade('0.14.0', '0.14.0')).toBe(false)
  })

  it('is false when either side is missing or unparseable', () => {
    expect(isUpgrade(null, '0.14.0')).toBe(false)
    expect(isUpgrade('0.14.0', null)).toBe(false)
    expect(isUpgrade('unknown', '0.14.0')).toBe(false)
  })

  it('treats a newer beta as an upgrade over an older beta on the same release', () => {
    expect(isUpgrade('0.18.0-beta.17', '0.18.0-beta.19')).toBe(true)
  })

  it('treats the final release as an upgrade over its own beta', () => {
    expect(isUpgrade('0.18.0-beta.19', '0.18.0')).toBe(true)
  })

  it('does not offer a beta as an upgrade over its own final release', () => {
    expect(isUpgrade('0.18.0', '0.18.0-beta.19')).toBe(false)
  })
})
