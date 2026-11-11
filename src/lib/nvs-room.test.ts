import { describe, it, expect } from 'vitest'
import {
  CHUNK_MAX_SIZE, PAGE_ENTRIES, availableEntries, avatarBlobLength, blobWriteEntries, pickPictureSide,
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

  it('picks 64 when it fits, 48 when only that fits, and 48 as a last try', () => {
    expect(pickPictureSide({ free: 126 + 277, total: 756 })).toEqual({ side: 64, fits: true })
    expect(pickPictureSide({ free: 126 + 276, total: 756 })).toEqual({ side: 48, fits: true })
    expect(pickPictureSide({ free: 340, total: 756 })).toEqual({ side: 48, fits: true })
    expect(pickPictureSide({ free: 126 + 164, total: 756 })).toEqual({ side: 48, fits: false })
  })

  it('assumes 64 when the stats are absent', () => {
    expect(pickPictureSide({})).toEqual({ side: 64, fits: null })
    expect(pickPictureSide({ free: 340 })).toEqual({ side: 64, fits: null })
  })
})
