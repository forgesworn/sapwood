import { describe, it, expect } from 'vitest'
import { parseKind0Content, profileDisplayName, resolveProfiles } from './profiles.js'

describe('parseKind0Content', () => {
  it('parses name, display_name, picture and nip05', () => {
    const p = parseKind0Content(
      JSON.stringify({
        name: 'alice',
        display_name: 'Alice',
        picture: 'https://x/a.png',
        nip05: 'alice@x.com',
      }),
    )
    expect(p).toEqual({
      name: 'alice',
      display_name: 'Alice',
      picture: 'https://x/a.png',
      nip05: 'alice@x.com',
    })
  })

  it('derives name from display_name / displayName when name is absent', () => {
    expect(parseKind0Content(JSON.stringify({ display_name: 'Bob' }))?.name).toBe('Bob')
    expect(parseKind0Content(JSON.stringify({ displayName: 'Cara' }))?.name).toBe('Cara')
  })

  it('returns null for non-JSON or non-object content', () => {
    expect(parseKind0Content('not json')).toBeNull()
    expect(parseKind0Content('"just a string"')).toBeNull()
    expect(parseKind0Content('42')).toBeNull()
    expect(parseKind0Content('null')).toBeNull()
  })

  it('ignores non-string fields', () => {
    const p = parseKind0Content(JSON.stringify({ name: 123, picture: { u: 1 } }))
    expect(p).toEqual({ name: '', display_name: undefined, picture: undefined, nip05: undefined })
  })
})

describe('profileDisplayName', () => {
  it('prefers display_name, then name, then empty', () => {
    expect(profileDisplayName({ name: 'alice', display_name: 'Alice' })).toBe('Alice')
    expect(profileDisplayName({ name: 'alice' })).toBe('alice')
    expect(profileDisplayName({ name: '' })).toBe('')
  })
})

describe('resolveProfiles', () => {
  const PK_A = 'a'.repeat(64)
  const PK_B = 'b'.repeat(64)

  it('returns the newest kind-0 per author', async () => {
    const fetchKind0 = async () => [
      { pubkey: PK_A, created_at: 100, content: JSON.stringify({ name: 'old' }) },
      { pubkey: PK_A, created_at: 200, content: JSON.stringify({ name: 'new' }) },
      { pubkey: PK_B, created_at: 50, content: JSON.stringify({ display_name: 'Bee' }) },
    ]
    const map = await resolveProfiles([PK_A, PK_B], ['wss://r'], fetchKind0)
    expect(map.get(PK_A)?.name).toBe('new')
    expect(map.get(PK_B)?.display_name).toBe('Bee')
  })

  it('skips authors whose content does not parse', async () => {
    const fetchKind0 = async () => [{ pubkey: PK_A, created_at: 1, content: 'garbage' }]
    const map = await resolveProfiles([PK_A], ['wss://r'], fetchKind0)
    expect(map.has(PK_A)).toBe(false)
  })

  it('returns empty for no pubkeys or no relays, without fetching', async () => {
    let called = false
    const fetchKind0 = async () => {
      called = true
      return []
    }
    expect((await resolveProfiles([], ['wss://r'], fetchKind0)).size).toBe(0)
    expect((await resolveProfiles([PK_A], [], fetchKind0)).size).toBe(0)
    expect(called).toBe(false)
  })

  it('never rejects when the fetch throws', async () => {
    const fetchKind0 = async () => {
      throw new Error('relay down')
    }
    const map = await resolveProfiles([PK_A], ['wss://r'], fetchKind0)
    expect(map.size).toBe(0)
  })
})
