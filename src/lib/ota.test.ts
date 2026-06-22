import { describe, it, expect, vi } from 'vitest'
import { streamOta, OtaStatus, OtaError, OTA_CHUNK_SIZE, type OtaTransport } from './ota.js'
import { FrameType } from './frame.js'

// A scripted transport: returns the given OTA_STATUS byte per call, in order,
// and records every frame it was asked to send so we can inspect the protocol.
function scripted(statuses: number[]) {
  const calls: Uint8Array[] = []
  let i = 0
  const transport: OtaTransport = {
    async sendAndReceive(frame) {
      calls.push(frame)
      const status = statuses[i++]
      return { type: FrameType.OTA_STATUS, payload: new Uint8Array([status ?? 0xff]) }
    },
  }
  return { transport, calls }
}

// Frame layout: [0x48 0x57][type][len_be16][payload...][crc32]. Payload starts at 5.
const frameType = (f: Uint8Array) => f[2]
const payloadOf = (f: Uint8Array) => f.subarray(5, f.length - 4)
const be32 = (b: Uint8Array, at = 0) => (b[at]! << 24) | (b[at + 1]! << 16) | (b[at + 2]! << 8) | b[at + 3]!

function bytes(n: number): Uint8Array {
  const d = new Uint8Array(n)
  for (let i = 0; i < n; i++) d[i] = i & 0xff
  return d
}

describe('streamOta', () => {
  it('begins, streams every chunk in order, and verifies', async () => {
    const data = bytes(10_000) // → 3 chunks: 4096, 4096, 1808
    const nChunks = Math.ceil(data.length / OTA_CHUNK_SIZE)
    const { transport, calls } = scripted([
      OtaStatus.READY,
      ...Array(nChunks).fill(OtaStatus.CHUNK_OK),
      OtaStatus.VERIFIED,
    ])

    const phases: string[] = []
    const progress: number[] = []
    await streamOta(transport, data, {
      onPhase: (p) => phases.push(p),
      onProgress: (pct) => progress.push(pct),
    })

    // BEGIN → nChunks × CHUNK → FINISH.
    expect(calls).toHaveLength(2 + nChunks)
    expect(frameType(calls[0]!)).toBe(FrameType.OTA_BEGIN)
    expect(frameType(calls.at(-1)!)).toBe(FrameType.OTA_FINISH)

    // BEGIN payload carries the byte length + a 32-byte hash.
    const begin = payloadOf(calls[0]!)
    expect(be32(begin)).toBe(data.length)
    expect(begin.length).toBe(4 + 32)

    // Chunks cover the whole image at rising offsets.
    const chunkFrames = calls.slice(1, 1 + nChunks)
    let expectedOffset = 0
    for (const cf of chunkFrames) {
      expect(frameType(cf)).toBe(FrameType.OTA_CHUNK)
      expect(be32(payloadOf(cf))).toBe(expectedOffset)
      expectedOffset += OTA_CHUNK_SIZE
    }

    expect(phases).toEqual(['waiting', 'uploading', 'verifying'])
    expect(progress.at(-1)).toBe(100)
  })

  it('throws a friendly error when the device rejects the begin (too big)', async () => {
    const { transport } = scripted([OtaStatus.ERR_SIZE])
    await expect(streamOta(transport, bytes(4096))).rejects.toMatchObject({
      name: 'OtaError',
      status: OtaStatus.ERR_SIZE,
    })
    await expect(streamOta(scripted([OtaStatus.ERR_SIZE]).transport, bytes(4096)))
      .rejects.toThrow(/too big/i)
  })

  it('treats a non-READY begin as "did you approve on the device?"', async () => {
    const { transport } = scripted([0xff]) // unknown / not ready
    await expect(streamOta(transport, bytes(100))).rejects.toThrow(/hold its button to approve/i)
  })

  it('stops and reports when a chunk is rejected', async () => {
    const { transport, calls } = scripted([OtaStatus.READY, OtaStatus.ERR_WRITE])
    await expect(streamOta(transport, bytes(10_000))).rejects.toBeInstanceOf(OtaError)
    // It must not have sent FINISH after a failed chunk.
    expect(calls.some((f) => frameType(f) === FrameType.OTA_FINISH)).toBe(false)
  })

  it('surfaces a checksum failure at verification as a kept-current-firmware message', async () => {
    const data = bytes(4096)
    const { transport } = scripted([OtaStatus.READY, OtaStatus.CHUNK_OK, OtaStatus.ERR_HASH])
    await expect(streamOta(transport, data)).rejects.toThrow(/checksum|kept its current/i)
  })

  it('reports verifying before it fails', async () => {
    const onPhase = vi.fn()
    const { transport } = scripted([OtaStatus.READY, OtaStatus.CHUNK_OK, OtaStatus.ERR_HASH])
    await expect(streamOta(transport, bytes(4096), { onPhase })).rejects.toThrow()
    expect(onPhase).toHaveBeenCalledWith('verifying')
  })
})
