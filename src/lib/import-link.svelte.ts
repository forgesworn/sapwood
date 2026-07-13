// "Manage from your phone" — a one-scan handoff. A QR shown on the computer
// (once a device is set up and connected) encodes everything the phone needs:
//   <origin>/#/import?op=<operator-sk>&dev=<device-pubkey>&relays=<csv>       (plain)
//   <origin>/#/import?eop=<ncryptsec>&dev=<device-pubkey>&relays=<csv>        (PIN-protected)
// All of it rides in the URL *fragment*, so it is never sent to any server.
// On the phone, consumeImportLink() at startup loads the operator key, remembers
// the device, auto-connects over relays, then strips the secret from the URL.
//
// The operator secret is the management credential. A plain link carries it in
// the clear, so a photographed QR / saved link is a full handover. The protected
// form encrypts it with a PIN (NIP-49): the link is useless without the code,
// which the phone prompts for on arrival.
//
// The user never sees the word "npub": the device address travels in the link.

import { importOperator, peekOperatorPubHex, pubHexFromSecret } from './op-mgmt.js'
import { rememberDevice } from './known-devices.js'
import { connectRelay } from './device.svelte.js'
import { nip19 } from 'nostr-tools'
import { encrypt as nip49Encrypt, decrypt as nip49Decrypt } from 'nostr-tools/nip49'
import { hexToBytes, bytesToHex } from '@noble/hashes/utils.js'

/** One-shot banner state: set when a deep-linked handoff has been consumed. */
export const importNotice = $state<{ shown: boolean }>({ shown: false })

type HandoffConnectionPhase = 'idle' | 'connecting' | 'connected' | 'error'

interface HandoffConnectionTarget {
  deviceHex: string
  relays: string[]
  /** Public identity of the exact operator credential carried by this handoff. */
  operatorPubHex: string
}

/** Phone-handoff connection state. This is deliberately separate from the
 * generic picker: a protected QR has already supplied the one route we should
 * try, so showing USB/bridge choices while that attempt runs is misleading. */
export const handoffConnection = $state<{
  phase: HandoffConnectionPhase
  target: HandoffConnectionTarget | null
  error: string
}>({ phase: 'idle', target: null, error: '' })

let handoffAttempt = 0

function startHandoffConnection(target: HandoffConnectionTarget): void {
  const attempt = ++handoffAttempt
  handoffConnection.phase = 'connecting'
  handoffConnection.target = {
    ...target,
    relays: [...target.relays],
  }
  handoffConnection.error = ''

  void connectRelay(
    target.deviceHex,
    target.relays,
    undefined,
    target.operatorPubHex,
  ).then(() => {
    if (attempt !== handoffAttempt) return
    handoffConnection.phase = 'connected'
  }).catch(() => {
    if (attempt !== handoffAttempt) return
    handoffConnection.phase = 'error'
    // Do not leak relay URLs, keys or device identifiers into a screenshotable
    // phone error. Detailed diagnostics remain available from a trusted manager.
    handoffConnection.error = 'Make sure the signer is powered on and online, then try again.'
  })
}

/** Retry the exact imported route and operator; never guess another authority. */
export function retryHandoffConnection(): boolean {
  const target = handoffConnection.target
  if (!target) return false
  startHandoffConnection(target)
  return true
}

/** Leave the dedicated handoff state and return to the normal connection UI. */
export function dismissHandoffConnection(): void {
  handoffAttempt += 1
  handoffConnection.phase = 'idle'
  handoffConnection.target = null
  handoffConnection.error = ''
}

/**
 * A handoff link that would overwrite an *existing, different* operator key,
 * held back for explicit confirmation. Importing it silently would destroy the
 * user's current management credential (and, if the phrase was never written
 * down, permanently), and switch them onto an attacker-supplied device/relay.
 * The UI renders this as an old-vs-new prompt; nothing is imported until the
 * user confirms.
 */
export const pendingImport = $state<{
  link: HandoffLink | null
  currentPubHex: string
  incomingPubHex: string
}>({ link: null, currentPubHex: '', incomingPubHex: '' })

