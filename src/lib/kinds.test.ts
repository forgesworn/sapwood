import { describe, it, expect } from 'vitest'
import { COMMON_KINDS, kindLabel, kindInfo, riskColour } from './kinds.js'

describe('kindLabel', () => {
  it('names a known kind with its number', () => {
    expect(kindLabel(1)).toBe('Note (1)')
    expect(kindLabel(24133)).toBe('NIP-46 (24133)')
  })

  it('names a kind that is labelled but not "common"', () => {
    // 8 (Badge Award) lives in the full label map but not in COMMON_KINDS.
    expect(kindLabel(8)).toBe('Badge Award (8)')
  })

  it('falls back to "kind N" for an unknown kind', () => {
    expect(kindLabel(999999)).toBe('kind 999999')
  })
})

describe('kindInfo', () => {
  it('returns the entry for a common kind', () => {
    expect(kindInfo(1)).toMatchObject({ kind: 1, label: 'Note', risk: 'medium', category: 'social' })
  })

  it('returns undefined for a kind outside COMMON_KINDS', () => {
    expect(kindInfo(8)).toBeUndefined() // labelled, but not a common/controllable kind
    expect(kindInfo(999999)).toBeUndefined()
  })
})

describe('riskColour', () => {
  it('maps each risk level to its CSS variable', () => {
    expect(riskColour('low')).toBe('var(--green)')
    expect(riskColour('medium')).toBe('var(--amber)')
    expect(riskColour('high')).toBe('var(--red)')
  })
})

describe('COMMON_KINDS data integrity', () => {
  it('has no duplicate kind numbers', () => {
    const seen = new Set<number>()
    for (const k of COMMON_KINDS) {
      expect(seen.has(k.kind), `duplicate kind ${k.kind}`).toBe(false)
      seen.add(k.kind)
    }
  })

  it('renders a real label for every common kind (no "kind N" fallback)', () => {
    // The permissions UI shows these by name; a common kind missing from the
    // full label map would silently render as a bare number.
    for (const k of COMMON_KINDS) {
      expect(kindLabel(k.kind), `kind ${k.kind} has no label`).not.toMatch(/^kind \d+$/)
    }
  })

  it('uses only known risk levels, each with a colour', () => {
    for (const k of COMMON_KINDS) {
      expect(['low', 'medium', 'high']).toContain(k.risk)
      expect(riskColour(k.risk)).toMatch(/^var\(--/)
    }
  })

  it('groups every entry under a category the permissions UI renders', () => {
    // KindPermissions.svelte buckets by these five categories; a kind tagged
    // with any other category would vanish from that UI.
    const shown = new Set(['identity', 'social', 'crypto', 'payment', 'relay'])
    for (const k of COMMON_KINDS) {
      expect(shown.has(k.category), `kind ${k.kind} has unshown category ${k.category}`).toBe(true)
    }
  })
})
