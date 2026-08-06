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

  it('ignores a pre-release suffix for ordering', () => {
    expect(compareVersions('0.14.0-rc1', '0.14.0')).toBe(0)
    expect(compareVersions('0.14.0-rc1', '0.13.9')).toBeGreaterThan(0)
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
})
