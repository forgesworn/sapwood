import { describe, it, expect } from 'vitest'
import {
  KITHMOOT_PRIVATE_KINDS,
  KITHMOOT_PRIVATE_METHODS,
  kithmootAlreadyEnabled,
  kithmootPermissionChanges,
  kithmootUpgradeBlockedReason,
  permissionSlotUnchanged,
  upgradeBlockedReason,
  presetAlreadyEnabled,
  permissionChanges,
  ADDITIVE_PRESETS,
  SIGN_IN_PRESET,
  V4V_LISTENER_PRESET,
  V4V_ARTIST_PRESET,
} from './client-permission-upgrade.js'
import { V4V_ARTIST_KINDS, V4V_LISTENER_KINDS } from './client-presets.js'
import type { ConnectSlot } from './types.js'

function slot(overrides: Partial<ConnectSlot> = {}): ConnectSlot {
  return {
    slot_index: 1,
    label: 'KithMoot',
    secret: '',
    current_pubkey: 'aa'.repeat(32),
    authorized_pubkeys: ['aa'.repeat(32)],
    allowed_methods: ['get_public_key', 'sign_event'],
    allowed_kinds: [1],
    auto_approve: false,
    signing_approved: true,
    strict_permissions: true,
    secret_fingerprint: 'ab'.repeat(32),
    approved_identities: [],
    ...overrides,
  }
}

describe('kithmootUpgradeBlockedReason', () => {
  it('is available for a signing-approved sign_event slot with a key', () => {
    expect(kithmootUpgradeBlockedReason(slot())).toBeNull()
  })

  it('blocks when signing is not approved', () => {
    expect(kithmootUpgradeBlockedReason(slot({ signing_approved: false }))).toBe(
      'Signing approval needed first',
    )
  })

  it('blocks when the slot does not allow sign_event', () => {
    expect(
      kithmootUpgradeBlockedReason(slot({ allowed_methods: ['get_public_key'] })),
    ).toBe('App must already allow sign_event')
  })

  it('blocks when there is no authorised current or retained key', () => {
    expect(
      kithmootUpgradeBlockedReason(slot({ current_pubkey: null, authorized_pubkeys: [] })),
    ).toBe('No authorised key available')
  })

  it('does not block a null current key when a retained key exists', () => {
    expect(
      kithmootUpgradeBlockedReason(
        slot({ current_pubkey: null, authorized_pubkeys: ['cc'.repeat(32)] }),
      ),
    ).toBeNull()
  })

  it('reports already enabled', () => {
    expect(
      kithmootUpgradeBlockedReason(
        slot({
          allowed_methods: [...KITHMOOT_PRIVATE_METHODS],
          allowed_kinds: [...KITHMOOT_PRIVATE_KINDS],
        }),
      ),
    ).toBe('KithMoot rooms already enabled')
  })

  it('treats an unrestricted slot that already has every method as enabled', () => {
    expect(kithmootAlreadyEnabled(slot({ allowed_kinds: [], allowed_methods: [...KITHMOOT_PRIVATE_METHODS] }))).toBe(true)
  })
})

describe('kithmootPermissionChanges', () => {
  it('merges existing kinds with the preset kinds', () => {
    expect(kithmootPermissionChanges(slot({ allowed_kinds: [1, 30078] })).allowed_kinds).toEqual([
      1, 20460, 21236, 30078,
    ])
  })

  it('leaves an empty allowed_kinds empty (unrestricted)', () => {
    expect(kithmootPermissionChanges(slot({ allowed_kinds: [] })).allowed_kinds).toEqual([])
  })

  it('preserves unknown methods already on the slot', () => {
    const changes = kithmootPermissionChanges(
      slot({ allowed_methods: ['get_public_key', 'sign_event', 'custom_method'] }),
    )
    expect(changes.allowed_methods).toContain('custom_method')
    expect(changes.allowed_methods).toContain('nip44_encrypt')
    expect(changes.allowed_methods).toContain('nip44_decrypt')
  })

  it('dedupes methods and kinds', () => {
    const changes = kithmootPermissionChanges(
      slot({ allowed_methods: ['sign_event', 'sign_event'], allowed_kinds: [30078, 1, 1, 30078] }),
    )
    expect(changes.allowed_methods.filter((m) => m === 'sign_event')).toHaveLength(1)
    expect(changes.allowed_kinds).toEqual([1, 20460, 21236, 30078])
  })

  it('returns only the two permission arrays', () => {
    const changes = kithmootPermissionChanges(slot())
    expect(Object.keys(changes).sort()).toEqual(['allowed_kinds', 'allowed_methods'])
  })

  it('does not mutate the caller slot', () => {
    const original = slot({ allowed_methods: ['get_public_key', 'sign_event'], allowed_kinds: [1] })
    const methodsBefore = [...original.allowed_methods]
    const kindsBefore = [...original.allowed_kinds]
    kithmootPermissionChanges(original)
    expect(original.allowed_methods).toEqual(methodsBefore)
    expect(original.allowed_kinds).toEqual(kindsBefore)
    expect(original.allowed_methods).not.toContain('nip44_encrypt')
  })
})

