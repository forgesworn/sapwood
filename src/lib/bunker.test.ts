import { describe, it, expect } from 'vitest'
import { bunkerHasRelay, bunkerUriWithEndpoint } from './bunker.js'

describe('bunkerHasRelay', () => {
  it('is true when the link names a relay', () => {
    expect(bunkerHasRelay('bunker://abcd?relay=wss://a.example&secret=s')).toBe(true)
  })

  it('is true with multiple relays', () => {
    expect(bunkerHasRelay('bunker://abcd?relay=wss://a.example&relay=wss://b.example')).toBe(true)
  })

  it('is false for a bare link with only a secret', () => {
    expect(bunkerHasRelay('bunker://abcd?secret=s')).toBe(false)
  })

  it('is false for a bare link with no query at all', () => {
    expect(bunkerHasRelay('bunker://abcd')).toBe(false)
  })

  it('does not treat "relay" inside the pubkey as a relay param', () => {
    expect(bunkerHasRelay('bunker://relaydead?secret=s')).toBe(false)
  })
})

describe('bunkerUriWithEndpoint', () => {
  const master = 'a'.repeat(64)
  const persona = 'b'.repeat(64)

  it('re-addresses the authority part and keeps the query intact', () => {
    const uri = `bunker://${master}?relay=wss://a.example&secret=s3cr3t`
    expect(bunkerUriWithEndpoint(uri, persona)).toBe(
      `bunker://${persona}?relay=wss://a.example&secret=s3cr3t`,
    )
  })

  it('re-addresses a bare link with no query', () => {
    expect(bunkerUriWithEndpoint(`bunker://${master}`, persona)).toBe(`bunker://${persona}`)
  })

  it('rejects a non-bunker URI', () => {
    expect(() => bunkerUriWithEndpoint('nostrconnect://xyz', persona)).toThrow('not a bunker:// URI')
  })

  it('rejects a malformed authority part', () => {
    expect(() => bunkerUriWithEndpoint('bunker://tooshort?secret=s', persona)).toThrow('not a bunker:// URI')
  })

  it('rejects a non-hex endpoint', () => {
    expect(() => bunkerUriWithEndpoint(`bunker://${master}`, 'not-hex')).toThrow('endpoint must be')
    expect(() => bunkerUriWithEndpoint(`bunker://${master}`, master.toUpperCase())).toThrow('endpoint must be')
  })
})
