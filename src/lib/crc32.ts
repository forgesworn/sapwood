// CRC32 implementation (IEEE 802.3 polynomial).
// Matches crc32fast in the Rust codebase. Zero dependencies.

const TABLE = new Uint32Array(256)

// Build lookup table once at module load.
for (let i = 0; i < 256; i++) {
  let crc = i
  for (let j = 0; j < 8; j++) {
    crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1
  }
  TABLE[i] = crc >>> 0
}

/** Compute CRC32 over one or more byte arrays. */
export function crc32(...chunks: Uint8Array[]): number {
  let crc = 0xffffffff
  for (const chunk of chunks) {
    for (let i = 0; i < chunk.length; i++) {
      crc = TABLE[(crc ^ chunk[i]) & 0xff]! ^ (crc >>> 8)
    }
  }
  return (crc ^ 0xffffffff) >>> 0
}
