import { describe, it, expect } from 'vitest'
import { parseImportLink, parseImportOp, buildHandoffLink } from './import-link.svelte'
import { nip19 } from 'nostr-tools'

const HEX = 'a1b2c3d4e5f6'.repeat(5) + 'abcd' // 64 hex chars
const DEV = 'f'.repeat(64)

describe('parseImportOp (back-compat)', () => {
  it('extracts a 64-hex operator key', () => {
    expect(parseImportOp(`#/import?op=${HEX}`)).toBe(HEX)
  })
  it('lowercases the key', () => {
    expect(parseImportOp(`#/import?op=${HEX.toUpperCase()}`)).toBe(HEX)
  })
  it('ignores non-import hashes and bad keys', () => {
    expect(parseImportOp('#/')).toBeNull()
    expect(parseImportOp(`#/flash?op=${HEX}`)).toBeNull()
    expect(parseImportOp('#/import?op=nothex')).toBeNull()
    expect(parseImportOp(`#/import?op=${'a'.repeat(63)}`)).toBeNull()
    expect(parseImportOp('#/import')).toBeNull()
  })
})

describe('parseImportLink', () => {
  it('parses op + device hex + relays', () => {
    const hash = `#/import?op=${HEX}&dev=${DEV}&relays=${encodeURIComponent('wss://a.cc,wss://b.cc')}`
    expect(parseImportLink(hash)).toEqual({
      op: HEX,
      deviceHex: DEV,
      relays: ['wss://a.cc', 'wss://b.cc'],
    })
  })
  it('decodes an npub device address to hex', () => {
    const npub = nip19.npubEncode(DEV)
    const link = parseImportLink(`#/import?op=${HEX}&dev=${npub}&relays=wss://a.cc`)
    expect(link?.deviceHex).toBe(DEV)
  })
  it('is op-only when device/relays are absent', () => {
    expect(parseImportLink(`#/import?op=${HEX}`)).toEqual({ op: HEX })
  })
  it('drops a malformed device but keeps the op', () => {
    const link = parseImportLink(`#/import?op=${HEX}&dev=not-an-npub`)
    expect(link).toEqual({ op: HEX })
  })
})

describe('buildHandoffLink', () => {
  it('round-trips through parseImportLink', () => {
    const url = buildHandoffLink('https://sapwood.forgesworn.dev', HEX, DEV, ['wss://a.cc', 'wss://b.cc'])
    const hash = url.slice(url.indexOf('#'))
    expect(parseImportLink(hash)).toEqual({ op: HEX, deviceHex: DEV, relays: ['wss://a.cc', 'wss://b.cc'] })
  })
  it('omits device/relays when not given', () => {
    const url = buildHandoffLink('https://x.dev', HEX)
    expect(url).toBe(`https://x.dev/#/import?op=${HEX}`)
  })
})
