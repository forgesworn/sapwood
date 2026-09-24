// Phones that can unlock the signer after a restart: the Sapwood side of
// heartwood-esp32's phone-unlock design (firmware 0.18.0-beta.17, frame 0x64)
// and Cambium's enrolment screen.
//
// Enrolment, end to end:
//   1. Cambium shows a code: heartwood-unlock:enrol?v=1&p=<enrolment pubkey>
//      &r=<rendezvous tag>&label=<phone label>&relay=<url>... Nothing in it is
//      secret. It waits on those relays for the answer.
//   2. Sapwood sends {op:"enrol", enrol_pubkey, label} over USB; the owner
//      presses the board's button. The board draws the phone's slot secret,
//      keeps the phone's record, and answers {id, ephemeral_pubkey, sealed}:
//      the secret sealed (NIP-44) to the phone's enrolment key. Sapwood cannot
//      open it.
//   3. Sapwood publishes that answer as a kind-24137 event from a throwaway
//      key, tagged ["h", rendezvous], to the phone's relays.
//   4. Both sides show the same six-character check code, derived with
//      spoken-token from the board's one-off hand-off key. A mismatch means
//      someone else answered the phone first.
//
// Nothing here names the phone on the wire: the hand-off author is thrown
// away, and the only tag is the one-off rendezvous value the phone chose.

import { deriveToken } from 'spoken-token'
import { finalizeEvent, generateSecretKey } from 'nostr-tools/pure'
import type { SimplePool } from 'nostr-tools/pool'

/** Kind of the board's answer, relayed to the waiting phone (ephemeral). */
export const HANDOFF_KIND = 24137
/** The board stores a phone label of at most this many UTF-8 bytes. */
export const LABEL_MAX_BYTES = 16
/** spoken-token context for the enrolment check code. */
export const CHECK_CONTEXT = 'heartwood-unlock:enrol-check'
/** The capability a signer lists in get_status when it serves phone unlock. */
export const PHONE_UNLOCK_CAPABILITY = 'phone_unlock_v1'

const CODE_PREFIX = 'heartwood-unlock:enrol?'
const HEX64 = /^[0-9a-f]{64}$/
const HEX32 = /^[0-9a-f]{32}$/

/** What the phone's enrolment code carries. */
export interface EnrolmentCode {
  enrolPubkey: string
  rendezvous: string
  label: string
  relays: string[]
}

/** A phone the board holds, as its list answer names it. */
export interface UnlockPhone {
  id: number
  label: string
}

export interface UnlockPhoneList {
  phones: UnlockPhone[]
  max: number
  announceOperator: boolean
}

/** The board's enrol answer: public key and ciphertext only. */
export interface EnrolAnswer {
  id: number
  ephemeralPubkey: string
  sealed: string
}

function utf8Length(text: string): number {
  return new TextEncoder().encode(text).length
}

function isRelayUrl(url: string): boolean {
  return /^wss?:\/\/\S+$/.test(url) && url.length <= 256
}

/**
 * Parse the code Cambium shows. Returns null for anything that is not a
 * complete v1 code; a repeated parameter (other than relay) is refused rather
 * than guessed at. Whitespace around the pasted text is tolerated.
 */
