// Enrol invite: Sapwood makes a QR, the phone (Cambium) scans it and replies
// over the relay. This reverses phone-unlock.ts's optical step: there the
// phone shows a code and Sapwood reads it (usually pasted, since a desktop
// rarely has a camera); here Sapwood shows a code and the phone reads it,
// since a phone always has one. The firmware and the board's hand-off back to
// the phone do not change: this only replaces how the phone's enrolment code
// reaches Sapwood.
//
// Flow:
//   1. Sapwood makes a one-off keypair `inv` and a rendezvous `ri`, opens the
//      invite's relays, then shows a QR: heartwood-unlock:invite?v=1
//      &k=<inv pubkey>&r=<ri>&x=<expiry>&relay=<url>... Nothing in it is
//      secret except that `inv`'s secret half never leaves this page and is
//      zeroed once the invite is used, cancelled, or expires.
//   2. Cambium scans it, builds its usual enrolment code exactly as today,
//      and publishes ONE kind-24137 event from a throwaway key that is
//      dropped after signing: tags [["h", ri], ["expiration", x]], content =
//      NIP-44 v2 encrypt(ECDH(throwaway, inv pubkey)) of the enrolment code
//      string (`heartwood-unlock:enrol?v=1&p=...&r=...&label=...&relay=...`).
//   3. Sapwood decrypts each matching reply with `inv`'s secret, verifies
//      the signature and the invite window, and shows the FIRST valid one.
//      A second valid reply with a different enrolment key (`p`) aborts:
//      more than one phone answered, and nobody can tell which one the owner
//      meant. A repeat of the identical reply (Cambium's own retry) does not.
//   4. The owner compares the five request words (existing `requestWords`,
//      derived from the phone's enrolment key) against the phone's own
//      screen, then continues into the existing `enrolPhone` path unchanged:
//      board button, hand-off, check code.
//
// Kind 24137 is shared with the hand-off in phone-unlock.ts, but an invite
// reply and a hand-off never share an `h` value, so a relay cannot mistake
// one for the other.

import { generateSecretKey, getPublicKey, verifyEvent, type Event as NostrEvent } from 'nostr-tools/pure'
import { getConversationKey, decrypt as nip44Decrypt } from 'nostr-tools/nip44'
import { bytesToHex } from '@noble/hashes/utils.js'
import { parseEnrolmentCode, type EnrolmentCode } from './phone-unlock.js'

/** How long an invite stays live, in seconds. */
export const INVITE_TTL_SECONDS = 600

const INVITE_PREFIX = 'heartwood-unlock:invite?'
const HEX64 = /^[0-9a-f]{64}$/
const HEX32 = /^[0-9a-f]{32}$/

function isRelayUrl(url: string): boolean {
  return /^wss?:\/\/\S+$/.test(url) && url.length <= 256
}

/** An invite Sapwood is holding open, waiting for a phone to answer. */
export interface Invite {
  uri: string
  /** The one-off secret half. Never sent anywhere; zero it with
   *  `zeroInviteSecret` once the invite is used, cancelled, or expires. */
  secret: Uint8Array
  pubkey: string
  rendezvous: string
  /** Unix seconds. */
  expiresAt: number
}

/** What the QR carries: everything but the secret half of `inv`. */
export interface InviteUri {
  pubkey: string
  rendezvous: string
  expiresAt: number
  relays: string[]
}

/** The QR text Sapwood shows: `heartwood-unlock:invite?v=1&k=...&r=...&x=...&relay=...`. */
export function buildInviteUri(pubkey: string, rendezvous: string, expiresAt: number, relays: string[]): string {
  const params = [`v=1`, `k=${pubkey}`, `r=${rendezvous}`, `x=${expiresAt}`]
  for (const relay of relays) params.push(`relay=${encodeURIComponent(relay)}`)
  return `${INVITE_PREFIX}${params.join('&')}`
}

/**
 * Make a fresh invite: a one-off keypair, a rendezvous, and an expiry
 * `INVITE_TTL_SECONDS` from `now`. The secret stays only in the returned
 * object; nothing here stores or transmits it.
 */
export function createInvite(relays: string[], now: number = Date.now()): Invite {
  const secret = generateSecretKey()
  const pubkey = getPublicKey(secret)
  const rendezvous = bytesToHex(crypto.getRandomValues(new Uint8Array(16)))
  const expiresAt = Math.floor(now / 1000) + INVITE_TTL_SECONDS
  const uri = buildInviteUri(pubkey, rendezvous, expiresAt, relays)
  return { uri, secret, pubkey, rendezvous, expiresAt }
}