/** A PIN-protected handoff link parked until the user enters the PIN to unlock it. */
export const pendingPin = $state<{ link: HandoffLink | null }>({ link: null })

export interface HandoffLink {
  /** Operator secret (hex) — the management credential, in the clear. */
  op?: string
  /** Operator secret encrypted with a PIN (NIP-49 ncryptsec). */
  eop?: string
  /** Device master pubkey (x-only hex) — its relay management address. */
  deviceHex?: string
  /** Relays the device listens on. */
  relays?: string[]
}

const NCRYPTSEC_RE = /^ncryptsec1[02-9ac-hj-np-z]+$/

function isSafeHandoffRelay(value: string): boolean {
  if (value.length > 512) return false
  try {
    const url = new URL(value)
    return url.protocol === 'wss:'
      && url.hostname.length > 0
      && url.username === ''
      && url.password === ''
  } catch {
    return false
  }
}

/** Accept an npub or 64-char hex; return x-only hex, or null. */
function toHex(input: string): string | null {
  const s = input.trim()
  if (/^[0-9a-f]{64}$/i.test(s)) return s.toLowerCase()
  try {
    const d = nip19.decode(s)
    if (d.type === 'npub') return d.data as string
  } catch { /* fall through */ }
  return null
}

/** Encrypt an operator secret (hex) with a PIN → NIP-49 ncryptsec. */
export function encryptOperator(opSkHex: string, pin: string): string {
  const bytes = hexToBytes(opSkHex)
  try {
    return nip49Encrypt(bytes, pin)
  } finally {
    bytes.fill(0)
  }
}

/** Decrypt a NIP-49 ncryptsec back to an operator secret (hex). Throws on a
 *  wrong PIN or malformed input. */
function decryptOperator(ncryptsec: string, pin: string): string {
  const bytes = nip49Decrypt(ncryptsec.trim(), pin)
  try {
    return bytesToHex(bytes)
  } finally {
    bytes.fill(0)
  }
}

/** Build the plain (unprotected) handoff deep link. */
export function buildHandoffLink(origin: string, opSkHex: string, deviceHex?: string, relays?: string[]): string {
  const params = new URLSearchParams()
  params.set('op', opSkHex)
  if (deviceHex) params.set('dev', deviceHex)
  if (relays && relays.length) params.set('relays', relays.join(','))
  return `${origin}/#/import?${params.toString()}`
}

/** Build a PIN-protected handoff deep link (op secret encrypted as ncryptsec). */
export function buildProtectedHandoffLink(origin: string, opNcryptsec: string, deviceHex?: string, relays?: string[]): string {
  const params = new URLSearchParams()
  params.set('eop', opNcryptsec)
  if (deviceHex) params.set('dev', deviceHex)
  if (relays && relays.length) params.set('relays', relays.join(','))
  return `${origin}/#/import?${params.toString()}`
}

/** Parse an `#/import?…` hash into its parts, or null if absent / no usable
 *  operator secret (neither a valid `op` hex nor an `eop` ncryptsec). */
