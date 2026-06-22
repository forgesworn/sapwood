// Serial transport buffer processing tests.
//
// Tests the frame extraction logic without needing a real Web Serial port.
// We test processBytes indirectly by checking what events a chunk produces.

import { afterEach, describe, expect, it, vi } from 'vitest'

afterEach(() => vi.unstubAllGlobals())
import { buildFrame, FrameType, MAGIC } from './frame.js'
import { SerialTransport } from './serial.js'

// A fake WritableStream that enforces the real "one writer at a time" lock, so
// overlapping getWriter() calls throw exactly like the browser's does.
function makeFakePort(opts: { writeDelayMs?: number; hang?: boolean } = {}) {
  let locked = false
  const writes: Uint8Array[] = []
  let aborted = false
  let rejectPending: ((e: unknown) => void) | null = null
  const writable = {
    getWriter() {
      if (locked) throw new TypeError('Cannot create writer when WritableStream is locked')
      locked = true
      return {
        write(d: Uint8Array): Promise<void> {
          if (opts.hang) return new Promise<void>((_, reject) => { rejectPending = reject })
          if (opts.writeDelayMs) {
            return new Promise<void>((r) => setTimeout(() => { writes.push(d); r() }, opts.writeDelayMs))
          }
          writes.push(d)
          return Promise.resolve()
        },
        releaseLock() {
          if (!locked) return
          locked = false
        },
        // Mirrors the real WritableStream: abort rejects the pending write.
        async abort() {
          aborted = true
          locked = false
          if (rejectPending) { rejectPending(new DOMException('aborted', 'AbortError')); rejectPending = null }
        },
      }
    },
  }
  return { port: { writable } as unknown as SerialPort, writes, get aborted() { return aborted } }
}

function transportWith(port: SerialPort): SerialTransport {
  const t = new SerialTransport()
  ;(t as unknown as { port: SerialPort; running: boolean }).port = port
  ;(t as unknown as { running: boolean }).running = true
  return t
}

// We can't instantiate SerialTransport in tests (no navigator.serial),
// so we test the buffer processing logic by extracting it into a testable
// helper. For now, test the frame building/parsing that the transport depends on.

describe('serial frame extraction from mixed data', () => {
  it('finds a frame embedded in log output', () => {
    // Simulate: ESP-IDF log line + frame + more log
    const logBefore = new TextEncoder().encode('I (1234) main: booting\n')
    const frame = buildFrame(FrameType.ACK)
    const logAfter = new TextEncoder().encode('I (1235) main: ready\n')

    const mixed = new Uint8Array(logBefore.length + frame.length + logAfter.length)
    mixed.set(logBefore, 0)
    mixed.set(frame, logBefore.length)
    mixed.set(logAfter, logBefore.length + frame.length)

    // Hunt for magic bytes in the mixed buffer.
    let magicIdx = -1
    for (let i = 0; i <= mixed.length - 2; i++) {
      if (mixed[i] === MAGIC[0] && mixed[i + 1] === MAGIC[1]) {
        magicIdx = i
        break
      }
    }

    expect(magicIdx).toBe(logBefore.length)
  })

  it('handles multiple frames in one chunk', () => {
    const frame1 = buildFrame(FrameType.ACK)
    const frame2 = buildFrame(FrameType.NACK)

    const combined = new Uint8Array(frame1.length + frame2.length)
    combined.set(frame1, 0)
    combined.set(frame2, frame1.length)

    // Find all magic positions.
    const positions: number[] = []
    for (let i = 0; i <= combined.length - 2; i++) {
      if (combined[i] === MAGIC[0] && combined[i + 1] === MAGIC[1]) {
        positions.push(i)
      }
    }

    expect(positions).toEqual([0, frame1.length])
  })

  it('does not false-trigger on partial magic byte', () => {
    // Data containing 0x48 but not followed by 0x57.
    const data = new Uint8Array([0x48, 0x00, 0x48, 0x48, 0x57])
    let magicIdx = -1
    for (let i = 0; i <= data.length - 2; i++) {
      if (data[i] === MAGIC[0] && data[i + 1] === MAGIC[1]) {
        magicIdx = i
        break
      }
    }
    // Should find magic at position 3 (0x48 at [3], 0x57 at [4]).
    expect(magicIdx).toBe(3)
  })

  it('handles empty buffer', () => {
    const data = new Uint8Array(0)
    let magicIdx = -1
    for (let i = 0; i <= data.length - 2; i++) {
      if (data[i] === MAGIC[0] && data[i + 1] === MAGIC[1]) {
        magicIdx = i
        break
      }
    }
    expect(magicIdx).toBe(-1)
  })
})

