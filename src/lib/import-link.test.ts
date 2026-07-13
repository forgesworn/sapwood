import { afterEach, describe, it, expect, beforeEach, vi } from 'vitest'
import { nip19 } from 'nostr-tools'

// device.svelte pulls in the whole connection stack; stub the one thing the
// import flow touches so these stay unit tests.
const connectRelayMock = vi.hoisted(() => vi.fn(async () => {}))
vi.mock('./device.svelte.js', () => ({ connectRelay: connectRelayMock }))

import {
  parseImportLink, parseImportOp, buildHandoffLink, buildProtectedHandoffLink,
  encryptOperator, submitPin, dismissPin, pendingPin, consumeImportLink,
  confirmPendingImport, dismissPendingImport, pendingImport, importNotice,
  handoffConnection, dismissHandoffConnection, retryHandoffConnection,
  HANDOFF_CONNECT_TIMEOUT_MS,
} from './import-link.svelte'
import { peekOperatorPubHex, pubHexFromSecret } from './op-mgmt'

const HEX = 'a1b2c3d4e5f6'.repeat(5) + 'abcd' // 64 hex chars
const DEV = 'f'.repeat(64)
// A second, distinct valid operator secret (for overwrite-collision tests).
const HEX2 = 'b2c3d4e5f6a1'.repeat(5) + '1234'

