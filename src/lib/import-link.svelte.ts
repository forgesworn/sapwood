// "Manage from your phone" — a one-scan handoff. A QR shown on the computer
// (once a device is set up and connected) encodes everything the phone needs:
//   <origin>/#/import?op=<operator-sk>&dev=<device-pubkey>&relays=<csv>
// All of it rides in the URL *fragment*, so it is never sent to any server.
// On the phone, consumeImportLink() at startup loads the operator key, remembers
// the device, auto-connects over relays, then strips the secret from the URL.
//
// The user never sees the word "npub": the device address travels in the link.

import { importOperator } from './op-mgmt.js'
import { rememberDevice } from './known-devices.js'
import { connectRelay } from './device.svelte.js'
import { nip19 } from 'nostr-tools'

/** One-shot banner state: set when a deep-linked handoff has been consumed. */
export const importNotice = $state<{ shown: boolean }>({ shown: false })

export interface HandoffLink {
  /** Operator secret (hex) — the management credential. */
  op: string
  /** Device master pubkey (x-only hex) — its relay management address. */
  deviceHex?: string
  /** Relays the device listens on. */
  relays?: string[]
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

/** Build the handoff deep link. Device + relays are optional (op-only is valid). */
export function buildHandoffLink(origin: string, opSkHex: string, deviceHex?: string, relays?: string[]): string {
  const params = new URLSearchParams()
  params.set('op', opSkHex)
  if (deviceHex) params.set('dev', deviceHex)
  if (relays && relays.length) params.set('relays', relays.join(','))
  return `${origin}/#/import?${params.toString()}`
}

/** Parse an `#/import?…` hash into its parts, or null if absent / op invalid. */
export function parseImportLink(hash: string): HandoffLink | null {
  if (!/^#\/import\b/.test(hash)) return null
  const qi = hash.indexOf('?')
  if (qi === -1) return null
  const params = new URLSearchParams(hash.slice(qi + 1))
  const op = (params.get('op') ?? '').toLowerCase()
  if (!/^[0-9a-f]{64}$/.test(op)) return null
  const out: HandoffLink = { op }
  const dev = params.get('dev')
  if (dev) {
    const hex = toHex(dev)
    if (hex) out.deviceHex = hex
  }
  const relays = params.get('relays')
  if (relays) {
    const list = relays.split(',').map((r) => r.trim()).filter(Boolean)
    if (list.length) out.relays = list
  }
  return out
}

/** Back-compat: extract just the operator key from a deep link. */
export function parseImportOp(hash: string): string | null {
  return parseImportLink(hash)?.op ?? null
}

/**
 * If the current URL is a handoff deep link, load the operator key, remember the
 * device, auto-connect over relays, and clean the URL. Returns true if consumed.
 * Call once at startup, before mount.
 */
export function consumeImportLink(): boolean {
  if (typeof location === 'undefined') return false
  const link = parseImportLink(location.hash)
  if (!link) return false
  try {
    importOperator(link.op)
  } catch {
    return false
  }
  if (link.deviceHex && link.relays && link.relays.length) {
    rememberDevice(link.deviceHex, link.relays)
    // Fire-and-forget: the relay connection updates device state; failures
    // surface via device.error (and the device is remembered for a manual retry).
    void connectRelay(link.deviceHex, link.relays).catch(() => { /* surfaced via device.error */ })
  }
  try {
    history.replaceState(null, '', `${location.pathname}${location.search}#/`)
  } catch {
    location.hash = '#/'
  }
  importNotice.shown = true
  return true
}
