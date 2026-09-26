// Phones that can unlock the signer after a restart: the Sapwood side of
// heartwood-esp32's phone-unlock design (firmware 0.18.0-beta.17, frame 0x64)
// and Cambium's enrolment screen. Two ways for the phone's enrolment code to
// reach this page, both ending at the same `add()` in UnlockPhones.svelte:
//
// Phone-shows-a-code (paste or scan the phone's screen), end to end:
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
// Sapwood-shows-a-code (the invite, default path, `enrol-invite.ts`), reverses
// the optical step for a desktop with no camera:
//   1. Sapwood makes a one-off invite keypair and rendezvous, and shows a QR
//      of heartwood-unlock:invite?v=1&k=<invite pubkey>&r=<rendezvous>
//      &x=<expiry>&relay=<url>...
//   2. Cambium scans it, builds the same enrolment code as above, and
//      publishes it as ONE kind-24137 event from a throwaway key: tagged
//      ["h", rendezvous] (the invite's, never the hand-off's), content is that
//      enrolment code string, NIP-44 encrypted to the invite's public key.
//   3. Sapwood decrypts the first valid reply (`openInviteReply`) and shows
//      the phone's five request words for the owner to compare, then feeds
//      the resulting `EnrolmentCode` into the exact same `enrolPhone` as
//      above: from here on both paths are identical.
//
// Nothing here names the phone on the wire: the hand-off author is thrown
// away, and the only tag on either kind-24137 event is a one-off rendezvous
// value, chosen by whichever side is waiting for the answer.

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
/** The capability a signer lists in get_status when `enrol_unlock_phone`
 *  works over the relay, not only the cable. */
export const RELAY_ENROL_CAPABILITY = 'phone_enrol_relay_v1'
/** spoken-token context for the board's request-code words, derived from the
 *  phone's one-off enrolment key. The owner holds only if these match the
 *  phone that made the key, never a copy this page shows as a convenience. */
export const REQUEST_CODE_CONTEXT = 'heartwood-unlock:enrol-request'
/** How many words the board's enrol card leads with. */
export const REQUEST_CODE_WORDS = 5

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
 * Fit a label the board will accept: printable ASCII (0x20-0x7E) only, and at
 * most `maxBytes`. Sapwood transliterates common accented Latin letters (so
 * "Café" becomes "Cafe" rather than being refused outright), strips anything
 * else the board's fonts could not draw as itself, then truncates. A label
 * that becomes empty falls back to "phone", matching the board's own default
 * for an empty label.
 */
export function fitLabel(label: string, maxBytes = LABEL_MAX_BYTES): string {
  const transliterated = label.normalize('NFKD').replace(/[̀-ͯ]/g, '')
  const ascii = Array.from(transliterated)
    .filter((char) => {
      const code = char.codePointAt(0) ?? 0
      return code >= 0x20 && code <= 0x7e
    })
    .join('')
    .trim()
  if (!ascii) return 'phone'
  let bytes = new TextEncoder().encode(ascii)
  if (bytes.length <= maxBytes) return ascii
  bytes = bytes.slice(0, maxBytes)
  // Never split a multi-byte sequence: ASCII is single-byte, so this only
  // matters if maxBytes lands mid-surrogate for input this function already
  // restricted to ASCII, which it cannot.
  return new TextDecoder().decode(bytes).trimEnd()
}

/**
 * Plain wording for a refusal the board sends back for `enrol_unlock_phone`
 * (over the cable or the relay), mirroring `EnrolRefusal::message` in
 * `common/src/phone_unlock.rs`. Anything not recognised is shown as the board
 * sent it.
 */
export function friendlyEnrolRefusal(reason: string): string {
  if (/set a PIN or vault key first/i.test(reason)) {
    return 'Phone unlock opens encrypted storage, and this signer is not encrypted. Turn on Encrypt at rest (Security, below) or set a boot PIN, then add the phone with a new code.'
  }
  if (/declined on the board/i.test(reason)) {
    return 'Declined on the signer, so nothing was added. Each code works once: start again on the phone for a new one.'
  }
  if (/already used/i.test(reason)) {
    return 'The signer has already seen this code. Start again on the phone for a new one.'
  }
  if (/relays configured/i.test(reason)) {
    return 'The signer has no WiFi relays set, so it could never reach a phone. Set its network up first (Network, above).'
  }
  if (/unlock the board first/i.test(reason)) {
    return 'The signer is locked or holds no identity yet. Unlock it, or add an identity, first.'
  }
  if (/requires the device operator/i.test(reason)) {
    return 'Only the device operator can add a phone remotely.'
  }
  if (/another phone is already waiting/i.test(reason)) {
    return 'Another phone is already waiting for a press on the signer. Wait for that to resolve, then try again.'
  }
  if (/^label longer than/i.test(reason)) {
    return 'That label is too long for the signer to store. Shorten it and try again.'
  }
  if (/phones already enrolled/i.test(reason)) {
    return 'This signer already holds as many phones as it can. Revoke one before adding another.'
  }
  if (/device operator changed while the card was up/i.test(reason)) {
    return 'The device operator changed while the signer\'s card was up, so nothing was added. Try again.'
  }
  if (/no relay was live to carry the answer/i.test(reason)) {
    return 'No relay was live when the signer tried to answer, so nothing was added. Check the signer\'s WiFi and try again.'
  }
  if (/device low on memory/i.test(reason)) {
    return 'The signer is low on memory right now. Nothing was added: wait a moment and try again.'
  }
  if (/signer is busy with another approval/i.test(reason)) {
    return 'The signer is busy with another approval. Wait for it to finish, then try again.'
  }
  return reason
}

