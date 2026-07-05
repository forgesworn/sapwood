import { describe, it, expect } from 'vitest'
import {
  parseNostrConnectURI, isValidNostrConnect, permsToAllowedKinds, sharesRelay,
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

describe('permsToAllowedKinds', () => {
  it('extracts sign_event kinds, ignoring other methods', () => {
    expect(permsToAllowedKinds(['sign_event:1', 'get_public_key', 'sign_event:0'])).toEqual([1, 0])
    expect(permsToAllowedKinds(['nip44_encrypt'])).toEqual([])
    expect(permsToAllowedKinds([])).toEqual([])
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
