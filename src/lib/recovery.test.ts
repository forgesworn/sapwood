import { describe, expect, it } from 'vitest'
import { nip19 } from 'nostr-tools'
import {
  parseDependantsManifest, pickLatestManifest, dependantIndex,
  buildEnrolmentPlan, verifyDerived, npubToHex, runEnrolment,
  MANIFEST_KIND, MANIFEST_D_TAG,
  type ManifestEventLike, type ManifestDependant, type EnrolmentEntry,
} from './recovery.js'

const HEX_A = 'a'.repeat(64)
const HEX_B = 'b'.repeat(64)
const HEX_C = 'c'.repeat(64)
const HEX_D = 'd'.repeat(64)

function npubOf(hex: string): string {
  return nip19.npubEncode(hex)
}

/** A payload exactly as My Signet's toSyncWire serialises it (schema v1),
 * including fields Sapwood ignores (defaultSchedule, lastNameCredentialId,
 * dateOfBirth) so the frozen-contract tolerance is what's under test. */
function wirePayload(): string {
  return JSON.stringify({
    v: 1,
    dependants: [
      {
        id: HEX_A,
        guardianPubkey: HEX_D,
        displayName: 'Alice',
        dateOfBirth: '2014-03-02',
        derivationPath: 'dependant-0',
        autonomyStage: 'request-approve',
        primaryKeypair: 'natural-person',
        createdAt: 1755100000,
        np: { publicKey: HEX_A.toUpperCase(), displayName: 'Alice' },
        persona: { publicKey: HEX_B, displayName: 'starling' },
        extras: [
          { derivationName: 'dependant-0-persona-1', publicKey: HEX_C, displayName: 'gamer', lastNameCredentialId: 'cred-1' },
        ],
        defaultSchedule: { v: 1, tz: 'Europe/London', weekly: {}, issuedAt: 1755100000 },
      },
      {
        id: HEX_B,
        guardianPubkey: HEX_D,
        displayName: 'Watched cousin',
        derivationPath: 'imported-view-xyz',
        autonomyStage: 'full-control',
        primaryKeypair: 'natural-person',
        createdAt: 1755100001,
        np: { publicKey: HEX_B, displayName: 'Cousin' },
        persona: { publicKey: '', displayName: '' },
        viewOnly: true,
      },
    ],
  })
}

describe('manifest parsing (frozen C1 wire, schema v1)', () => {
  it('parses the wire shape, lowercases pubkeys, keeps unknown fields out', () => {
    const manifest = parseDependantsManifest(wirePayload())
    expect(manifest.v).toBe(1)
    expect(manifest.dependants).toHaveLength(2)
    const alice = manifest.dependants[0]
    expect(alice.np.publicKey).toBe(HEX_A)
    expect(alice.persona.publicKey).toBe(HEX_B)
    expect(alice.extras).toEqual([
      { derivationName: 'dependant-0-persona-1', publicKey: HEX_C, displayName: 'gamer' },
    ])
    expect(alice.viewOnly).toBe(false)
    expect(manifest.dependants[1].viewOnly).toBe(true)
  })

  it('rejects a newer schema whole and skips malformed records individually', () => {
    expect(() => parseDependantsManifest(JSON.stringify({ v: 2, dependants: [] })))
      .toThrow(/newer My Signet/)
    const mixed = JSON.parse(wirePayload()) as { dependants: unknown[] }
    mixed.dependants.push({ id: 42 }, null, 'junk')
    const manifest = parseDependantsManifest(JSON.stringify(mixed))
    expect(manifest.dependants).toHaveLength(2)
  })

  it('rejects non-JSON and oversized rosters', () => {
    expect(() => parseDependantsManifest('not json')).toThrow(/not valid JSON/)
    const big = { v: 1, dependants: Array.from({ length: 201 }, () => ({})) }
    expect(() => parseDependantsManifest(JSON.stringify(big))).toThrow(/unexpected shape/)
  })

  it('truncates display names at the wire cap', () => {
    const payload = JSON.parse(wirePayload()) as { dependants: Array<{ displayName: string }> }
    payload.dependants[0].displayName = 'x'.repeat(300)
    const manifest = parseDependantsManifest(JSON.stringify(payload))
    expect(manifest.dependants[0].displayName).toHaveLength(200)
  })
})

describe('manifest event selection', () => {
  const base: ManifestEventLike = {
    pubkey: HEX_D,
    content: 'ciphertext',
    created_at: 100,
    kind: MANIFEST_KIND,
    tags: [['d', MANIFEST_D_TAG]],
  }

  it('picks the newest event from the right author and d-tag only', () => {
    const events: ManifestEventLike[] = [
      base,
      { ...base, created_at: 300, pubkey: HEX_A },
      { ...base, created_at: 250, tags: [['d', 'signet:contacts']] },
      { ...base, created_at: 200, content: 'newest' },
    ]
    expect(pickLatestManifest(events, HEX_D.toUpperCase())?.content).toBe('newest')
    expect(pickLatestManifest([], HEX_D)).toBeNull()
  })
})

