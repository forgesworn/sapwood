import { describe, it, expect } from 'vitest'
import {
  CHUNK_MAX_SIZE, PAGE_ENTRIES, availableEntries, avatarBlobLength, blobWriteEntries, pickPictureStart,
} from './nvs-room'

describe('nvs-room', () => {
  it('matches the firmware constants', () => {
    expect(PAGE_ENTRIES).toBe(126)
    expect(CHUNK_MAX_SIZE).toBe(4000)
  })

  it('sizes the picture blobs', () => {
    expect(avatarBlobLength(64)).toBe(8194)
    expect(avatarBlobLength(48)).toBe(4610)
  })

  it('needs 277 entries for 64x64 and 165 for 48x48 on 6 pages', () => {
    expect(blobWriteEntries(8194, 6)).toBe(277)
    expect(blobWriteEntries(4610, 6)).toBe(165)
  })

  it('keeps one page back for garbage collection', () => {
    expect(availableEntries(340)).toBe(214)
    expect(availableEntries(100)).toBe(0)
  })
})

describe('pickPictureStart', () => {
  it('starts at the top without stats', () => {
    expect(pickPictureStart({})).toBe(0)
    expect(pickPictureStart({ free: 340 })).toBe(0)
  })

  it('starts at 64x64 Rgb565 when the estimate says it fits', () => {
    expect(pickPictureStart({ free: 126 + 277, total: 756 })).toBe(0)
  })

  it('starts at 64x64 RGB332 when storage is tight, and never lower', () => {
    expect(pickPictureStart({ free: 126 + 276, total: 756 })).toBe(1)
    expect(pickPictureStart({ free: 340, total: 756 })).toBe(1)
    expect(pickPictureStart({ free: 200, total: 756 })).toBe(1)
    expect(pickPictureStart({ free: 0, total: 756 })).toBe(1)
  })
})