describe('permissionSlotUnchanged', () => {
  it('is true for identical snapshots', () => {
    expect(permissionSlotUnchanged(slot(), slot())).toBe(true)
  })

  it('is insensitive to array order', () => {
    const a = slot({ allowed_kinds: [1, 30078] })
    const b = slot({ allowed_kinds: [30078, 1] })
    expect(permissionSlotUnchanged(a, b)).toBe(true)
  })

  it('is false when the fingerprint differs', () => {
    expect(permissionSlotUnchanged(slot(), slot({ secret_fingerprint: 'cd'.repeat(32) }))).toBe(false)
  })

  it('is false when the authorised key set differs', () => {
    expect(permissionSlotUnchanged(slot(), slot({ current_pubkey: 'zz'.repeat(32) }))).toBe(false)
  })

  it('is false when methods differ', () => {
    expect(
      permissionSlotUnchanged(slot(), slot({ allowed_methods: ['get_public_key'] })),
    ).toBe(false)
  })

  it('is false when kinds differ', () => {
    expect(permissionSlotUnchanged(slot(), slot({ allowed_kinds: [1, 2] }))).toBe(false)
  })

  it('is false when auto-approve differs', () => {
    expect(permissionSlotUnchanged(slot(), slot({ auto_approve: true }))).toBe(false)
  })

  it('is false when the label differs', () => {
    expect(permissionSlotUnchanged(slot(), slot({ label: 'Other' }))).toBe(false)
  })

  it('is false when the raw USB ids field differs', () => {
    expect(
      permissionSlotUnchanged(slot({ ids: 'aa' }), slot({ ids: 'bb' })),
    ).toBe(false)
  })

  it('is false when slot_index differs', () => {
    expect(permissionSlotUnchanged(slot({ slot_index: 1 }), slot({ slot_index: 2 }))).toBe(false)
  })

  it('is true when the retained-key set is stable across a current-display switch', () => {
    const a = slot({ current_pubkey: 'aa'.repeat(32), authorized_pubkeys: ['bb'.repeat(32)] })
    const b = slot({ current_pubkey: 'bb'.repeat(32), authorized_pubkeys: ['aa'.repeat(32)] })
    expect(permissionSlotUnchanged(a, b)).toBe(true)
  })

  it.each([
    ['bound_identity', { bound_identity: 'ab'.repeat(32) }],
    ['escalate', { escalate: true }],
    ['petition_on_deny', { petition_on_deny: true }],
    ['audit_child_wrap', { audit_child_wrap: true }],
    ['guardian_notice_wrap', { guardian_notice_wrap: true }],
  ] as const)('is false when %s differs', (_name, override) => {
    expect(permissionSlotUnchanged(slot(), slot(override))).toBe(false)
  })

  it('treats absent and explicit-default binding/family flags as equivalent', () => {
    const absent = slot()
    const explicit = slot({
      bound_identity: null,
      escalate: false,
      petition_on_deny: false,
      audit_child_wrap: false,
      guardian_notice_wrap: false,
    })
    expect(permissionSlotUnchanged(absent, explicit)).toBe(true)
    expect(permissionSlotUnchanged(explicit, absent)).toBe(true)
  })

  it('compares bound_identity across different 64-hex bindings as unchanged-equal', () => {
    const a = slot({ bound_identity: 'ab'.repeat(32) })
    const b = slot({ bound_identity: 'ab'.repeat(32) })
    expect(permissionSlotUnchanged(a, b)).toBe(true)
  })
})