export function parseEnrolmentCode(input: string): EnrolmentCode | null {
  const text = typeof input === 'string' ? input.trim() : ''
  if (!text.startsWith(CODE_PREFIX)) return null
  const params: [string, string][] = []
  for (const pair of text.slice(CODE_PREFIX.length).split('&')) {
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
  const enrolPubkey = one('p')
  const rendezvous = one('r')
  const label = one('label')
  if (!enrolPubkey || !HEX64.test(enrolPubkey) || !rendezvous || !HEX32.test(rendezvous)) return null
  if (!label?.trim() || utf8Length(label) > LABEL_MAX_BYTES) return null
  const relays = params.filter(([key]) => key === 'relay').map(([, value]) => value)
  if (!relays.length || !relays.every(isRelayUrl)) return null
  return { enrolPubkey, rendezvous, label, relays: [...new Set(relays)] }
}

/**
 * The six characters the owner compares with Cambium, grouped as "9B6 164":
 * spoken-token's hex token of the board's one-off hand-off key. The board
 * draws that key fresh for every enrolment, so an answer raced in by someone
 * who saw the code matches one time in 16.7 million.
 */
export function checkCode(ephemeralPubkeyHex: string): string {
  if (!HEX64.test(ephemeralPubkeyHex)) throw new Error('hand-off key must be 64 hex characters')
  const hex = deriveToken(ephemeralPubkeyHex, CHECK_CONTEXT, 0, { format: 'hex', length: 6 }).toUpperCase()
  return `${hex.slice(0, 3)} ${hex.slice(3)}`
}

/** Read the board's list answer, failing closed on anything malformed. */
export function parsePhoneList(raw: unknown): UnlockPhoneList {
  if (!raw || typeof raw !== 'object') throw new Error('The signer sent an unreadable phone list.')
  const value = raw as Record<string, unknown>
  if (!Array.isArray(value.phones)) throw new Error('The signer sent an unreadable phone list.')
  const phones: UnlockPhone[] = []
  for (const row of value.phones) {
    if (!row || typeof row !== 'object') continue
    const { id, label } = row as Record<string, unknown>
    if (typeof id !== 'number' || !Number.isInteger(id) || id < 0) continue
    phones.push({ id, label: typeof label === 'string' && label ? label : 'phone' })
  }
  return {
    phones,
    max: typeof value.max === 'number' ? value.max : 16,
    announceOperator: value.announce_operator !== false,
  }
}

/** Read the board's enrol answer. */
export function parseEnrolAnswer(raw: unknown): EnrolAnswer {
  const value = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const { id, ephemeral_pubkey: ephemeralPubkey, sealed } = value
  if (typeof id !== 'number' || !Number.isInteger(id) || id < 0
    || typeof ephemeralPubkey !== 'string' || !HEX64.test(ephemeralPubkey)
    || typeof sealed !== 'string' || !sealed) {
    throw new Error('The signer added the phone but its answer was unreadable.')
  }
  return { id, ephemeralPubkey, sealed }
}

/** The kind-24137 hand-off, signed by a key that is used once and dropped. */
export function buildHandOffEvent(answer: EnrolAnswer, rendezvous: string, now = Date.now()) {
  if (!HEX32.test(rendezvous)) throw new Error('rendezvous tag must be 32 hex characters')
  const throwaway = generateSecretKey()
  try {
    return finalizeEvent({
      kind: HANDOFF_KIND,
      created_at: Math.floor(now / 1000),
      tags: [['h', rendezvous]],
      content: JSON.stringify({ id: answer.id, ephemeral_pubkey: answer.ephemeralPubkey, sealed: answer.sealed }),
    }, throwaway)
  } finally {
    throwaway.fill(0)
  }
}

type RelayPool = Pick<SimplePool, 'ensureRelay' | 'publish'>

/** Open the phone's relays before anything is enrolled: the hand-off is
 *  ephemeral, so it only reaches a phone that is connected when it lands.
 *  Returns the relays that answered. */
export async function openRelays(pool: RelayPool, relays: string[], timeoutMs = 8_000): Promise<string[]> {
  const results = await Promise.allSettled(relays.map((url) => pool.ensureRelay(url, { connectionTimeout: timeoutMs })))
  return relays.filter((_, i) => results[i].status === 'fulfilled')
}

/** Publish the hand-off and return the relays that accepted it. */
export async function publishHandOff(
  pool: RelayPool,
  relays: string[],
  event: ReturnType<typeof buildHandOffEvent>,
): Promise<string[]> {
  const results = await Promise.allSettled(pool.publish(relays, event))
  return relays.filter((_, i) => {
    const result = results[i]
    return result?.status === 'fulfilled' && !/^connection failure:/i.test(String(result.value))
  })
}

/** How the signer recovers after a power cut. */
export type UnlockMode = 'none' | 'phone' | 'sapwood'

/**
 * The signer does not report whether it is encrypted, so the mode is
 * inferred. An enrolled phone proves encryption is on (enrolment needs the
 * data key, and turning encryption off drops every phone). `known` is what
 * this page saw the signer accept this session (a seal, a PIN set, or
 * encryption turned off), and outranks a vault key this browser merely
 * holds. Anything else might be a boot PIN, or nothing: Sapwood cannot tell,
 * returns null, and says so rather than guess.
 */
export function inferUnlockMode(
  phones: number | null,
  vaultKeyHeld: boolean,
  known: boolean | null = null,
): UnlockMode | null {
  if (known === false) return 'none'
  if (phones !== null && phones > 0) return 'phone'
  if (known === true || vaultKeyHeld) return 'sapwood'
  return null
}

/** The board kept a record, but no relay took the hand-off to the phone. */
export class HandOffUndelivered extends Error {
  constructor(readonly id: number) {
    super(`The signer added record ${id}, but none of the phone's relays accepted the hand-off, so the phone never got it. Revoke record ${id} below and start again with a new code on the phone.`)
  }
}

export interface EnrolResult {
  id: number
  checkCode: string
  accepted: string[]
}

/**
 * Enrol the phone behind `code`, end to end: reach its relays first (the
 * hand-off is ephemeral and only reaches a phone listening when it lands),
 * ask the board (one press), then publish the sealed answer to the phone.
 * Sapwood holds nothing that opens it.
 */
export async function enrolPhone(
  code: EnrolmentCode,
  deps: {
    pool: RelayPool
    enrol: (enrolPubkey: string, label: string) => Promise<unknown>
    onBoard?: () => void
  },
): Promise<EnrolResult> {
  const live = await openRelays(deps.pool, code.relays)
  if (!live.length) {
    throw new Error('None of the phone\'s relays answered, so nothing was added. Check this computer\'s connection and try again.')
  }
  deps.onBoard?.()
  const answer = parseEnrolAnswer(await deps.enrol(code.enrolPubkey, code.label))
  const accepted = await publishHandOff(deps.pool, live, buildHandOffEvent(answer, code.rendezvous))
  if (!accepted.length) throw new HandOffUndelivered(answer.id)
  return { id: answer.id, checkCode: checkCode(answer.ephemeralPubkey), accepted }
}

// Enrolment keys this page has already sent to a signer. Cambium keeps a code
// on screen for minutes, so the same QR can be scanned again after "Finished";
// the signer refuses a reused key too, but only the last 16 and only until it
// reboots.
const spentEnrolKeys = new Set<string>()

export function markCodeSpent(code: EnrolmentCode): void {
  spentEnrolKeys.add(code.enrolPubkey)
}

export function isCodeSpent(code: EnrolmentCode): boolean {
  return spentEnrolKeys.has(code.enrolPubkey)
}
