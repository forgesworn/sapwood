import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { finalizeEvent } from 'nostr-tools/pure'
import { getConversationKey, encrypt as nip44Encrypt, decrypt as nip44Decrypt } from 'nostr-tools/nip44'
import { hexToBytes, bytesToHex } from '@noble/hashes/utils.js'
import {
  buildInviteUri, createInvite, parseInviteUri, openInviteReply, reduceInvite,
  initialInviteState, zeroInviteSecret, INVITE_TTL_SECONDS,
  type InviteReplyEvent,
} from './enrol-invite.js'

const fixturesDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../test/fixtures')
const vector = JSON.parse(
  readFileSync(path.join(fixturesDir, 'enrol-invite-v1.json'), 'utf8'),
) as {
  invSecretHex: string
  invPubkeyHex: string
  throwawaySecretHex: string
  throwawayPubkeyHex: string
  rendezvousHex: string
  expiresAt: number
  relays: string[]
  inviteUri: string
  nonceHex: string
  plaintext: string
  eventContent: string
}

describe('buildInviteUri / parseInviteUri', () => {
  it('round-trips a fresh invite', () => {
    const uri = buildInviteUri('a1'.repeat(32), 'b2'.repeat(16), 1_700_000_600, ['wss://one.example', 'wss://two.example'])
    expect(parseInviteUri(uri)).toEqual({
      pubkey: 'a1'.repeat(32),
      rendezvous: 'b2'.repeat(16),
      expiresAt: 1_700_000_600,
      relays: ['wss://one.example', 'wss://two.example'],
    })
  })

  it('reads the shared vector', () => {
    expect(parseInviteUri(vector.inviteUri)).toEqual({
      pubkey: vector.invPubkeyHex,
      rendezvous: vector.rendezvousHex,
      expiresAt: vector.expiresAt,
      relays: vector.relays,
    })
  })

  it.each([
    ['another scheme', vector.inviteUri.replace('heartwood-unlock:', 'nostr:')],
    ['another version', vector.inviteUri.replace('v=1', 'v=2')],
    ['a short key', vector.inviteUri.replace(`k=${vector.invPubkeyHex}`, `k=${vector.invPubkeyHex.slice(2)}`)],
    ['a short rendezvous', vector.inviteUri.replace(`r=${vector.rendezvousHex}`, `r=${vector.rendezvousHex.slice(2)}`)],
    ['a non-numeric expiry', vector.inviteUri.replace(`x=${vector.expiresAt}`, 'x=soon')],
    ['a repeated key', `${vector.inviteUri}&k=${vector.invPubkeyHex}`],
    ['no relay', vector.inviteUri.split('&relay=')[0]],
    ['a relay that is not a websocket', vector.inviteUri.replace('wss%3A%2F%2Frelay.example', 'https%3A%2F%2Frelay.example')],
  ])('refuses %s', (_, uri) => {
    expect(parseInviteUri(uri)).toBeNull()
  })
})

describe('createInvite', () => {
  it('makes a keypair, a rendezvous, and an expiry INVITE_TTL_SECONDS out', () => {
    const now = 1_700_000_000_000
    const invite = createInvite(['wss://relay.example'], now)
    expect(invite.pubkey).toMatch(/^[0-9a-f]{64}$/)
    expect(invite.rendezvous).toMatch(/^[0-9a-f]{32}$/)
    expect(invite.secret).toBeInstanceOf(Uint8Array)
    expect(invite.secret.length).toBe(32)
    expect(invite.expiresAt).toBe(Math.floor(now / 1000) + INVITE_TTL_SECONDS)
    expect(parseInviteUri(invite.uri)).toEqual({
      pubkey: invite.pubkey,
      rendezvous: invite.rendezvous,
      expiresAt: invite.expiresAt,
      relays: ['wss://relay.example'],
    })
  })

  it('makes a different invite each time', () => {
    const a = createInvite(['wss://relay.example'])
    const b = createInvite(['wss://relay.example'])
    expect(a.pubkey).not.toBe(b.pubkey)
    expect(a.rendezvous).not.toBe(b.rendezvous)
  })
})

describe('zeroInviteSecret', () => {
  it('overwrites the secret bytes', () => {
    const invite = createInvite(['wss://relay.example'])
    expect(invite.secret.some((b) => b !== 0)).toBe(true)
    zeroInviteSecret(invite)
    expect(invite.secret.every((b) => b === 0)).toBe(true)
    zeroInviteSecret(invite) // safe to call twice
  })
})

function replyEvent(overrides: Partial<{
  throwawaySecret: Uint8Array
  h: string
  createdAt: number
  content: string
}> = {}): InviteReplyEvent {
  const throwawaySecret = overrides.throwawaySecret ?? hexToBytes(vector.throwawaySecretHex)
  const h = overrides.h ?? vector.rendezvousHex
  const createdAt = overrides.createdAt ?? vector.expiresAt - 60
  const content = overrides.content ?? vector.eventContent
  return finalizeEvent({
    kind: 24137,
    created_at: createdAt,
    tags: [['h', h], ['expiration', String(vector.expiresAt)]],
    content,
  }, throwawaySecret)
}

const inviteView = { secret: hexToBytes(vector.invSecretHex), rendezvous: vector.rendezvousHex, expiresAt: vector.expiresAt }