describe('kithmootPermissionChanges runtime shape guards', () => {
  it('throws when allowed_methods is not an array', () => {
    const bad = { ...slot(), allowed_methods: undefined as unknown as string[] }
    expect(() => kithmootPermissionChanges(bad)).toThrow()
  })

  it('throws when allowed_kinds is not an array', () => {
    const bad = { ...slot(), allowed_kinds: undefined as unknown as number[] }
    expect(() => kithmootPermissionChanges(bad)).toThrow()
  })

  it('throws when allowed_kinds contains a non-integer', () => {
    const bad = { ...slot(), allowed_kinds: [1, 2.5] }
    expect(() => kithmootPermissionChanges(bad)).toThrow()
  })

  it('throws when allowed_kinds contains a negative entry', () => {
    const bad = { ...slot(), allowed_kinds: [1, -1] }
    expect(() => kithmootPermissionChanges(bad)).toThrow()
  })

  it('throws when allowed_methods contains a non-string', () => {
    const bad = { ...slot(), allowed_methods: ['sign_event', 1 as unknown as string] }
    expect(() => kithmootPermissionChanges(bad)).toThrow()
  })
})

describe('additive presets', () => {
  it('builds the four presets from the client-presets data', () => {
    expect(ADDITIVE_PRESETS.map((p) => p.id)).toEqual(['sign-in', 'v4v-listener', 'v4v-artist', 'kithmoot-private'])
    expect([...SIGN_IN_PRESET.kinds]).toEqual([21236])
    expect([...SIGN_IN_PRESET.methods]).toEqual(['get_public_key', 'sign_event'])
    expect([...V4V_LISTENER_PRESET.kinds]).toEqual([...V4V_LISTENER_KINDS])
    expect(new Set(V4V_ARTIST_PRESET.kinds)).toEqual(new Set([...V4V_LISTENER_KINDS, ...V4V_ARTIST_KINDS]))
    for (const p of [V4V_LISTENER_PRESET, V4V_ARTIST_PRESET]) {
      expect([...p.methods]).toEqual(['get_public_key', 'sign_event', 'nip44_encrypt', 'nip44_decrypt'])
    }
  })

  for (const preset of [SIGN_IN_PRESET, V4V_LISTENER_PRESET, V4V_ARTIST_PRESET]) {
    describe(preset.id, () => {
      it('blocks without signing approval, sign_event or a key', () => {
        expect(upgradeBlockedReason(slot({ signing_approved: false }), preset)).toBe('Signing approval needed first')
        expect(upgradeBlockedReason(slot({ allowed_methods: ['get_public_key'] }), preset)).toBe('App must already allow sign_event')
        expect(
          upgradeBlockedReason(slot({ current_pubkey: null, authorized_pubkeys: [] }), preset),
        ).toBe('No authorised key available')
        expect(upgradeBlockedReason(slot(), preset)).toBeNull()
      })

      it('detects already enabled and reports it as the blocked reason', () => {
        const full = slot({ allowed_methods: [...preset.methods], allowed_kinds: [1, ...preset.kinds] })
        expect(presetAlreadyEnabled(full, preset)).toBe(true)
        expect(upgradeBlockedReason(full, preset)).toBe(`${preset.name} already enabled`)
        const missingKind = slot({ allowed_methods: [...preset.methods], allowed_kinds: [99999, ...preset.kinds.slice(1)] })
        expect(presetAlreadyEnabled(missingKind, preset)).toBe(false)
        const missingMethod = slot({ allowed_methods: ['sign_event'], allowed_kinds: [...preset.kinds] })
        expect(presetAlreadyEnabled(missingMethod, preset)).toBe(preset.methods.length === 1)
      })

      it('unions with existing arrays and keeps unknown methods', () => {
        const c = permissionChanges(slot({ allowed_methods: ['sign_event', 'ping'], allowed_kinds: [7, 1] }), preset)
        expect(c.allowed_methods).toEqual(['sign_event', 'ping', ...preset.methods.filter((m) => m !== 'sign_event')])
        expect(c.allowed_kinds).toEqual([...new Set([7, 1, ...preset.kinds])].sort((a, b) => a - b))
      })

      it('leaves an unrestricted slot unrestricted and treats it as enabled with all methods', () => {
        const c = permissionChanges(slot({ allowed_kinds: [] }), preset)
        expect(c.allowed_kinds).toEqual([])
        expect(presetAlreadyEnabled(slot({ allowed_methods: [...preset.methods], allowed_kinds: [] }), preset)).toBe(true)
      })
    })
  }

  it('V4V artist is not enabled by the listener kinds alone', () => {
    const s = slot({ allowed_methods: [...V4V_LISTENER_PRESET.methods], allowed_kinds: [...V4V_LISTENER_KINDS] })
    expect(presetAlreadyEnabled(s, V4V_LISTENER_PRESET)).toBe(true)
    expect(presetAlreadyEnabled(s, V4V_ARTIST_PRESET)).toBe(false)
  })
})
