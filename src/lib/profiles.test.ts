import { describe, it, expect, vi } from 'vitest'
import { parseKind0Content, profileDisplayName, resolveProfiles, type Kind0Event } from './profiles.js'

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

describe('resolveProfiles — mirroring to write relays', () => {
  const PK_A = 'a'.repeat(64)
  const PK_B = 'b'.repeat(64)

  const signed = (pubkey: string, created_at: number, name: string): Kind0Event => ({
    pubkey,
    created_at,
    content: JSON.stringify({ name }),
    id: `${name}-id`,
    sig: `${name}-sig`,
    kind: 0,
    tags: [],
  })

  const RELAYS = [
    { url: 'wss://rw.example', write: true },
    { url: 'wss://ro.example', write: false },
  ]

  it('reads from every relay but publishes only the newest signed event, to write relays only', async () => {
    const old = signed(PK_A, 100, 'old')
    const fresh = signed(PK_A, 200, 'new')
    const fetchKind0 = vi.fn(async () => [old, fresh, signed(PK_B, 50, 'bee')])
    const publishKind0 = vi.fn(async () => {})

    const map = await resolveProfiles([PK_A, PK_B], RELAYS, fetchKind0, publishKind0)

    expect(fetchKind0).toHaveBeenCalledWith(['wss://rw.example', 'wss://ro.example'], [PK_A, PK_B])
    expect(map.get(PK_A)?.name).toBe('new')
    expect(publishKind0).toHaveBeenCalledTimes(1)
    const [urls, events] = publishKind0.mock.calls[0] as unknown as [string[], Kind0Event[]]
    expect(urls).toEqual(['wss://rw.example'])
    expect(events.map((e) => e.id).sort()).toEqual(['bee-id', 'new-id'])
  })

  it('does not publish events missing id/sig (nothing verifiable to mirror)', async () => {
    const bare: Kind0Event = { pubkey: PK_A, created_at: 1, content: JSON.stringify({ name: 'x' }) }
    const publishKind0 = vi.fn(async () => {})
    await resolveProfiles([PK_A], RELAYS, async () => [bare], publishKind0)
    expect(publishKind0).not.toHaveBeenCalled()
  })

  it('does not publish when no relay is marked write', async () => {
    const publishKind0 = vi.fn(async () => {})
    await resolveProfiles([PK_A], ['wss://ro.example'], async () => [signed(PK_A, 1, 'x')], publishKind0)
    expect(publishKind0).not.toHaveBeenCalled()
  })

  it('still resolves names when the publish fails', async () => {
    const publishKind0 = vi.fn(async () => {
      throw new Error('write relay down')
    })
    const map = await resolveProfiles([PK_A], RELAYS, async () => [signed(PK_A, 1, 'x')], publishKind0)
    expect(map.get(PK_A)?.name).toBe('x')
    // let the fire-and-forget rejection settle so it cannot fail the test run
    await new Promise((r) => setTimeout(r, 0))
  })
})
