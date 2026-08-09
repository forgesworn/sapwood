import { describe, it, expect } from 'vitest'
import {
  parseNostrConnectURI, isValidNostrConnect, permissionsToClientPolicy,
  describeNostrConnectPermissions, describeNostrConnectMethods,
  requestedKindRows, sharesRelay,
} from './nostrconnect.js'

const PK = 'a'.repeat(64)
const base = `nostrconnect://${PK}?relay=wss%3A%2F%2Frelay.trotters.cc&secret=sek`

describe('parseNostrConnectURI', () => {
  it('parses a minimal valid URI', () => {
    const r = parseNostrConnectURI(base)
    expect(r).not.toBeNull()
    expect(r!.clientPubkey).toBe(PK)
    expect(r!.relays).toEqual(['wss://relay.trotters.cc'])
    expect(r!.secret).toBe('sek')
    expect(r!.appName).toBe('Unknown app')
  })

  it('reads name, url and perms', () => {
    const uri = `${base}&name=Damus&url=https%3A%2F%2Fdamus.io%2Fx&perms=sign_event%3A1%2Cget_public_key%2Csign_event%3A0`
    const r = parseNostrConnectURI(uri)!
    expect(r.appName).toBe('Damus')
    expect(r.appUrl).toBe('https://damus.io')
    expect(r.perms).toEqual(['sign_event:1', 'get_public_key', 'sign_event:0'])
  })

  it('collects and de-dupes multiple relays, dropping non-ws', () => {
    const uri = `nostrconnect://${PK}?relay=wss%3A%2F%2Fa.example&relay=wss%3A%2F%2Fa.example&relay=https%3A%2F%2Fnot-a-relay&secret=s`
    const r = parseNostrConnectURI(uri)!
    expect(r.relays).toEqual(['wss://a.example'])
  })

  it('rejects malformed input', () => {
    expect(parseNostrConnectURI('bunker://' + PK)).toBeNull() // wrong scheme
    expect(parseNostrConnectURI(`nostrconnect://xyz?relay=wss%3A%2F%2Fa&secret=s`)).toBeNull() // bad pubkey
    expect(parseNostrConnectURI(`nostrconnect://${PK}?secret=s`)).toBeNull() // no relay
    expect(parseNostrConnectURI(`nostrconnect://${PK}?relay=wss%3A%2F%2Fa`)).toBeNull() // no secret
    expect(parseNostrConnectURI('nostrconnect://' + PK + '?relay=wss%3A%2F%2Fa&secret=s'.padEnd(5000, 'x'))).toBeNull() // oversized
    expect(isValidNostrConnect('not a uri')).toBe(false)
  })

  it('strips bidi / control chars from the app name', () => {
    const uri = `${base}&name=${encodeURIComponent('Ev‮il')}`
    const r = parseNostrConnectURI(uri)!
    expect(r.appName).toBe('Evil')
  })

  it('ignores a non-https app url', () => {
    const uri = `${base}&url=${encodeURIComponent('http://evil.example')}`
    expect(parseNostrConnectURI(uri)!.appUrl).toBeUndefined()
  })
})

describe('permissionsToClientPolicy', () => {
  it('normalises exact methods and sorted, de-duplicated signing kinds', () => {
    const result = permissionsToClientPolicy([
      'nip44_encrypt', 'sign_event:1059', 'get_public_key', 'sign_event:13', 'sign_event:13',
    ])
    expect(result.issues).toEqual([])
    expect(result.signing).toBe('kinds')
    expect(result.policy).toEqual({
      allowed_methods: ['get_public_key', 'nip44_encrypt', 'sign_event'],
      allowed_kinds: [13, 1059],
      auto_approve: true,
    })
  })

  it('treats bare sign_event as all kinds even alongside narrower entries', () => {
    const result = permissionsToClientPolicy(['sign_event:1', 'sign_event'])
    expect(result.issues).toEqual([])
    expect(result.signing).toBe('all')
    expect(result.policy.allowed_methods).toContain('sign_event')
    expect(result.policy.allowed_kinds).toEqual([])
  })

  it('keeps omitted and crypto-only permissions non-signing', () => {
    expect(permissionsToClientPolicy([]).policy).toEqual({
      allowed_methods: ['get_public_key'],
      allowed_kinds: [],
      auto_approve: true,
    })
    const crypto = permissionsToClientPolicy(['nip44_decrypt'])
    expect(crypto.policy.allowed_methods).toEqual(['get_public_key', 'nip44_decrypt'])
    expect(crypto.policy.allowed_methods).not.toContain('sign_event')
    expect(describeNostrConnectPermissions(crypto)).toContain('NIP-44 decrypt')
  })

  it('surfaces every malformed, unknown or unsupported permission', () => {
    for (const permission of [
      'sign_event:', 'sign_event:-1', 'sign_event:1.5', 'sign_event:9007199254740992',
      'nip44_encrypt:thing', 'switch_relays', 'delete_everything',
    ]) {
      const result = permissionsToClientPolicy([permission])
      expect(result.issues.length, permission).toBeGreaterThan(0)
    }
  })
})

describe('requestedKindRows', () => {
  it('labels requested kinds from the registry with their risk', () => {
    const rows = requestedKindRows(permissionsToClientPolicy(['sign_event:27117', 'sign_event:30808', 'sign_event:1']))
    expect(rows).toEqual([
      { kind: 1, label: 'Note', risk: 'medium' },
      { kind: 27117, label: 'Gated Deposit Auth', risk: 'high' },
      { kind: 30808, label: 'Gated Content', risk: 'medium' },
    ])
  })

  it('shows an unknown kind rather than hiding it, with unknown risk', () => {
    const rows = requestedKindRows(permissionsToClientPolicy(['sign_event:999999']))
    expect(rows).toEqual([{ kind: 999999, label: 'Unknown kind 999999', risk: 'unknown' }])
  })

  it('returns nothing for sign-all or no-signing requests', () => {
    expect(requestedKindRows(permissionsToClientPolicy(['sign_event']))).toEqual([])
    expect(requestedKindRows(permissionsToClientPolicy(['nip44_decrypt']))).toEqual([])
  })
})

describe('describeNostrConnectMethods', () => {
  it('lists only the non-signing actions', () => {
    const result = permissionsToClientPolicy(['sign_event:1', 'nip44_decrypt', 'nip04_encrypt'])
    expect(describeNostrConnectMethods(result)).toBe('NIP-44 decrypt; NIP-04 encrypt')
  })

  it('is empty when only signing was requested', () => {
    expect(describeNostrConnectMethods(permissionsToClientPolicy(['sign_event:1']))).toBe('')
  })
})

describe('sharesRelay', () => {
  it('matches on host+path ignoring trailing slash and case', () => {
    expect(sharesRelay(['wss://relay.trotters.cc/'], ['wss://relay.trotters.cc'])).toBe(true)
    expect(sharesRelay(['wss://RELAY.trotters.cc'], ['wss://relay.trotters.cc'])).toBe(true)
    expect(sharesRelay(['wss://other.example'], ['wss://relay.trotters.cc'])).toBe(false)
    expect(sharesRelay([], ['wss://relay.trotters.cc'])).toBe(false)
  })
})
