import { describe, it, expect } from 'vitest'
import {
  PERMISSION_PRESETS, presetById, resolveKinds, isRestricted, type PresetId,
} from './client-presets.js'

describe('permission presets', () => {
  it('exposes the four expected presets in order', () => {
    expect(PERMISSION_PRESETS.map((p) => p.id)).toEqual([
      'posting', 'everything', 'messaging', 'custom',
    ])
  })

  it('every preset has a label and a plain description', () => {
    for (const p of PERMISSION_PRESETS) {
      expect(p.label.length).toBeGreaterThan(0)
      expect(p.description.length).toBeGreaterThan(0)
      expect(p.description).not.toContain('!') // house voice: no exclamation marks
    }
  })

  it('presetById returns the matching preset', () => {
    expect(presetById('messaging').label).toBe('Messages only')
  })

  it('presetById falls back to the first preset for an unknown id', () => {
    expect(presetById('nope' as PresetId).id).toBe('posting')
  })
})

describe('resolveKinds', () => {
  it('everything is unrestricted (null)', () => {
    expect(resolveKinds('everything')).toBeNull()
  })

  it('posting allows notes/reactions/reposts/articles but not profile or contacts', () => {
    const kinds = resolveKinds('posting')!
    expect(kinds).toContain(1) // note
    expect(kinds).toContain(7) // reaction
    expect(kinds).toContain(30023) // article
    expect(kinds).not.toContain(0) // profile
    expect(kinds).not.toContain(3) // contacts
  })

  it('messaging allows DM and gift wrap only', () => {
    expect(resolveKinds('messaging')).toEqual([4, 1059])
  })

  it('custom uses the supplied kinds, de-duplicated and sorted', () => {
    expect(resolveKinds('custom', [7, 1, 1, 7])).toEqual([1, 7])
  })

  it('custom with no kinds means unrestricted (null)', () => {
    expect(resolveKinds('custom', [])).toBeNull()
  })

  it('custom drops negative / non-integer kinds', () => {
    expect(resolveKinds('custom', [1, -3, 2.5 as number, 9])).toEqual([1, 9])
  })
})

describe('isRestricted', () => {
  it('is false for everything', () => {
    expect(isRestricted('everything')).toBe(false)
  })

  it('is true for posting and messaging', () => {
    expect(isRestricted('posting')).toBe(true)
    expect(isRestricted('messaging')).toBe(true)
  })

  it('reflects whether custom has any kinds', () => {
    expect(isRestricted('custom', [])).toBe(false)
    expect(isRestricted('custom', [1])).toBe(true)
  })
})
