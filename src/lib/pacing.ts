// Write pacing for frames that could overrun a UART board's 4KB driver ring
// (identity-card avatars ~8KB, OTA chunks 4KB). Two phases, measured against a
// live T-Display (v0.9.10) in wifi mode: its relay loop polls USB as rarely as
// once a second, so the HEAD of a frame must drip in slower than 4KB/s or the
// ring overflows before the firmware latches on. Once latched, the firmware
// blocks draining the rest of the frame continuously, so the tail can cruise
// at heartwood-bridge's proven 64B/6ms.
//
// Shared by the Web Serial transport and the CLI's Node transport so both
// speak to UART-bridge boards with the same measured cadence.

export const PACE_THRESHOLD = 512
const PACE_CHUNK = 64
const PACE_HEAD_BYTES = 3072
const PACE_HEAD_GAP_MS = 24
const PACE_GAP_MS = 6

export interface PacedSlice {
  bytes: Uint8Array
  /** Delay to insert after writing this slice (0 on the last). */
  gapMs: number
}

/** Slice a frame into paced writes. Small frames yield a single slice. */
export function* paceSlices(data: Uint8Array): Generator<PacedSlice> {
  if (data.length <= PACE_THRESHOLD) {
    yield { bytes: data, gapMs: 0 }
    return
  }
  for (let o = 0; o < data.length; o += PACE_CHUNK) {
    yield {
      bytes: data.subarray(o, Math.min(o + PACE_CHUNK, data.length)),
      gapMs: o + PACE_CHUNK < data.length
        ? (o < PACE_HEAD_BYTES ? PACE_HEAD_GAP_MS : PACE_GAP_MS)
        : 0,
    }
  }
}
