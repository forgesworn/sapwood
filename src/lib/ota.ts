// Over-the-air firmware streaming over the frame protocol, factored out of the
// UI so the (untested) transfer loop can be exercised against a fake transport.
//
// Flow (Web Serial): OTA_BEGIN [size_be32][sha256_32][signature_64] → device
// checks the ed25519 release signature, clears the spare OTA slot and replies
// OTA_STATUS=READY (after a physical button-hold approval); then OTA_CHUNK
// [offset_be32][bytes] per 4 KB, each acked CHUNK_OK; then OTA_FINISH, which
// re-hashes the written image, re-checks the signature over the computed
// digest, and replies VERIFIED (or an error and an automatic rollback).
// Pre-signature firmware only understands the 36-byte unsigned OTA_BEGIN.
// Later pre-signature builds answer the signed form with ERR_SIZE; the oldest
// (v0.9.7 on a live Heltec V4) drop it without replying at all. streamOta
// falls back to the legacy form on either signal — an ERR_SIZE reply or a
// begin timeout — which is how a device gets updated INTO enforcement.
// The device never accepts OTA over the relay — this is USB-only by design.

import { FrameType, buildFrame, type FrameTypeValue } from './frame.js'

/** OTA status codes — payload byte 0 of an OTA_STATUS frame (mirrors common/src/types.rs). */
export const OtaStatus = {
  READY: 0x00,
  CHUNK_OK: 0x01,
  VERIFIED: 0x02,
  ERR_HASH: 0x10,
  ERR_SIZE: 0x11,
  ERR_WRITE: 0x12,
  ERR_NOT_STARTED: 0x13,
  ERR_SIG: 0x14,
} as const

/** Bytes per OTA_CHUNK. Matches the device's receive buffer expectations. */
export const OTA_CHUNK_SIZE = 4096

/** The phase the transfer is in, for UI feedback. */
export type OtaPhase = 'waiting' | 'uploading' | 'verifying'

export interface OtaCallbacks {
  /** Called as each chunk is acked: percent 0–100, bytes sent, total. */
  onProgress?: (percent: number, sent: number, total: number) => void
  /** Called when the transfer moves between phases. */
  onPhase?: (phase: OtaPhase) => void
}

/** The slice of a transport that OTA needs — kept minimal so tests can fake it. */
export interface OtaTransport {
  sendAndReceive(
    frame: Uint8Array,
    expectedTypes: FrameTypeValue[],
    timeoutMs: number,
  ): Promise<{ type: number; payload: Uint8Array }>
}

/** A failed OTA, carrying the device status code (if any) for diagnostics. */
export class OtaError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message)
    this.name = 'OtaError'
  }
}

