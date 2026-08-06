import { describe, expect, it } from 'vitest'
import { identityKey, dedupeIdentities } from './identity-key.js'

const master = (slot: number, npub: string) => ({ slot, npub })
const persona = (slot: number, npub: string) => ({ slot, npub, persona: true })

describe('identityKey', () => {
  it('separates a persona from the master whose slot it carries', () => {
    // The signer reports a derived identity under its OWNING master's slot, so
    // keying by slot collided and blanked the Identity panel.
    expect(identityKey(master(0, 'npub1aaa'))).not.toBe(identityKey(persona(0, 'npub1bbb')))
  })

  it('separates two slots holding the same key', () => {
    // The same nsec provisioned twice under different labels: same npub, two slots.
    expect(identityKey(master(0, 'npub1aaa'))).not.toBe(identityKey(master(1, 'npub1aaa')))
  })

  it('separates rows whose npub failed to decode to the empty string', () => {
    expect(identityKey(master(0, ''))).not.toBe(identityKey(master(1, '')))
  })

  it('is stable for the same row across refreshes', () => {
    expect(identityKey(master(2, 'npub1ccc'))).toBe(identityKey(master(2, 'npub1ccc')))
  })
})

describe('dedupeIdentities', () => {
  it('drops a row the signer reported twice, preserving order', () => {
    const rows = [master(0, 'npub1aaa'), persona(0, 'npub1bbb'), master(0, 'npub1aaa')]
    expect(dedupeIdentities(rows)).toEqual([master(0, 'npub1aaa'), persona(0, 'npub1bbb')])
  })

  it('keeps genuinely distinct rows that share a slot or an npub', () => {
    const rows = [master(0, 'npub1aaa'), persona(0, 'npub1bbb'), master(1, 'npub1aaa')]
    expect(dedupeIdentities(rows)).toHaveLength(3)
  })

  it('collapses rows that lost their npub to the same empty placeholder only when the slot matches', () => {
    expect(dedupeIdentities([master(0, ''), master(0, ''), master(1, '')])).toHaveLength(2)
  })
})