/**
 * The one phone id present in `after` but not `before`, when there is
 * exactly one: the record `enrol_unlock_phone` left behind after its request
 * timed out with no reply, so nobody holds its secret ("Not sent / revoke id
 * N" on the board's own screen). Ambiguous (none, or more than one new
 * record) returns null, since nothing here can tell those apart safely.
 */
export function findOrphanedPhoneId(before: UnlockPhone[], after: UnlockPhone[]): number | null {
  const known = new Set(before.map((phone) => phone.id))
  const added = after.filter((phone) => !known.has(phone.id))
  return added.length === 1 ? added[0].id : null
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

/**
 * The five words the board's enrol card leads with, from the phone's one-off
 * enrolment key P: `deriveToken(P, 'heartwood-unlock:enrol-request', 0,
 * {format:'words', count:5})`. Sapwood may show this too, but only as a
 * convenience: the owner's compare is the BOARD against the PHONE (Cambium's
 * own screen), never against this page, since whoever relayed the request
 * could have swapped P for one of their own.
 */
export function requestWords(enrolPubkeyHex: string): string[] {
  if (!HEX64.test(enrolPubkeyHex)) throw new Error('enrolment key must be 64 hex characters')
  return deriveToken(enrolPubkeyHex, REQUEST_CODE_CONTEXT, 0, { format: 'words', count: REQUEST_CODE_WORDS }).split(' ')
}

/** The request-code words, space-joined, as the board's card shows them. */
export function requestCode(enrolPubkeyHex: string): string {
  return requestWords(enrolPubkeyHex).join(' ')
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
 *
 * Kept as the fallback for firmware that predates the `at_rest` report
 * (released beta.17); see `resolveUnlockMode`, which callers should use
 * instead.
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

/** Wire values for the firmware's own at-rest report (FIRMWARE_INFO and
 *  get_status's `at_rest`, plan G2). Any other string is unknown to this
 *  build and must never be guessed at. */
const KNOWN_AT_REST_VALUES = ['none', 'pin', 'vault', 'encrypted'] as const
export type AtRestReport = (typeof KNOWN_AT_REST_VALUES)[number]

function isKnownAtRest(value: string): value is AtRestReport {
  return (KNOWN_AT_REST_VALUES as readonly string[]).includes(value)
}

/**
 * The mode shown in "After a power cut". Firmware ≥ #192 reports `at_rest`
 * and `unlock_phone_count` directly, on both FIRMWARE_INFO and get_status
 * (device operator only there; a delegate never sees either field), so this
 * reads those instead of guessing from side effects.
 *
 * `known`, what this page saw the signer accept moments ago (a seal, a PIN
 * set, or encryption turned off), still wins when set: it reflects an
 * action this session just took, ahead of a firmware report that has not
 * been re-polled since. Once it resets to null, the firmware's own answer
 * takes over.
 *
 * `atRest` absent (`undefined`) means older firmware that never sends the
 * field (released beta.17): fall back to `inferUnlockMode`'s guess. A
 * present but unrecognised value is reported as unknown (null) rather than
 * mapped to whatever meaning looks closest; a future wire value must never
 * be silently reinterpreted.
 */
export function resolveUnlockMode(
  atRest: string | undefined,
  phones: number | null,
  vaultKeyHeld: boolean,
  known: boolean | null = null,
): UnlockMode | null {
  if (known !== null || atRest === undefined) return inferUnlockMode(phones, vaultKeyHeld, known)
  if (!isKnownAtRest(atRest)) return null
  if (atRest === 'none') return 'none'
  return phones !== null && phones > 0 ? 'phone' : 'sapwood'
}

/**
 * Whether a session's `known` override (see `resolveUnlockMode`) has done its
 * job and should stand down. `baseline` is the firmware's `at_rest` value at
 * the moment the override was set (possibly still undefined, on firmware that
 * sends none); once a later report differs from that baseline, either a relay
 * poll caught up or a fresh USB read landed, and the firmware's own answer
 * should take over again rather than the override blocking it indefinitely.
 */
export function shouldRetireEncryptionKnown(atRest: string | undefined, baseline: string | undefined): boolean {
  return atRest !== undefined && atRest !== baseline
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
  // Residual (documented in heartwood-esp32's SECURITY-MODEL.md): the
  // enrolment request and this hand-off both leave from this browser at
  // about the same moment, so a relay that sees both can link them to this
  // enrolment. Publishing the hand-off again later, or from elsewhere, would
  // not remove that link, since the first publish already happened alongside
  // the request; it would only add a second, equally correlatable event.
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
