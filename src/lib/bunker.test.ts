import { describe, it, expect } from 'vitest'
import { bunkerHasRelay } from './bunker.js'

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