describe('log line extraction', () => {
  it('splits complete lines', () => {
    const text = 'I (100) main: line one\nI (200) main: line two\npartial'
    const lines = text.split('\n')

    // Complete lines are all but the last.
    const complete = lines.slice(0, -1).map(l => l.trim()).filter(l => l.length > 0)
    const remaining = lines[lines.length - 1]

    expect(complete).toEqual(['I (100) main: line one', 'I (200) main: line two'])
    expect(remaining).toBe('partial')
  })

  it('handles no newlines (all partial)', () => {
    const text = 'partial data without newline'
    const lines = text.split('\n')
    const complete = lines.slice(0, -1)
    expect(complete).toEqual([])
  })

  it('handles trailing newline', () => {
    const text = 'complete line\n'
    const lines = text.split('\n')
    const complete = lines.slice(0, -1).map(l => l.trim()).filter(l => l.length > 0)
    expect(complete).toEqual(['complete line'])
  })
})

describe('buffer accumulation', () => {
  it('concatenates chunks correctly', () => {
    const a = new Uint8Array([1, 2, 3])
    const b = new Uint8Array([4, 5])

    const combined = new Uint8Array(a.length + b.length)
    combined.set(a)
    combined.set(b, a.length)

    expect(Array.from(combined)).toEqual([1, 2, 3, 4, 5])
  })

  it('handles frame split across two chunks', () => {
    const frame = buildFrame(FrameType.POLICY_LIST_RESPONSE, new TextEncoder().encode('[]'))

    // Split the frame in half.
    const half = Math.floor(frame.length / 2)
    const chunk1 = frame.slice(0, half)
    const chunk2 = frame.slice(half)

    // Accumulate.
    const buffer = new Uint8Array(chunk1.length + chunk2.length)
    buffer.set(chunk1)
    buffer.set(chunk2, chunk1.length)

    // Should be identical to the original frame.
    expect(Array.from(buffer)).toEqual(Array.from(frame))
  })
})

describe('write serialisation', () => {
  it('does not throw "locked" when two writes overlap, and preserves order', async () => {
    const fake = makeFakePort({ writeDelayMs: 15 })
    const t = transportWith(fake.port)
    const a = new Uint8Array([1])
    const b = new Uint8Array([2])

    // Fire both before the first resolves — the bug case. Must not throw.
    await Promise.all([t.write(a), t.write(b)])

    expect(fake.writes.map((w) => w[0])).toEqual([1, 2])
  })

  it('a third write still works after two overlapping ones', async () => {
    const fake = makeFakePort({ writeDelayMs: 5 })
    const t = transportWith(fake.port)
    await Promise.all([t.write(new Uint8Array([1])), t.write(new Uint8Array([2]))])
    await t.write(new Uint8Array([3]))
    expect(fake.writes.map((w) => w[0])).toEqual([1, 2, 3])
  })

  it('times out a stalled write, aborts the writer, and reports a recovery hint', async () => {
    const fake = makeFakePort({ hang: true })
    const t = transportWith(fake.port)

    await expect(t.write(new Uint8Array([1]), 20)).rejects.toThrow(/isn't responding|RESET/i)
    expect(fake.aborted).toBe(true)
  })

  it('recovers: a write after a timed-out one is not wedged by the dead chain', async () => {
    const hung = makeFakePort({ hang: true })
    const t = transportWith(hung.port)
    await expect(t.write(new Uint8Array([1]), 20)).rejects.toThrow()

    // Swap in a healthy port (as a reconnect would) and write again.
    const good = makeFakePort()
    ;(t as unknown as { port: SerialPort }).port = good.port
    await t.write(new Uint8Array([9]))
    expect(good.writes.map((w) => w[0])).toEqual([9])
  })
})

describe('reconnect is user-gesture safe', () => {
  it('calls requestPort BEFORE closing the previous port', async () => {
    const order: string[] = []
    const oldClose = vi.fn(async () => { order.push('close-old') })
    const oldPort = { readable: {}, writable: {}, close: oldClose } as unknown as SerialPort
    const newPort = {
      readable: { getReader: () => ({ read: () => new Promise(() => {}), releaseLock() {}, async cancel() {} }) },
      writable: {},
      getInfo: () => ({ usbVendorId: 0x303a, usbProductId: 0x1001 }),
    } as unknown as SerialPort

    const requestPort = vi.fn(async () => { order.push('requestPort'); return newPort })
    vi.stubGlobal('navigator', { serial: { requestPort, getPorts: async () => [] } })

    const t = new SerialTransport()
    ;(t as unknown as { port: SerialPort; running: boolean }).port = oldPort
    ;(t as unknown as { running: boolean }).running = true

    await t.connect()

    // The gesture-critical ordering: requestPort must run before any teardown
    // await (closing the old port), or Chrome rejects it as gesture-less.
    expect(order).toEqual(['requestPort', 'close-old'])
  })
})
