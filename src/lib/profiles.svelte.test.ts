import { describe, it, expect, vi, beforeEach } from 'vitest'

// Inject a fake resolver so the cache logic is tested without a relay.
const { resolveMock } = vi.hoisted(() => ({ resolveMock: vi.fn() }))
vi.mock('./profiles.js', async (orig) => {
  const actual = await orig<typeof import('./profiles.js')>()
  return { ...actual, resolveProfiles: resolveMock }
})
vi.mock('./profile-relays.js', () => ({ getProfileRelays: () => ['wss://relay.test'] }))

import { ensureProfiles, profileName, clearProfileCache } from './profiles.svelte.js'

const PK_A = 'a'.repeat(64)
const PK_B = 'b'.repeat(64)

beforeEach(() => {
  clearProfileCache()
  resolveMock.mockReset()
})

describe('profile name cache (profiles.svelte.ts)', () => {
  it('resolves and caches a name, looked up case-insensitively', async () => {
    resolveMock.mockResolvedValue(new Map([[PK_A, { name: 'alice' }]]))
    await ensureProfiles([PK_A.toUpperCase()])
    expect(profileName(PK_A)).toBe('alice')
    expect(profileName(PK_A.toUpperCase())).toBe('alice')
  })

  it('does not re-fetch a pubkey already known', async () => {
    resolveMock.mockResolvedValue(new Map([[PK_B, { name: 'bob' }]]))
    await ensureProfiles([PK_B])
    await ensureProfiles([PK_B])
    expect(resolveMock).toHaveBeenCalledTimes(1)
  })

  it('remembers a miss as "no name" and stops retrying', async () => {
    resolveMock.mockResolvedValue(new Map())
    await ensureProfiles([PK_A])
    expect(profileName(PK_A)).toBeUndefined()
    await ensureProfiles([PK_A])
    expect(resolveMock).toHaveBeenCalledTimes(1)
  })

  it('ignores malformed pubkeys without fetching', async () => {
    await ensureProfiles(['not-hex', ''])
    expect(resolveMock).not.toHaveBeenCalled()
  })

  it('keeps quiet (no name) when the resolver rejects', async () => {
    resolveMock.mockRejectedValue(new Error('relay down'))
    await ensureProfiles([PK_A])
    expect(profileName(PK_A)).toBeUndefined()
  })

  it('clearProfileCache forgets resolved names', async () => {
    resolveMock.mockResolvedValue(new Map([[PK_A, { name: 'alice' }]]))
    await ensureProfiles([PK_A])
    expect(profileName(PK_A)).toBe('alice')
    clearProfileCache()
    expect(profileName(PK_A)).toBeUndefined()
  })
})
