import { describe, it, expect } from 'vitest'
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import { getConversationKey, encrypt, decrypt } from 'nostr-tools/nip44'
import { buildEncryptedRequestPayload, parseEnvelopeResponse, type Nip46Rpc } from './nip46-usb.js'

// The device side of the conversation, simulated: NIP-44 conversation keys
// are symmetric, so decrypting as the signer verifies the exact bytes the
// firmware's transport.rs will see.

const deviceSk = generateSecretKey()
const devicePub = getPublicKey(deviceSk)
const clientSk = generateSecretKey()
const clientPub = getPublicKey(clientSk)

const rpc: Nip46Rpc = { id: 'req-1', method: 'heartwood_derive_persona', params: ['gaming', 0] }

describe('buildEncryptedRequestPayload', () => {
  const payload = buildEncryptedRequestPayload(devicePub, clientSk, rpc, 1_755_000_000)

  it('lays out target, client and timestamp exactly as transport.rs expects', () => {
    const hex = (bytes: Uint8Array) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
    expect(hex(payload.subarray(0, 32))).toBe(devicePub)
    expect(hex(payload.subarray(32, 64))).toBe(clientPub)
    expect(new DataView(payload.buffer).getBigUint64(64, false)).toBe(1_755_000_000n)
  })

  it('carries ciphertext the signer can decrypt to the request JSON', () => {
    const ciphertext = new TextDecoder().decode(payload.subarray(72))
    const plain = decrypt(ciphertext, getConversationKey(deviceSk, clientPub))
    expect(JSON.parse(plain)).toEqual(rpc)
  })
})

describe('parseEnvelopeResponse', () => {
  const envelope = (content: string, pubkey = devicePub) =>
    new TextEncoder().encode(JSON.stringify({ pubkey, content, kind: 24133, tags: [] }))
  const encryptedReply = (reply: unknown) =>
    envelope(encrypt(JSON.stringify(reply), getConversationKey(deviceSk, clientPub)))

  it('decrypts and returns the result string', () => {
    const payload = encryptedReply({ id: 'req-1', result: '{"npub":"npub1x"}' })
    expect(parseEnvelopeResponse(payload, clientSk, 'req-1')).toBe('{"npub":"npub1x"}')
  })

  it('surfaces a signer error as a thrown message', () => {
    const payload = encryptedReply({ id: 'req-1', error: 'identity storage full: remove an unused persona first' })
    expect(() => parseEnvelopeResponse(payload, clientSk, 'req-1'))
      .toThrow(/identity storage full/)
  })

  it('rejects a mismatched request id', () => {
    const payload = encryptedReply({ id: 'other', result: 'x' })
    expect(() => parseEnvelopeResponse(payload, clientSk, 'req-1'))
      .toThrow(/did not match/)
  })

  it('rejects an envelope it cannot decrypt', () => {
    const stranger = generateSecretKey()
    const payload = envelope(encrypt(JSON.stringify({ id: 'req-1', result: 'x' }),
      getConversationKey(stranger, getPublicKey(stranger))))
    expect(() => parseEnvelopeResponse(payload, clientSk, 'req-1'))
      .toThrow(/Re-pair Sapwood/)
  })

  it('rejects malformed envelopes and replies', () => {
    expect(() => parseEnvelopeResponse(new TextEncoder().encode('not json'), clientSk, 'req-1'))
      .toThrow(/malformed response envelope/)
    expect(() => parseEnvelopeResponse(envelope(''), clientSk, 'req-1'))
      .toThrow()
    const notJsonInside = envelope(encrypt('not json', getConversationKey(deviceSk, clientPub)))
    expect(() => parseEnvelopeResponse(notJsonInside, clientSk, 'req-1'))
      .toThrow(/malformed response/)
  })
})