describe('openInviteReply', () => {
  it('opens a genuine reply, matching the shared vector plaintext', () => {
    const event = replyEvent()
    const code = openInviteReply(event, inviteView, (vector.expiresAt - 60) * 1000)
    expect(code).toEqual({
      enrolPubkey: 'a1'.repeat(32),
      rendezvous: 'b2'.repeat(16),
      label: 'Pixel 8 Pro',
      relays: ['wss://relay.example'],
    })
  })

  it('refuses a bad signature', () => {
    const event = replyEvent()
    // finalizeEvent caches its own "verified" result as a symbol property on
    // the object; a plain spread copies that symbol along with everything
    // else, so a JSON round trip is needed to actually drop it before the
    // tampered signature is checked fresh.
    const tampered = { ...JSON.parse(JSON.stringify(event)), sig: '00'.repeat(64) }
    expect(openInviteReply(tampered, inviteView, (vector.expiresAt - 60) * 1000)).toBeNull()
  })

  it('refuses the wrong h', () => {
    const event = replyEvent({ h: 'ff'.repeat(16) })
    expect(openInviteReply(event, inviteView, (vector.expiresAt - 60) * 1000)).toBeNull()
  })

  it('refuses an event outside the invite window', () => {
    const event = replyEvent({ createdAt: vector.expiresAt - 60 })
    // "now" is past the invite's expiry, even though the event itself is not.
    expect(openInviteReply(event, inviteView, (vector.expiresAt + 60) * 1000)).toBeNull()
  })

  it('refuses an event created after the invite expired', () => {
    const event = replyEvent({ createdAt: vector.expiresAt + 60 })
    expect(openInviteReply(event, inviteView, (vector.expiresAt - 60) * 1000)).toBeNull()
  })

  it('refuses garbage plaintext', () => {
    const throwawaySecret = hexToBytes(vector.throwawaySecretHex)
    const ck = getConversationKey(throwawaySecret, vector.invPubkeyHex)
    const garbage = nip44Encrypt('not an enrolment code', ck)
    const event = replyEvent({ content: garbage })
    expect(openInviteReply(event, inviteView, (vector.expiresAt - 60) * 1000)).toBeNull()
  })

  it('refuses ciphertext this key cannot open', () => {
    const wrongSecret = hexToBytes('33'.repeat(32))
    const ck = getConversationKey(wrongSecret, vector.invPubkeyHex)
    const wrongCipher = nip44Encrypt(vector.plaintext, ck)
    const event = replyEvent({ content: wrongCipher })
    expect(openInviteReply(event, inviteView, (vector.expiresAt - 60) * 1000)).toBeNull()
  })
})

describe('reduceInvite', () => {
  const codeA = { enrolPubkey: 'a1'.repeat(32), rendezvous: 'b2'.repeat(16), label: 'Pixel', relays: ['wss://relay.example'] }
  const codeB = { enrolPubkey: 'c3'.repeat(32), rendezvous: 'b2'.repeat(16), label: 'Other phone', relays: ['wss://relay.example'] }

  it('shows the first valid reply', () => {
    const state = reduceInvite(initialInviteState, { type: 'reply', code: codeA })
    expect(state).toEqual({ status: 'received', code: codeA })
  })

  it('does not abort on a repeat of the identical reply', () => {
    const first = reduceInvite(initialInviteState, { type: 'reply', code: codeA })
    const second = reduceInvite(first, { type: 'reply', code: { ...codeA } })
    expect(second).toEqual({ status: 'received', code: codeA })
  })

  it('aborts on a second reply with a different enrolment key', () => {
    const first = reduceInvite(initialInviteState, { type: 'reply', code: codeA })
    const second = reduceInvite(first, { type: 'reply', code: codeB })
    expect(second).toEqual({ status: 'aborted' })
  })

  it('expires while nothing has arrived yet', () => {
    expect(reduceInvite(initialInviteState, { type: 'expire' })).toEqual({ status: 'expired' })
  })

  it('ignores expiry once a reply is already shown', () => {
    const received = reduceInvite(initialInviteState, { type: 'reply', code: codeA })
    expect(reduceInvite(received, { type: 'expire' })).toEqual(received)
  })

  it('is terminal once aborted', () => {
    const aborted = { status: 'aborted' } as const
    expect(reduceInvite(aborted, { type: 'reply', code: codeA })).toEqual(aborted)
    expect(reduceInvite(aborted, { type: 'expire' })).toEqual(aborted)
  })

  it('is terminal once expired', () => {
    const expired = { status: 'expired' } as const
    expect(reduceInvite(expired, { type: 'reply', code: codeA })).toEqual(expired)
  })
})

describe('the shared vector', () => {
  it('decrypts to the plaintext enrolment code', () => {
    const ck = getConversationKey(hexToBytes(vector.invSecretHex), vector.throwawayPubkeyHex)
    expect(nip44Decrypt(vector.eventContent, ck)).toBe(vector.plaintext)
  })

  it('reproduces the ciphertext byte for byte with the fixed nonce', () => {
    const ck = getConversationKey(hexToBytes(vector.throwawaySecretHex), vector.invPubkeyHex)
    const reproduced = nip44Encrypt(vector.plaintext, ck, hexToBytes(vector.nonceHex))
    expect(reproduced).toBe(vector.eventContent)
  })

  it('derives the same conversation key from either end', () => {
    const fromInv = getConversationKey(hexToBytes(vector.invSecretHex), vector.throwawayPubkeyHex)
    const fromThrowaway = getConversationKey(hexToBytes(vector.throwawaySecretHex), vector.invPubkeyHex)
    expect(bytesToHex(fromInv)).toBe(bytesToHex(fromThrowaway))
  })
})
