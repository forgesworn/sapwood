import { describe, expect, it, vi } from 'vitest'
import { nip19 } from 'nostr-tools'
import { wrappedRequest, type WrappedConnection } from './wrapped-account.js'
import { FrameType } from './frame.js'

const a = nip19.npubEncode('11'.repeat(32))
const b = nip19.npubEncode('22'.repeat(32))
const root = { slot: 0, npub: a, mode: 1 }
const target = { slot: 1, npub: b, mode: 0 }
const record = 'nstw1:' + 'A'.repeat(175)
function connection(): WrappedConnection {
  return {
    mode: 'serial', connected: true,
    masters: [{ ...root, label: 'root' }, { ...target, label: 'imported' }],
    firmware: vi.fn(async () => ({ capabilities: ['wrapped_nsec_usb_v1'] })),
    authenticate: vi.fn(async () => {}),
    exchange: vi.fn(async () => ({ type: FrameType.WRAPPED_NSEC_RESP, payload: new TextEncoder().encode(JSON.stringify({ op: 'wrap', npub: b, record })) })),
  }
}
describe('device wrapped accounts', () => {
  it('refuses unsupported transports and firmware before authenticating or sending a key operation', async () => {
    for (const mode of ['relay', 'http']) {
      const c = connection(); c.mode = mode
      await expect(wrappedRequest(c, { op: 'wrap', root, target })).rejects.toThrow(/USB/)
      expect(c.exchange).not.toHaveBeenCalled()
    }
    const c = connection(); vi.mocked(c.firmware).mockResolvedValue({ capabilities: [] })
    await expect(wrappedRequest(c, { op: 'wrap', root, target })).rejects.toThrow(/firmware/)
    expect(c.authenticate).not.toHaveBeenCalled()
    expect(c.exchange).not.toHaveBeenCalled()
  })
  it('requires authentication, binds both exact identities and never retries an uncertain operation', async () => {
    const c = connection()
    vi.mocked(c.exchange).mockRejectedValue(new Error('lost reply'))
    await expect(wrappedRequest(c, { op: 'wrap', root, target })).rejects.toThrow(/lost reply/)
    expect(c.authenticate).toHaveBeenCalledOnce()
    expect(c.exchange).toHaveBeenCalledOnce()
    expect(vi.mocked(c.exchange).mock.calls[0]?.[0]).toEqual({ op: 'wrap', root, target })
  })
  it('refuses personas, non-raw targets, stale mode and existing destination slots', async () => {
    const c = connection()
    for (const bad of [{ ...target, mode: 2 }, { ...target, npub: a }]) {
      await expect(wrappedRequest(c, { op: 'wrap', root, target: bad })).rejects.toThrow()
    }
    await expect(wrappedRequest(c, { op: 'restore', root, record, expected_npub: b, destination: 1, label: 'new' })).rejects.toThrow(/empty/)
    c.masters[1]!.persona = true
    await expect(wrappedRequest(c, { op: 'wrap', root, target })).rejects.toThrow()
    expect(c.exchange).not.toHaveBeenCalled()
  })
  it('rejects malformed files and mismatched public receipts', async () => {
    const c = connection()
    await expect(wrappedRequest(c, { op: 'check', root, record: record + '=', expected_npub: b })).rejects.toThrow(/file/)
    vi.mocked(c.exchange).mockResolvedValue({ type: FrameType.WRAPPED_NSEC_RESP, payload: new TextEncoder().encode(JSON.stringify({ op: 'check', npub: a })) })
    await expect(wrappedRequest(c, { op: 'check', root, record, expected_npub: b })).rejects.toThrow(/identity/)
  })
})
