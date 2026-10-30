import { describe, it, expect } from 'vitest'
import {
  PERMISSION_PRESETS, V4V_ARTIST_KINDS, V4V_LISTENER_KINDS,
  presetById, resolveKinds, resolvePolicy, isRestricted, type PresetId,
} from './client-presets.js'
import { kindLabel } from './kinds.js'

describe('permission presets', () => {
  it('exposes the expected presets in order', () => {
    expect(PERMISSION_PRESETS.map((p) => p.id)).toEqual([
      'posting', 'everything', 'messaging',
      'sign-in', 'v4v-listener', 'v4v-artist', 'kithmoot-private',
      'custom',
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

  it('posting allows social posting and app settings but not profile or contacts', () => {
    const kinds = resolveKinds('posting')!
    expect(kinds).toContain(1) // note
    expect(kinds).toContain(7) // reaction
    expect(kinds).toContain(30023) // article
    expect(kinds).toContain(30078) // app data / client settings
    expect(kinds).not.toContain(0) // profile
    expect(kinds).not.toContain(3) // contacts
  })

  it('messaging covers signed DM envelopes and private-room device credentials but not unsigned NIP-17 rumors', () => {
    expect(resolveKinds('messaging')).toEqual([4, 13, 1059, 20460])
  })

  it('custom uses the supplied kinds, de-duplicated and sorted', () => {
    expect(resolveKinds('custom', [7, 1, 1, 7])).toEqual([1, 7])
  })

  it('kithmoot-private returns the named profile kinds', () => {
    expect(resolveKinds('kithmoot-private')).toEqual([20460, 21236, 30078])
  })

  it('kithmoot-private preset pins exact policy for the additive private-rooms upgrade', () => {
    const policy = resolvePolicy('kithmoot-private')
    expect(policy.allowed_kinds).toEqual([20460, 21236, 30078])
    for (const m of ['get_public_key', 'sign_event', 'nip44_encrypt', 'nip44_decrypt']) {
      expect(policy.allowed_methods).toContain(m)
    }
    expect(isRestricted('kithmoot-private')).toBe(true)
  })

  it('custom with no kinds means unrestricted (null)', () => {
    expect(resolveKinds('custom', [])).toBeNull()
  })

  it('custom drops negative / non-integer kinds', () => {
    expect(resolveKinds('custom', [1, -3, 2.5 as number, 9])).toEqual([1, 9])
  })
})

describe('resolvePolicy', () => {
  it('posting grants signing but no encryption methods', () => {
    expect(resolvePolicy('posting')).toEqual({
      allowed_methods: ['get_public_key', 'sign_event'],
      allowed_kinds: [1, 5, 6, 7, 30023, 30078],
      auto_approve: true,
    })
  })

  it('everything explicitly grants every supported method and all signing kinds', () => {
    const policy = resolvePolicy('everything')
    expect(policy.allowed_methods).toContain('sign_event')
    expect(policy.allowed_methods).toContain('nip44_decrypt')
    expect(policy.allowed_kinds).toEqual([])
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

// ForgeSworn's own apps get presets that name exactly what they ask a signer
// for, so a pairing never needs "Everything" to sign in silently, and never a
// press per sign-in because the kind was missing from a narrower preset.
describe('ForgeSworn app presets', () => {
  it('sign-in grants only the account sign-in proof, with no encryption methods', () => {
    expect(resolvePolicy('sign-in')).toEqual({
      allowed_methods: ['get_public_key', 'sign_event'],
      allowed_kinds: [21236],
      auto_approve: true,
    })
    expect(isRestricted('sign-in')).toBe(true)
  })

  it('v4v-listener covers sign-in, tips, live chat, playlists, library and listening status', () => {
    const kinds = resolveKinds('v4v-listener')!
    for (const k of [21236, 9734, 1311, 1, 5, 30003, 30078, 30315, 27201]) expect(kinds).toContain(k)
    expect(kinds).toEqual([...kinds].sort((a, b) => a - b))
    // A listener never sets a release's money terms or reads an artist's sales.
    for (const k of [27117, 27118, 27202, 30808]) expect(kinds).not.toContain(k)
    // Profile, contacts and relay list stay out, as in every narrow preset.
    for (const k of [0, 3, 10002]) expect(kinds).not.toContain(k)
  })

  it('v4v-listener needs NIP-44 through the signer to unlock paid releases and read the entitlement list', () => {
    const policy = resolvePolicy('v4v-listener')
    for (const m of ['get_public_key', 'sign_event', 'nip44_encrypt', 'nip44_decrypt']) {
      expect(policy.allowed_methods).toContain(m)
    }
    expect(policy.allowed_methods).not.toContain('nip04_decrypt')
  })

  it('v4v-artist is the listener set plus exactly the four artist kinds', () => {
    const listener = resolveKinds('v4v-listener')!
    const artist = resolveKinds('v4v-artist')!
    expect(artist).toEqual([...listener, ...V4V_ARTIST_KINDS].sort((a, b) => a - b))
    expect(V4V_ARTIST_KINDS).toEqual([27117, 27118, 27202, 30808])
    expect(resolvePolicy('v4v-artist').allowed_methods).toEqual(resolvePolicy('v4v-listener').allowed_methods)
  })

  it('the exported V4V kind lists are what the presets install', () => {
    expect(resolveKinds('v4v-listener')).toEqual([...V4V_LISTENER_KINDS])
  })

  it('every preset kind has a catalogue name, so a pairing review never shows an unknown kind', () => {
    for (const preset of PERMISSION_PRESETS) {
      for (const kind of preset.kinds ?? []) {
        expect(kindLabel(kind), `preset ${preset.id} kind ${kind}`).not.toMatch(/^Unknown kind/)
      }
    }
  })

  it('every preset stays inside the signer\'s 64-kind policy limit', () => {
    for (const preset of PERMISSION_PRESETS) {
      expect((preset.kinds ?? []).length).toBeLessThanOrEqual(64)
    }
  })
})
