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

/** Stored length of a 64x64 or 48x48 Rgb565 identity-card picture: a 2-byte header plus pixels. */
export function avatarBlobLength(side: number): number {
  return 2 + side * side * 2
}

/** The picture sizes (square sides) Sapwood can send. */
export type PictureSide = 64 | 48

/** One picture Sapwood can send: a side and a pixel format. */
export interface PictureRung {
  side: PictureSide
  format: 'rgb565' | 'rgb332'
}

/** Richest first: a bigger picture beats more colours, and the signer's NACK steps down. */
export const PICTURE_LADDER: readonly PictureRung[] = [
  { side: 64, format: 'rgb565' },
  { side: 64, format: 'rgb332' },
  { side: 48, format: 'rgb565' },
  { side: 48, format: 'rgb332' },
]

/**
 * Where on PICTURE_LADDER to start, given the signer's NVS stats: rung 0
 * (64x64 Rgb565) without stats or when the estimate says it fits, otherwise
 * rung 1 (64x64 RGB332). Never lower: the estimate assumes the new blob is
 * written beside the stored one, but the signer may remove the stored picture
 * first to make room, and Sapwood cannot see how big that is. The signer's
 * NACKs walk the rest of the ladder.
 */
export function pickPictureStart(stats: { free?: number; total?: number }): number {
  if (stats.free === undefined || stats.total === undefined) return 0
  const pages = Math.floor(stats.total / PAGE_ENTRIES)
  return blobWriteEntries(avatarBlobLength(64), pages) <= availableEntries(stats.free) ? 0 : 1
}
