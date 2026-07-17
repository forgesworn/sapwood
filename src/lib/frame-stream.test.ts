// FrameStream: the byte-stream splitter shared by the Web Serial transport
// and the CLI. These exercise the real feed() path — the earlier serial tests
// could only simulate the hunt because the logic lived inside SerialTransport.

import { describe, expect, it } from 'vitest'
import { buildFrame, FrameType, HEADER_SIZE } from './frame.js'
import type { Frame } from './frame.js'
import { FrameStream } from './frame-stream.js'

function collector() {
  const frames: Frame[] = []
  const logs: string[] = []
  const stream = new FrameStream({
    onFrame: (f) => frames.push(f),
    onLog: (l) => logs.push(l),
  })
  return { stream, frames, logs }
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let o = 0
  for (const p of parts) {
    out.set(p, o)
    o += p.length
  }
  return out
}

describe('FrameStream', () => {
  it('extracts a frame embedded in log output', () => {
    const { stream, frames, logs } = collector()
    const enc = new TextEncoder()
    stream.feed(concat(
      enc.encode('I (1234) main: booting\n'),
      buildFrame(FrameType.ACK),
      enc.encode('I (1235) main: ready\n'),
    ))
    expect(frames.map((f) => f.type)).toEqual([FrameType.ACK])
    expect(logs).toEqual(['I (1234) main: booting', 'I (1235) main: ready'])
  })

  it('extracts multiple frames from one chunk', () => {
    const { stream, frames } = collector()
    stream.feed(concat(buildFrame(FrameType.ACK), buildFrame(FrameType.NACK)))
    expect(frames.map((f) => f.type)).toEqual([FrameType.ACK, FrameType.NACK])
  })

  it('reassembles a frame split across chunks at every offset', () => {
    const frame = buildFrame(FrameType.PROVISION_LIST_RESPONSE, new TextEncoder().encode('[]'))
    for (let split = 1; split < frame.length; split++) {
      const { stream, frames } = collector()
      stream.feed(frame.slice(0, split))
      expect(frames).toHaveLength(0)
      stream.feed(frame.slice(split))
      expect(frames).toHaveLength(1)
      expect(frames[0]!.type).toBe(FrameType.PROVISION_LIST_RESPONSE)
    }
  })

  it('resynchronises past a corrupt oversized length', () => {
    const { stream, frames } = collector()
    // Magic followed by an impossible length, then a good frame.
    const corrupt = new Uint8Array([0x48, 0x57, 0x06, 0xff, 0xff])
    stream.feed(concat(corrupt, buildFrame(FrameType.ACK)))
    expect(frames.map((f) => f.type)).toEqual([FrameType.ACK])
  })

  it('resynchronises past a bad CRC', () => {
    const { stream, frames } = collector()
    const broken = buildFrame(FrameType.ACK)
    broken[broken.length - 1]! ^= 0xff
    stream.feed(concat(broken, buildFrame(FrameType.NACK)))
    expect(frames.map((f) => f.type)).toEqual([FrameType.NACK])
  })

  it('does not false-trigger on a lone magic first byte', () => {
    const { stream, frames, logs } = collector()
    stream.feed(new Uint8Array([0x48, 0x00]))
    stream.feed(new TextEncoder().encode(' plain text\n'))
    expect(frames).toHaveLength(0)
    expect(logs).toEqual(['H\u0000 plain text'.trim()])
  })

  it('holds a partial header until more bytes arrive', () => {
    const { stream, frames } = collector()
    const frame = buildFrame(FrameType.ACK)
    stream.feed(frame.slice(0, HEADER_SIZE - 1))
    expect(frames).toHaveLength(0)
    stream.feed(frame.slice(HEADER_SIZE - 1))
    expect(frames.map((f) => f.type)).toEqual([FrameType.ACK])
  })

  it('emits complete log lines and buffers the fragment', () => {
    const { stream, logs } = collector()
    const enc = new TextEncoder()
    stream.feed(enc.encode('line one\nline tw'))
    expect(logs).toEqual(['line one'])
    stream.feed(enc.encode('o\n'))
    expect(logs).toEqual(['line one', 'line two'])
  })

  it('reset drops buffered partial state', () => {
    const { stream, frames, logs } = collector()
    const frame = buildFrame(FrameType.ACK)
    stream.feed(frame.slice(0, 4))
    stream.feed(new TextEncoder().encode('dangling'))
    stream.reset()
    stream.feed(buildFrame(FrameType.NACK))
    expect(frames.map((f) => f.type)).toEqual([FrameType.NACK])
    expect(logs).toEqual([])
  })
})
