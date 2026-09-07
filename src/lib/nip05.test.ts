import { describe, it, expect } from 'vitest'
import { buildNostrJson, isValidNip05Name, isHexPubkey, nip05Identifier } from './nip05.js'

const PK = 'ab'.repeat(32)

describe('isValidNip05Name', () => {
  it('accepts letters, digits, dash, underscore, dot', () => {
    expect(isValidNip05Name('rowan')).toBe(true)
    expect(isValidNip05Name('d.arren-42_x')).toBe(true)
    expect(isValidNip05Name('_')).toBe(true)
  })

  it('rejects spaces, @, empty and unicode', () => {
    expect(isValidNip05Name('')).toBe(false)
    expect(isValidNip05Name('a b')).toBe(false)
    expect(isValidNip05Name('a@b')).toBe(false)
    expect(isValidNip05Name('därren')).toBe(false)
  })
})

describe('isHexPubkey', () => {
  it('accepts 64 lowercase hex chars', () => {
    expect(isHexPubkey(PK)).toBe(true)
  })

  it('rejects npub, uppercase and wrong length', () => {
    expect(isHexPubkey('npub1' + 'a'.repeat(59))).toBe(false)
    expect(isHexPubkey(PK.toUpperCase())).toBe(false)
    expect(isHexPubkey(PK.slice(1))).toBe(false)
  })
})

describe('buildNostrJson', () => {
  it('builds names and nip46 maps', () => {
    const json = buildNostrJson('Rowan', PK, ['wss://relay.example.test'])
    const doc = JSON.parse(json)
    expect(doc.names).toEqual({ rowan: PK })
    expect(doc.nip46).toEqual({ [PK]: ['wss://relay.example.test'] })
  })

  it('keeps only wss relays and trims whitespace', () => {
    const json = buildNostrJson('d', PK, [' wss://a.example ', 'ws://plain.local', 'https://nope'])
    const doc = JSON.parse(json)
    expect(doc.nip46[PK]).toEqual(['wss://a.example'])
  })

  it('throws without a usable relay', () => {
    expect(() => buildNostrJson('d', PK, ['ws://plain.local'])).toThrow(/wss/)
  })

  it('throws on a bad name or pubkey', () => {
    expect(() => buildNostrJson('a b', PK, ['wss://a'])).toThrow(/Name/)
    expect(() => buildNostrJson('d', 'nothex', ['wss://a'])).toThrow(/hex/)
  })
})

describe('nip05Identifier', () => {
  it('joins name and bare domain', () => {
    expect(nip05Identifier('Rowan', 'example.test')).toBe('rowan@example.test')
  })

  it('strips scheme and path from the domain', () => {
    expect(nip05Identifier('d', 'https://example.test/about')).toBe('d@example.test')
  })

  it('collapses the root name to just the domain', () => {
    expect(nip05Identifier('_', 'trotters.cc')).toBe('trotters.cc')
  })
})