function be32(n: number): Uint8Array {
  return new Uint8Array([(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff])
}

/** Plain-language explanation for a non-READY response to OTA_BEGIN. */
function beginError(status: number | undefined): string {
  switch (status) {
    case OtaStatus.ERR_SIZE:
      return "That firmware is too big for the device's update slot."
    case OtaStatus.ERR_WRITE:
      return "The device couldn't prepare its update slot. Try again."
    case OtaStatus.ERR_SIG:
      return "The device couldn't confirm this firmware is a genuine release, so it refused it. Update using the official firmware bundled with this app."
    default:
      return 'The device declined the update. Did you hold its button to approve?'
  }
}

/** Plain-language explanation for a failed FINISH (verification) step. */
function verifyError(status: number | undefined): string {
  switch (status) {
    case OtaStatus.ERR_HASH:
      return "The uploaded firmware didn't match its checksum, so the device kept its current firmware. Try the update again."
    case OtaStatus.ERR_NOT_STARTED:
      return 'The device lost track of the update. Reconnect and try again.'
    case OtaStatus.ERR_SIG:
      return "The device couldn't confirm the firmware is a genuine release, so it kept its current firmware."
    default:
      return 'The device could not verify the firmware and rolled back to its current version.'
  }
}

/**
 * Stream `data` to a USB-connected device and verify it. Resolves on a verified
 * image (the device then reboots into it); throws [`OtaError`] otherwise. The
 * begin step waits up to a minute for the owner's physical button approval.
 *
 * `signature` is the image's 64-byte ed25519 release signature (from the
 * release manifest). Signature-enforcing firmware refuses the update without
 * it; pre-signature firmware answers the signed OTA_BEGIN with ERR_SIZE, on
 * which this falls back to the legacy unsigned form automatically.
 */
export async function streamOta(
  transport: OtaTransport,
  data: Uint8Array,
  cb: OtaCallbacks = {},
  signature?: Uint8Array,
): Promise<void> {
  if (signature && signature.length !== 64) {
    throw new OtaError('The firmware signature is malformed (expected 64 bytes).')
  }

  // Hash a freshly allocated copy so the digest input is definitely an
  // ArrayBuffer-backed view (a subarray may be backed by a SharedArrayBuffer).
  const owned = new Uint8Array(data.length)
  owned.set(data)
  const hashBuffer = await crypto.subtle.digest('SHA-256', owned)
  const hash = new Uint8Array(hashBuffer)

  // OTA_BEGIN — gated on the device by a 2-second button hold, so allow a
  // generous window for the owner to approve.
  cb.onPhase?.('waiting')
  const beginPayload = (sig?: Uint8Array): Uint8Array => {
    const p = new Uint8Array(4 + 32 + (sig ? 64 : 0))
    p.set(be32(data.length), 0)
    p.set(hash, 4)
    if (sig) p.set(sig, 36)
    return p
  }
  const begin = (sig?: Uint8Array) => transport.sendAndReceive(
    buildFrame(FrameType.OTA_BEGIN, beginPayload(sig)),
    [FrameType.OTA_STATUS],
    60_000,
  )
  let beginResp: Awaited<ReturnType<typeof begin>>
  if (!signature) {
    beginResp = await begin()
  } else {
    // Pre-signature firmware doesn't understand the 100-byte signed BEGIN.
    // Later builds reject it as a bad payload length (ERR_SIZE, before asking
    // for approval); v0.9.7-era builds drop it without replying, so the only
    // signal is the begin timing out. On either, retry the legacy unsigned
    // form — that firmware can't verify signatures anyway, and this path is
    // exactly how a device gets updated INTO signature enforcement. A
    // disconnect is not such a signal: the retry would go to a dead port.
    let signedResp: Awaited<ReturnType<typeof begin>> | null = null
    try {
      signedResp = await begin(signature)
    } catch (e) {
      const silentDrop = e instanceof Error && e.message.startsWith('No response from the device')
      if (!silentDrop) throw e
    }
    beginResp = signedResp !== null && signedResp.payload[0] !== OtaStatus.ERR_SIZE
      ? signedResp
      : await begin() // exactly one unsigned fallback; its own failures propagate
  }
  if (beginResp.payload[0] !== OtaStatus.READY) {
    throw new OtaError(beginError(beginResp.payload[0]), beginResp.payload[0])
  }

  // OTA_CHUNK loop.
  cb.onPhase?.('uploading')
  let offset = 0
  while (offset < data.length) {
    const end = Math.min(offset + OTA_CHUNK_SIZE, data.length)
    const chunk = data.subarray(offset, end)
    const payload = new Uint8Array(4 + chunk.length)
    payload.set(be32(offset), 0)
    payload.set(chunk, 4)
    const chunkResp = await transport.sendAndReceive(
      buildFrame(FrameType.OTA_CHUNK, payload),
      [FrameType.OTA_STATUS],
      10_000,
    )
    if (chunkResp.payload[0] !== OtaStatus.CHUNK_OK) {
      throw new OtaError(
        `The device rejected part of the firmware (${offset} bytes in). Try again.`,
        chunkResp.payload[0],
      )
    }
    offset = end
    cb.onProgress?.(Math.round((offset / data.length) * 100), offset, data.length)
  }

  // OTA_FINISH — device re-hashes and either commits or rolls back.
  cb.onPhase?.('verifying')
  const finishResp = await transport.sendAndReceive(
    buildFrame(FrameType.OTA_FINISH),
    [FrameType.OTA_STATUS],
    30_000,
  )
  if (finishResp.payload[0] !== OtaStatus.VERIFIED) {
    throw new OtaError(verifyError(finishResp.payload[0]), finishResp.payload[0])
  }
}