describe('enrolment planning', () => {
  it('derives the guardian personas blind, then dependants in index order', () => {
    const manifest = parseDependantsManifest(wirePayload())
    const plan = buildEnrolmentPlan(manifest)
    expect(plan.entries.map((entry) => entry.derivationName)).toEqual([
      'persona', 'professional',
      'dependant-0-np', 'dependant-0-persona', 'dependant-0-persona-1',
    ])
    expect(plan.entries[0].expectedPubkey).toBe('')
    expect(plan.entries[2].expectedPubkey).toBe(HEX_A)
    expect(plan.entries[2].displayName).toBe('Alice')
    expect(plan.skipped).toHaveLength(1)
    expect(plan.skipped[0].reason).toMatch(/view-only/)
  })

  it('orders numerically, not lexically, and skips keyless or unsafe rows', () => {
    const dep = (index: number): ManifestDependant => ({
      id: HEX_A, guardianPubkey: HEX_D, displayName: `d${index}`,
      derivationPath: `dependant-${index}`, autonomyStage: 'full-control',
      createdAt: 1, np: { publicKey: HEX_A, displayName: '' },
      persona: { publicKey: HEX_B, displayName: '' }, extras: [], viewOnly: false,
    })
    const plan = buildEnrolmentPlan({ v: 1, dependants: [dep(10), dep(2)] })
    expect(plan.entries.map((entry) => entry.derivationName).slice(2))
      .toEqual(['dependant-2-np', 'dependant-2-persona', 'dependant-10-np', 'dependant-10-persona'])

    const bad = dep(0)
    bad.persona.publicKey = ''
    bad.extras = [{ derivationName: 'evil|name', publicKey: HEX_C, displayName: 'evil' }]
    const partial = buildEnrolmentPlan({ v: 1, dependants: [bad] })
    expect(partial.entries.map((entry) => entry.derivationName).slice(2)).toEqual(['dependant-0-np'])
    expect(partial.skipped.map((skip) => skip.reason)).toEqual([
      'no expected pubkey in the roster',
      'invalid characters in derivation name',
    ])
  })

  it('reads dependant indices strictly', () => {
    expect(dependantIndex('dependant-7')).toBe(7)
    expect(dependantIndex('dependant-7-np')).toBeNull()
    expect(dependantIndex('imported-view-x')).toBeNull()
  })
})

describe('verification', () => {
  it('matches an npub against its expected hex, case-insensitively', () => {
    expect(verifyDerived(HEX_A.toUpperCase(), npubOf(HEX_A))).toBe(true)
    expect(verifyDerived(HEX_B, npubOf(HEX_A))).toBe(false)
    expect(npubToHex(npubOf(HEX_C))).toBe(HEX_C)
    expect(() => npubToHex('nsec1invalid')).toThrow()
  })
})

describe('the enrolment loop', () => {
  const entries: EnrolmentEntry[] = [
    { derivationName: 'persona', displayName: 'persona', expectedPubkey: '', belongsTo: 'Guardian' },
    { derivationName: 'dependant-0-np', displayName: 'Alice', expectedPubkey: HEX_A, belongsTo: 'Alice' },
  ]

  it('derives, verifies, and labels every row on the happy path', async () => {
    const derived: string[] = []
    const renamed: Array<[string, string]> = []
    const result = await runEnrolment(entries, {
      derive: async (name) => { derived.push(name); return { npub: npubOf(name === 'persona' ? HEX_B : HEX_A) } },
      rename: async (npub, label) => { renamed.push([npub, label]) },
    })
    expect(result.complete).toBe(true)
    expect(result.rows.every((row) => row.outcome === 'verified')).toBe(true)
    expect(derived).toEqual(['persona', 'dependant-0-np'])
    // Only the row whose label differs from its derivation name is renamed.
    expect(renamed).toEqual([[npubOf(HEX_A), 'Alice']])
  })

  it('aborts on a checksum mismatch and leaves later rows pending', async () => {
    const three = [...entries, { derivationName: 'dependant-1-np', displayName: 'Bob', expectedPubkey: HEX_C, belongsTo: 'Bob' }]
    const result = await runEnrolment(three, {
      derive: async (name) => ({ npub: npubOf(name === 'dependant-0-np' ? HEX_B : HEX_B) }),
      rename: async () => {},
    })
    expect(result.complete).toBe(false)
    expect(result.abortedOn).toBe('dependant-0-np')
    expect(result.rows[1].outcome).toBe('mismatch')
    expect(result.rows[2].outcome).toBe('pending')
  })

  it('aborts on a derive failure and survives a rename failure', async () => {
    const failed = await runEnrolment(entries, {
      derive: async () => { throw new Error('identity storage full: remove an identity first') },
      rename: async () => {},
    })
    expect(failed.complete).toBe(false)
    expect(failed.rows[0].outcome).toBe('failed')
    expect(failed.rows[0].error).toMatch(/storage full/)

    const labelless = await runEnrolment(entries, {
      derive: async (name) => ({ npub: npubOf(name === 'persona' ? HEX_B : HEX_A) }),
      rename: async () => { throw new Error('rename refused') },
    })
    expect(labelless.complete).toBe(true)
  })
})
