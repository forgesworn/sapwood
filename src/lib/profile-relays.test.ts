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
    expect(isValidRelayUrl('  wss://relay.example.net  ')).toBe(true)
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

  it('has no write target by default', () => {
    expect(DEFAULT_PROFILE_RELAYS.length).toBeGreaterThan(0)
    expect(DEFAULT_PROFILE_RELAYS.filter((r) => r.write)).toEqual([])
  })

  it('round-trips a stored list with read/write flags', () => {
    setProfileRelays([
      { url: 'wss://a.example', write: true },
      { url: 'wss://b.example', write: false },
    ])
    expect(getProfileRelays()).toEqual([
      { url: 'wss://a.example', write: true },
      { url: 'wss://b.example', write: false },
    ])
  })

  it('trims, drops invalid entries, and de-duplicates on save', () => {
    setProfileRelays([
      { url: '  wss://a.example  ', write: false },
      { url: 'http://nope', write: true },
      { url: 'wss://a.example', write: true },
      { url: 'wss://b.example', write: false },
    ])
    expect(getProfileRelays()).toEqual([
      { url: 'wss://a.example', write: false },
      { url: 'wss://b.example', write: false },
    ])
  })

  it('migrates the legacy string[] shape as read-only', () => {
    localStorage.setItem(
      'heartwood.profileRelays',
      JSON.stringify(['wss://relay.example.net', 'wss://purplepag.es']),
    )
    expect(getProfileRelays()).toEqual([
      { url: 'wss://relay.example.net', write: false },
      { url: 'wss://purplepag.es', write: false },
    ])
  })

  it('falls back to the default if the stored value is unusable', () => {
    localStorage.setItem('heartwood.profileRelays', '["http://nope","garbage"]')
    expect(getProfileRelays()).toEqual(DEFAULT_PROFILE_RELAYS)
    localStorage.setItem('heartwood.profileRelays', 'not json')
    expect(getProfileRelays()).toEqual(DEFAULT_PROFILE_RELAYS)
    localStorage.setItem('heartwood.profileRelays', '{"url":"wss://a.example"}')
    expect(getProfileRelays()).toEqual(DEFAULT_PROFILE_RELAYS)
  })
})