afterEach(() => vi.useRealTimers())

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
  it('accepts only bounded secure websocket relay routes from a handoff', () => {
    const relays = [
      'ws://insecure.example',
      'https://not-a-websocket.example',
      'wss://user:password@credentialed.example',
      `wss://${'a'.repeat(513)}.example`,
      ...Array.from({ length: 10 }, (_, index) => `wss://relay-${index}.example`),
    ]
    const link = parseImportLink(
      `#/import?op=${HEX}&dev=${DEV}&relays=${encodeURIComponent(relays.join(','))}`,
    )
    expect(link?.relays).toEqual(
      Array.from({ length: 8 }, (_, index) => `wss://relay-${index}.example`),
    )
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

describe('consumeImportLink — overwrite guard', () => {
  beforeEach(() => {
    localStorage.clear()
    connectRelayMock.mockReset().mockResolvedValue(undefined)
    dismissHandoffConnection()
    pendingImport.link = null
    importNotice.shown = false
    location.hash = ''
  })

  it('imports directly when no operator key exists yet', () => {
    location.hash = `#/import?op=${HEX}`
    expect(consumeImportLink()).toBe(true)
    expect(pendingImport.link).toBeNull()          // no confirmation needed
    expect(peekOperatorPubHex()).toBe(pubHexFromSecret(HEX))
    expect(importNotice.shown).toBe(true)
    expect(location.hash).toBe('#/')               // secret stripped from the URL
  })

  it('imports directly when the link matches the existing key', () => {
    location.hash = `#/import?op=${HEX}`
    consumeImportLink()
    importNotice.shown = false
    location.hash = `#/import?op=${HEX.toUpperCase()}` // same key, different case
    expect(consumeImportLink()).toBe(true)
    expect(pendingImport.link).toBeNull()
    expect(importNotice.shown).toBe(true)
  })

  it('parks (does NOT silently overwrite) a different key for confirmation', () => {
    location.hash = `#/import?op=${HEX}`
    consumeImportLink()
    const original = peekOperatorPubHex()

    location.hash = `#/import?op=${HEX2}`
    expect(consumeImportLink()).toBe(true)
    // Nothing imported yet; the existing key is untouched.
    expect(peekOperatorPubHex()).toBe(original)
    expect(pendingImport.link?.op).toBe(HEX2)
    expect(pendingImport.currentPubHex).toBe(original)
    expect(pendingImport.incomingPubHex).toBe(pubHexFromSecret(HEX2))
    expect(location.hash).toBe('#/')               // secret still stripped while pending
  })

  it('dismissing a parked overwrite keeps the original key', () => {
    location.hash = `#/import?op=${HEX}`
    consumeImportLink()
    const original = peekOperatorPubHex()
    location.hash = `#/import?op=${HEX2}`
    consumeImportLink()

    dismissPendingImport()
    expect(pendingImport.link).toBeNull()
    expect(peekOperatorPubHex()).toBe(original)    // unchanged
  })

  it('confirming a parked overwrite replaces the key', () => {
    location.hash = `#/import?op=${HEX}`
    consumeImportLink()
    location.hash = `#/import?op=${HEX2}`
    consumeImportLink()

    expect(confirmPendingImport()).toBe(true)
    expect(pendingImport.link).toBeNull()
    expect(peekOperatorPubHex()).toBe(pubHexFromSecret(HEX2))
  })
})

describe('consumeImportLink — PIN-protected (eop)', () => {
  beforeEach(() => {
    localStorage.clear()
    connectRelayMock.mockReset().mockResolvedValue(undefined)
    dismissHandoffConnection()
    pendingImport.link = null
    pendingPin.link = null
    importNotice.shown = false
    location.hash = ''
  })

  it('a protected link round-trips through build/parse as an eop', () => {
    const eop = encryptOperator(HEX, '1234')
    const url = buildProtectedHandoffLink('https://x.dev', eop, DEV, ['wss://a.cc'])
    const link = parseImportLink(url.slice(url.indexOf('#')))
    expect(link).toEqual({ eop, deviceHex: DEV, relays: ['wss://a.cc'] })
    expect(link?.op).toBeUndefined() // no plaintext secret in the link
  })

  it('parks for the PIN, imports nothing until the right PIN is given', () => {
    const eop = encryptOperator(HEX, '1234')
    const url = buildProtectedHandoffLink('https://x.dev', eop, DEV, ['wss://a.cc'])
    location.hash = url.slice(url.indexOf('#'))

    expect(consumeImportLink()).toBe(true)
    expect(pendingPin.link?.eop).toBe(eop)
    expect(peekOperatorPubHex()).toBeNull() // nothing imported yet
    expect(location.hash).toBe('#/')

    expect(submitPin('1234').ok).toBe(true)
    expect(pendingPin.link).toBeNull()
    expect(peekOperatorPubHex()).toBe(pubHexFromSecret(HEX))
    expect(importNotice.shown).toBe(true)
    expect(connectRelayMock).toHaveBeenCalledWith(
      DEV,
      ['wss://a.cc'],
      undefined,
      pubHexFromSecret(HEX),
      expect.any(AbortSignal),
    )
  })

  it('tracks the remote connection and makes an early failure retriable', async () => {
    let rejectConnection!: (error: Error) => void
    connectRelayMock.mockImplementationOnce(() => new Promise<void>((_resolve, reject) => {
      rejectConnection = reject
    }))
    const eop = encryptOperator(HEX, 'correct horse')
    const url = buildProtectedHandoffLink('https://x.dev', eop, DEV, ['wss://a.cc'])
    location.hash = url.slice(url.indexOf('#'))
    consumeImportLink()

    expect(submitPin('correct horse').ok).toBe(true)
    expect(handoffConnection.phase).toBe('connecting')
    expect(handoffConnection.target).toEqual({
      deviceHex: DEV,
      relays: ['wss://a.cc'],
      operatorPubHex: pubHexFromSecret(HEX),
    })

    rejectConnection(new Error('relay unavailable'))
    await vi.waitFor(() => expect(handoffConnection.phase).toBe('error'))
    expect(handoffConnection.error).toMatch(/powered on and online/i)

    connectRelayMock.mockResolvedValueOnce(undefined)
    expect(retryHandoffConnection()).toBe(true)
    expect(handoffConnection.phase).toBe('connecting')
    await vi.waitFor(() => expect(handoffConnection.phase).toBe('connected'))
    expect(connectRelayMock).toHaveBeenCalledTimes(2)
  })

  it('abandons a never-settling attempt at the 45-second handoff deadline', async () => {
    vi.useFakeTimers()
    let signal: AbortSignal | undefined
    connectRelayMock.mockImplementationOnce((...args: unknown[]) => {
      signal = args[4] as AbortSignal
      return new Promise<void>(() => {})
    })
    const eop = encryptOperator(HEX, 'correct horse')
    const url = buildProtectedHandoffLink('https://x.dev', eop, DEV, ['wss://a.cc'])
    location.hash = url.slice(url.indexOf('#'))
    consumeImportLink()

    expect(submitPin('correct horse').ok).toBe(true)
    expect(handoffConnection.phase).toBe('connecting')
    const timeout = vi.advanceTimersByTimeAsync(HANDOFF_CONNECT_TIMEOUT_MS)
    await timeout

    expect(signal?.aborted).toBe(true)
    expect(handoffConnection.phase).toBe('error')
    expect(handoffConnection.error).toMatch(/45 seconds/i)
  })

  it('rechecks the wall-clock deadline when a suspended page resumes', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-13T10:00:00Z'))
    connectRelayMock.mockImplementationOnce(() => new Promise<void>(() => {}))
    const eop = encryptOperator(HEX, 'correct horse')
    const url = buildProtectedHandoffLink('https://x.dev', eop, DEV, ['wss://a.cc'])
    location.hash = url.slice(url.indexOf('#'))
    consumeImportLink()
    submitPin('correct horse')

    vi.setSystemTime(new Date('2026-07-13T10:00:46Z'))
    window.dispatchEvent(new Event('pageshow'))

    expect(handoffConnection.phase).toBe('error')
  })

  it('aborts the old attempt on retry and ignores its stale completion', async () => {
    const attempts: Array<{ signal: AbortSignal; resolve: () => void }> = []
    connectRelayMock.mockImplementation((...args: unknown[]) => new Promise<void>((resolve) => {
      attempts.push({ signal: args[4] as AbortSignal, resolve })
    }))
    const eop = encryptOperator(HEX, 'correct horse')
    const url = buildProtectedHandoffLink('https://x.dev', eop, DEV, ['wss://a.cc'])
    location.hash = url.slice(url.indexOf('#'))
    consumeImportLink()
    submitPin('correct horse')

    expect(retryHandoffConnection()).toBe(true)
    expect(attempts).toHaveLength(2)
    expect(attempts[0]?.signal.aborted).toBe(true)

    attempts[0]?.resolve()
    await Promise.resolve()
    expect(handoffConnection.phase).toBe('connecting')

    attempts[1]?.resolve()
    await vi.waitFor(() => expect(handoffConnection.phase).toBe('connected'))
  })

  it('rejects a wrong PIN and keeps the link parked for a retry', () => {
    const eop = encryptOperator(HEX, 'right')
    const url = buildProtectedHandoffLink('https://x.dev', eop)
    location.hash = url.slice(url.indexOf('#'))
    consumeImportLink()

    const res = submitPin('wrong')
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/PIN/)
    expect(peekOperatorPubHex()).toBeNull()
    expect(pendingPin.link?.eop).toBe(eop) // still parked

    expect(submitPin('right').ok).toBe(true)
    expect(peekOperatorPubHex()).toBe(pubHexFromSecret(HEX))
  })

  it('dismissing a parked PIN link imports nothing', () => {
    const eop = encryptOperator(HEX, '1234')
    const url = buildProtectedHandoffLink('https://x.dev', eop)
    location.hash = url.slice(url.indexOf('#'))
    consumeImportLink()

    dismissPin()
    expect(pendingPin.link).toBeNull()
    expect(peekOperatorPubHex()).toBeNull()
  })
})