export function parseImportLink(hash: string): HandoffLink | null {
  if (!/^#\/import\b/.test(hash)) return null
  const qi = hash.indexOf('?')
  if (qi === -1) return null
  const params = new URLSearchParams(hash.slice(qi + 1))
  const op = (params.get('op') ?? '').toLowerCase()
  const eop = (params.get('eop') ?? '').trim()
  const hasOp = /^[0-9a-f]{64}$/.test(op)
  const hasEop = NCRYPTSEC_RE.test(eop)
  if (!hasOp && !hasEop) return null

  const out: HandoffLink = {}
  if (hasOp) out.op = op
  else out.eop = eop
  const dev = params.get('dev')
  if (dev) {
    const hex = toHex(dev)
    if (hex) out.deviceHex = hex
  }
  const relays = params.get('relays')
  if (relays) {
    const list = relays
      .split(',')
      .map((r) => r.trim())
      .filter(isSafeHandoffRelay)
      .slice(0, 8)
    if (list.length) out.relays = list
  }
  return out
}

/** Back-compat: extract just the (plain) operator key from a deep link. */
export function parseImportOp(hash: string): string | null {
  return parseImportLink(hash)?.op ?? null
}

/** Load the operator key, remember the device, auto-connect, and show the
 *  loaded banner. Called only with a link whose `op` is resolved. */
function applyLink(link: HandoffLink): boolean {
  if (!link.op) return false
  let operator
  try {
    operator = importOperator(link.op)
  } catch {
    return false
  }
  if (link.deviceHex && link.relays && link.relays.length) {
    try { rememberDevice(link.deviceHex, link.relays) } catch { /* live route still works */ }
    startHandoffConnection({
      deviceHex: link.deviceHex,
      relays: link.relays,
      operatorPubHex: operator.pubHex,
    })
  } else {
    // Backwards-compatible operator-only links still import the credential, but
    // they cannot claim to be pairing a phone with a signer route.
    dismissHandoffConnection()
  }
  importNotice.shown = true
  return true
}

/** Import a now-plaintext operator secret, or park it for confirmation when it
 *  would overwrite a different existing key. Shared by the plain-link path and
 *  the post-PIN path. */
function resolveAndImport(opHex: string, deviceHex?: string, relays?: string[]): boolean {
  const incomingPubHex = pubHexFromSecret(opHex)
  if (incomingPubHex === null) return false
  const currentPubHex = peekOperatorPubHex()
  if (currentPubHex && currentPubHex !== incomingPubHex) {
    pendingImport.link = { op: opHex, deviceHex, relays }
    pendingImport.currentPubHex = currentPubHex
    pendingImport.incomingPubHex = incomingPubHex
    return true // parked for confirmation
  }
  return applyLink({ op: opHex, deviceHex, relays })
}

/** Strip the `#/import?…` (with its secret) from the address bar. */
function cleanImportUrl(): void {
  try {
    history.replaceState(null, '', `${location.pathname}${location.search}#/`)
  } catch {
    location.hash = '#/'
  }
}

/**
 * If the current URL is a handoff deep link, load the operator key, remember the
 * device, auto-connect over relays, and clean the URL. Returns true if consumed.
 * Call once at startup, before mount.
 *
 * A PIN-protected link (`eop`) is parked in `pendingPin` for the UI to collect
 * the PIN; nothing is imported until it decrypts. A plain link with a *different*
 * existing operator key is parked in `pendingImport` for explicit confirmation
 * (overwriting would destroy the current credential). A link matching the
 * existing key, or arriving when none is stored, imports directly.
 */
export function consumeImportLink(): boolean {
  if (typeof location === 'undefined') return false
  const link = parseImportLink(location.hash)
  if (!link) return false

  // PIN-protected: we can do nothing until the user supplies the PIN.
  if (link.eop && !link.op) {
    pendingPin.link = link
    cleanImportUrl() // the ciphertext is harmless, but keep the bar clean anyway
    return true
  }

  const ok = resolveAndImport(link.op!, link.deviceHex, link.relays)
  cleanImportUrl()
  return ok
}

/** Submit the PIN for a parked protected link: decrypt, then import (or park a
 *  further overwrite confirmation). Returns an error message on a wrong PIN. */
export function submitPin(pin: string): { ok: boolean; error?: string } {
  const link = pendingPin.link
  if (!link?.eop) return { ok: false, error: 'There is no pending link.' }
  let opHex: string
  try {
    opHex = decryptOperator(link.eop, pin)
  } catch {
    return { ok: false, error: 'That PIN did not unlock the link. Check it and try again.' }
  }
  pendingPin.link = null
  const ok = resolveAndImport(opHex, link.deviceHex, link.relays)
  return ok
    ? { ok: true }
    : { ok: false, error: 'This pairing link could not be imported.' }
}

/** Abandon a parked protected link without importing. */
export function dismissPin(): void {
  pendingPin.link = null
}

/** Confirm a parked overwrite (from `pendingImport`): perform the import. */
export function confirmPendingImport(): boolean {
  const link = pendingImport.link
  if (!link) return false
  const ok = applyLink(link)
  pendingImport.link = null
  return ok
}

/** Reject a parked overwrite: keep the existing operator key untouched. */
export function dismissPendingImport(): void {
  pendingImport.link = null
}