/** Zero the invite's secret half in place. Safe to call more than once. */
export function zeroInviteSecret(invite: Pick<Invite, 'secret'>): void {
  invite.secret.fill(0)
}

/**
 * Parse the QR Sapwood shows, for round-trip tests and Cambium-side parity.
 * Returns null for anything that is not a complete, well-formed v1 invite; a
 * repeated parameter (other than relay) is refused rather than guessed at.
 */
export function parseInviteUri(input: string): InviteUri | null {
  const text = typeof input === 'string' ? input.trim() : ''
  if (!text.startsWith(INVITE_PREFIX)) return null
  const params: [string, string][] = []
  for (const pair of text.slice(INVITE_PREFIX.length).split('&')) {
    const eq = pair.indexOf('=')
    if (eq <= 0) continue
    try {
      params.push([pair.slice(0, eq), decodeURIComponent(pair.slice(eq + 1).replace(/\+/g, ' '))])
    } catch {
      return null
    }
  }
  const one = (name: string): string | null => {
    const found = params.filter(([key]) => key === name)
    return found.length === 1 ? found[0][1] : null
  }
  if (one('v') !== '1') return null
  const pubkey = one('k')
  const rendezvous = one('r')
  const xRaw = one('x')
  if (!pubkey || !HEX64.test(pubkey) || !rendezvous || !HEX32.test(rendezvous)) return null
  if (!xRaw || !/^\d+$/.test(xRaw)) return null
  const expiresAt = Number(xRaw)
  if (!Number.isSafeInteger(expiresAt)) return null
  const relays = params.filter(([key]) => key === 'relay').map(([, value]) => value)
  if (!relays.length || !relays.every(isRelayUrl)) return null
  return { pubkey, rendezvous, expiresAt, relays: [...new Set(relays)] }
}

/** The shape of a kind-24137 invite reply, exactly what nostr-tools hands
 *  `onevent` (or a raw JSON event read back from a relay). */
export type InviteReplyEvent = Pick<NostrEvent, 'id' | 'pubkey' | 'sig' | 'kind' | 'created_at' | 'tags' | 'content'>

/**
 * Try to read one reply to `invite`. Returns null for anything that does not
 * check out: a bad signature, a rendezvous that does not match, an event
 * outside the invite's window, ciphertext this key cannot open, or plaintext
 * that is not a valid enrolment code. Never throws: a relay can carry
 * anything, forged or malformed.
 */
export function openInviteReply(
  event: InviteReplyEvent,
  invite: Pick<Invite, 'secret' | 'rendezvous' | 'expiresAt'>,
  now: number = Date.now(),
): EnrolmentCode | null {
  try {
    if (!verifyEvent(event as NostrEvent)) return null
  } catch {
    return null
  }
  const h = event.tags.find((tag) => tag[0] === 'h')?.[1]
  if (h !== invite.rendezvous) return null
  const nowSeconds = Math.floor(now / 1000)
  if (nowSeconds > invite.expiresAt || event.created_at > invite.expiresAt) return null
  let plaintext: string
  try {
    const conversationKey = getConversationKey(invite.secret, event.pubkey)
    plaintext = nip44Decrypt(event.content, conversationKey)
  } catch {
    return null
  }
  return parseEnrolmentCode(plaintext)
}

/** The collector's state while an invite is live. Terminal once aborted or
 *  expired: nothing resurrects it, a fresh invite is required instead. */
export type InviteCollectorState =
  | { status: 'waiting' }
  | { status: 'received'; code: EnrolmentCode }
  | { status: 'aborted' }
  | { status: 'expired' }

export type InviteCollectorEvent =
  | { type: 'reply'; code: EnrolmentCode }
  | { type: 'expire' }

export const initialInviteState: InviteCollectorState = { status: 'waiting' }

/**
 * Pure reducer for the collector: the FIRST valid reply is shown to the
 * owner. Cambium may resend the identical reply (its own retry after a relay
 * refused the first publish) without harm. A SECOND valid reply carrying a
 * different enrolment key means more than one phone answered the same code,
 * so it aborts rather than guess which one the owner meant. Expiry only
 * matters while nothing has arrived yet: once a reply is shown, the owner's
 * confirm step (or cancel) decides what happens next, not the clock.
 */
export function reduceInvite(state: InviteCollectorState, event: InviteCollectorEvent): InviteCollectorState {
  if (state.status === 'aborted' || state.status === 'expired') return state
  if (event.type === 'expire') {
    return state.status === 'waiting' ? { status: 'expired' } : state
  }
  if (state.status === 'waiting') return { status: 'received', code: event.code }
  if (state.code.enrolPubkey === event.code.enrolPubkey) return state
  return { status: 'aborted' }
}
