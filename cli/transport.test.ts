// NodeSerialTransport against a fake port: framing, round trips, pacing.

import { describe, expect, it } from 'vitest'
import { FrameType, buildFrame } from '../src/lib/frame.js'
import { PACE_THRESHOLD } from '../src/lib/pacing.js'
import { NodeSerialTransport } from './transport.js'
import type { PortLike } from './transport.js'

type Handler = (arg?: unknown) => void

function fakePort() {
  const handlers = new Map<string, Handler[]>()
  const writes: Uint8Array[] = []
  const port: PortLike = {
    write(data, cb) {
      writes.push(new Uint8Array(data))
      cb(null)
    },
    drain(cb) {
      cb(null)
    },
    close(cb) {
      emit('close')
      cb(null)
    },
    on(event, listener) {
      const list = handlers.get(event) ?? []
      list.push(listener)
      handlers.set(event, list)
    },
  }
  const emit = (event: string, arg?: unknown) => {
    for (const h of handlers.get(event) ?? []) h(arg)
  }
  return {
    port,
    writes,
    /** Deliver device bytes on the next tick, as serialport would. */
    receive(bytes: Uint8Array) {
      setTimeout(() => emit('data', Buffer.from(bytes)), 0)
    },
  }
}

describe('NodeSerialTransport', () => {
  it('resolves a round trip with the expected frame type', async () => {
    const f = fakePort()
    const t = NodeSerialTransport.wrap(f.port)
    const request = buildFrame(FrameType.PROVISION_LIST)
    const pending = t.sendAndReceive(request, [FrameType.PROVISION_LIST_RESPONSE], 1_000)
    f.receive(buildFrame(FrameType.PROVISION_LIST_RESPONSE, new TextEncoder().encode('[]')))
    const resp = await pending
    expect(resp.type).toBe(FrameType.PROVISION_LIST_RESPONSE)
    expect(f.writes[0]).toEqual(request)
  })

  it('ignores frames of other types while waiting', async () => {
    const f = fakePort()
    const t = NodeSerialTransport.wrap(f.port)
    const pending = t.sendAndReceive(buildFrame(FrameType.PROVISION_LIST), [FrameType.PROVISION_LIST_RESPONSE], 1_000)
    f.receive(buildFrame(FrameType.OTA_STATUS, new Uint8Array([0])))
    f.receive(buildFrame(FrameType.PROVISION_LIST_RESPONSE, new TextEncoder().encode('[]')))
    const resp = await pending
    expect(resp.type).toBe(FrameType.PROVISION_LIST_RESPONSE)
  })

  it('times out when the device stays silent', async () => {
    const f = fakePort()
    const t = NodeSerialTransport.wrap(f.port)
    await expect(
      t.sendAndReceive(buildFrame(FrameType.PROVISION_LIST), [FrameType.PROVISION_LIST_RESPONSE], 40),
    ).rejects.toThrow(/No response/)
  })

  it('serialises round trips so a shared response type cannot be stolen', async () => {
    const f = fakePort()
    const t = NodeSerialTransport.wrap(f.port)
    // Both requests expect ACK. The second must not resolve from the first's
    // response: writes happen strictly one round trip at a time.
    const first = t.sendAndReceive(buildFrame(FrameType.SET_PIN, new Uint8Array([1])), [FrameType.ACK], 1_000)
    const second = t.sendAndReceive(buildFrame(FrameType.FACTORY_RESET), [FrameType.ACK], 1_000)
    f.receive(buildFrame(FrameType.ACK))
    await first
    expect(f.writes).toHaveLength(1) // second not yet written
    f.receive(buildFrame(FrameType.ACK))
    await second
    expect(f.writes).toHaveLength(2)
  })

  it('emits device text as log lines alongside frames', async () => {
    const f = fakePort()
    const t = NodeSerialTransport.wrap(f.port)
    const logs: string[] = []
    t.on((e) => {
      if (e.kind === 'log') logs.push(e.line)
    })
    const pending = t.sendAndReceive(buildFrame(FrameType.PROVISION_LIST), [FrameType.PROVISION_LIST_RESPONSE], 1_000)
    const enc = new TextEncoder()
    const mixed = new Uint8Array([
      ...enc.encode('I (99) relay: connected\n'),
      ...buildFrame(FrameType.PROVISION_LIST_RESPONSE, enc.encode('[]')),
    ])
    f.receive(mixed)
    await pending
    expect(logs).toEqual(['I (99) relay: connected'])
  })

  it('paces frames above the UART threshold into small writes', async () => {
    const f = fakePort()
    const t = NodeSerialTransport.wrap(f.port)
    const big = new Uint8Array(PACE_THRESHOLD + 100)
    await t.write(big)
    expect(f.writes.length).toBeGreaterThan(1)
    expect(Math.max(...f.writes.map((w) => w.length))).toBeLessThanOrEqual(64)
    expect(f.writes.reduce((n, w) => n + w.length, 0)).toBe(big.length)
  })

  it('rejects the active round trip when the port closes', async () => {
    const f = fakePort()
    const t = NodeSerialTransport.wrap(f.port)
    const pending = t.sendAndReceive(buildFrame(FrameType.PROVISION_LIST), [FrameType.PROVISION_LIST_RESPONSE], 1_000)
    await t.close()
    await expect(pending).rejects.toThrow(/disconnected/i)
  })
})
