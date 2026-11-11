/**
 * How many NVS entries a blob write needs, and whether the signer has them.
 * A TypeScript port of the arithmetic in the firmware's `nvs_room.rs`
 * (ESP-IDF v5.3.2 `nvs_flash`), so Sapwood can pick an identity-card picture
 * size the signer will accept before it sends 8 KB that gets refused. The
 * estimate errs high; the signer stays the authority.
 */

/** Bytes per NVS entry. */
export const ENTRY_SIZE = 32
/** Entries per NVS page. */
export const PAGE_ENTRIES = 126
/** The most data one blob chunk holds (a page less the chunk's own header). */
export const CHUNK_MAX_SIZE = ENTRY_SIZE * (PAGE_ENTRIES - 1)
/** The most entries a write can lose to the first-chunk rule. */
export const FIRST_CHUNK_SKIP_SLACK = Math.ceil(CHUNK_MAX_SIZE / 10 / ENTRY_SIZE)

const ceilDiv = (a: number, b: number) => Math.ceil(a / b)

/** Entries a write of `len` bytes may lose to the first-chunk rule. */
export function firstChunkSkipSlack(len: number): number {
  const data = ceilDiv(len, ENTRY_SIZE)
  if (data === 0) return 1
  if (data === 1) return 0
  return Math.min(data, FIRST_CHUNK_SKIP_SLACK)
}

/** Entries a new blob of `len` bytes takes on a partition of `pages` pages. */
export function blobEntries(len: number, pages: number): number {
  const data = ceilDiv(len, ENTRY_SIZE)
  const chunkHeaders = Math.max(ceilDiv(len, CHUNK_MAX_SIZE) + 1, Math.min(pages, data))
  return data + chunkHeaders + 1
}

/** Entries one blob write may need at its peak. */
export function blobWriteEntries(len: number, pages: number): number {
  return blobEntries(len, pages) + firstChunkSkipSlack(len)
}

/** Entries a write may use: free entries less the page kept for garbage collection. */
export function availableEntries(free: number): number {
  return Math.max(0, free - PAGE_ENTRIES)
}

/** Stored length of an identity-card picture: a 2-byte header plus Rgb565 pixels. */
export function avatarBlobLength(side: number): number {
  return 2 + side * side * 2
}

/** The picture sizes (square sides) Sapwood can send. */
export type PictureSide = 64 | 48

/**
 * Which picture side to send given the signer's NVS stats. Returns 64 when
 * the stats are absent (older firmware); 64 when it fits; otherwise 48, even
 * when 48 does not fit by the estimate (the signer decides).
 */
export function pickPictureSide(
  stats: { free?: number; total?: number },
): { side: PictureSide; fits: boolean | null } {
  if (stats.free === undefined || stats.total === undefined) return { side: 64, fits: null }
  const pages = Math.floor(stats.total / PAGE_ENTRIES)
  const room = availableEntries(stats.free)
  if (blobWriteEntries(avatarBlobLength(64), pages) <= room) return { side: 64, fits: true }
  if (blobWriteEntries(avatarBlobLength(48), pages) <= room) return { side: 48, fits: true }
  return { side: 48, fits: false }
}
