import { describe, it, expect } from 'vitest'
import { parseImportOp } from './import-link.svelte'

const HEX = 'a1b2c3d4e5f6'.repeat(5) + 'abcd' // 64 hex chars

describe('parseImportOp', () => {
  it('extracts a 64-hex operator key from an import deep link', () => {
    expect(parseImportOp(`#/import?op=${HEX}`)).toBe(HEX)
  })
  it('lowercases the key', () => {
    expect(parseImportOp(`#/import?op=${HEX.toUpperCase()}`)).toBe(HEX)
  })
  it('finds op alongside other params', () => {
    expect(parseImportOp(`#/import?foo=1&op=${HEX}`)).toBe(HEX)
    expect(parseImportOp(`#/import?op=${HEX}&bar=2`)).toBe(HEX)
  })
  it('ignores non-import hashes', () => {
    expect(parseImportOp('#/')).toBeNull()
    expect(parseImportOp('')).toBeNull()
    expect(parseImportOp(`#/flash?op=${HEX}`)).toBeNull()
  })
  it('rejects a malformed or wrong-length key', () => {
    expect(parseImportOp('#/import?op=nothex')).toBeNull()
    expect(parseImportOp(`#/import?op=${'a'.repeat(63)}`)).toBeNull()
    expect(parseImportOp('#/import')).toBeNull()
  })
})
