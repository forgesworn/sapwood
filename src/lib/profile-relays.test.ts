import { describe, it, expect, afterEach } from 'vitest'
import {
  isValidRelayUrl,
  getProfileRelays,
  setProfileRelays,
  DEFAULT_PROFILE_RELAYS,
} from './profile-relays.js'

afterEach(() => localStorage.clear())

describe('isValidRelayUrl', () => {
  it('accepts wss:// URLs (whitespace trimmed)', () => {
    expect(isValidRelayUrl('wss://relay.example.com')).toBe(true)
    expect(isValidRelayUrl('  wss://relay.trotters.cc  ')).toBe(true)
  })

  it('accepts ws:// only against localhost (dev)', () => {
    expect(isValidRelayUrl('ws://localhost:7777')).toBe(true)
    expect(isValidRelayUrl('ws://127.0.0.1:7777')).toBe(true)
    expect(isValidRelayUrl('ws://relay.example.com')).toBe(false)
  })

  it('rejects non-relay schemes and malformed URLs', () => {
    expect(isValidRelayUrl('https://relay.example.com')).toBe(false)
    expect(isValidRelayUrl('relay.example.com')).toBe(false)
    expect(isValidRelayUrl('')).toBe(false)
    expect(isValidRelayUrl('not a url')).toBe(false)
  })
})

describe('getProfileRelays / setProfileRelays', () => {
  it('returns the default when nothing is stored', () => {
    expect(getProfileRelays()).toEqual(DEFAULT_PROFILE_RELAYS)
  })

  it('round-trips a stored list', () => {
    setProfileRelays(['wss://a.example', 'wss://b.example'])
    expect(getProfileRelays()).toEqual(['wss://a.example', 'wss://b.example'])
  })

  it('trims, drops invalid entries, and de-duplicates on save', () => {
    setProfileRelays(['  wss://a.example  ', 'http://nope', 'wss://a.example', 'wss://b.example'])
    expect(getProfileRelays()).toEqual(['wss://a.example', 'wss://b.example'])
  })

  it('falls back to the default if the stored value is unusable', () => {
    localStorage.setItem('heartwood.profileRelays', '["http://nope","garbage"]')
    expect(getProfileRelays()).toEqual(DEFAULT_PROFILE_RELAYS)
    localStorage.setItem('heartwood.profileRelays', 'not json')
    expect(getProfileRelays()).toEqual(DEFAULT_PROFILE_RELAYS)
  })
})
