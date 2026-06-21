import { describe, it, expect, vi } from 'vitest'
import { looksLikeBridge, probeBridge } from './bridge-probe'

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const html = (status = 200) =>
  new Response('<!DOCTYPE html><html></html>', { status, headers: { 'content-type': 'text/html' } })

describe('looksLikeBridge', () => {
  it('accepts a JSON 200', async () => {
    expect(await looksLikeBridge(json({ tier: 'soft' }))).toBe(true)
  })
  it('rejects an HTML 200 (the SPA fallback)', async () => {
    expect(await looksLikeBridge(html(200))).toBe(false)
  })
  it('rejects non-2xx', async () => {
    expect(await looksLikeBridge(json({}, 404))).toBe(false)
    expect(await looksLikeBridge(html(404))).toBe(false)
  })
  it('rejects null', async () => {
    expect(await looksLikeBridge(null)).toBe(false)
  })
})

describe('probeBridge', () => {
  it('returns true when /api/info is a JSON bridge reply', async () => {
    const fetchImpl = vi.fn(async (url: string) =>
      url.endsWith('/api/info') ? json({ tier: 'soft' }) : html(404),
    ) as unknown as typeof fetch
    expect(await probeBridge('https://pi.local', fetchImpl)).toBe(true)
  })

  it('falls back to /api/bridge/info', async () => {
    const fetchImpl = vi.fn(async (url: string) =>
      url.endsWith('/api/bridge/info') ? json({ masters: [] }) : new Response('', { status: 404 }),
    ) as unknown as typeof fetch
    expect(await probeBridge('https://pi.local', fetchImpl)).toBe(true)
  })

  it('returns false on a static host that 200s with index.html', async () => {
    const fetchImpl = vi.fn(async () => html(200)) as unknown as typeof fetch
    expect(await probeBridge('https://sapwood.forgesworn.dev', fetchImpl)).toBe(false)
  })

  it('returns false on 404 everywhere', async () => {
    const fetchImpl = vi.fn(async () => new Response('', { status: 404 })) as unknown as typeof fetch
    expect(await probeBridge('https://example.com', fetchImpl)).toBe(false)
  })

  it('returns false when fetch rejects (network error)', async () => {
    const fetchImpl = vi.fn(async () => { throw new Error('network') }) as unknown as typeof fetch
    expect(await probeBridge('https://offline', fetchImpl)).toBe(false)
  })
})
