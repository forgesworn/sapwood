// Parse a nostrconnect:// URI — the client-initiated NIP-46 pairing direction,
// where an app generates the link and the signer connects TO it (the mirror of
// the bunker:// flow, where the signer hands out the link). Mirrors signet-lite's
// parseNostrConnectURI. Pure and unit-testable: no device, no relay.
//
//   nostrconnect://<client-pubkey-hex>?relay=<wss>&secret=<s>&perms=<p>&name=<n>&url=<u>
//
// The signer completes the pairing by publishing a connect ACK to the app's
// relay whose NIP-46 result echoes `secret`. For a WiFi Heartwood signer that
// only means anything when the app's relay is one the signer already serves —
// the UI checks that before handing the request to the device.

import { exactClientPolicy } from './client-policy.js'
import type { ExactClientPolicy } from './types.js'

export interface NostrConnectRequest {
  /** The app's ephemeral pubkey (64-char hex) — the slot binds to this. */
  clientPubkey: string
  /** Relays the app listens on. It awaits the ACK and sends requests here. */
  relays: string[]
  /** One-time secret echoed back in the connect ACK to complete pairing. */
  secret: string
  /** Requested permissions, e.g. ["sign_event:1", "get_public_key"]. */
  perms: string[]
  /** A display name for the app, sanitised. */
  appName: string
  /** The app's https origin, if it supplied a valid one. */
  appUrl?: string
}

// A real nostrconnect URI is short (pubkey + a relay + metadata). Bound it before
// parsing so an oversized value from a paste/QR can't be a parse-time DoS.
const MAX_URI_LEN = 4096

/** Drop control, DEL, and bidi / zero-width chars from an attacker-controlled
 *  display string so a crafted name can't reorder or hide UI text. */
function sanitizeName(s: string, max: number): string {
  const out = [...s].filter((ch) => {
    const c = ch.codePointAt(0)!
    if (c < 0x20 || c === 0x7f) return false // control + DEL
    if (c >= 0x200b && c <= 0x200f) return false // zero-width + LRM/RLM
    if (c >= 0x202a && c <= 0x202e) return false // bidi embeddings/overrides
    if (c >= 0x2066 && c <= 0x2069) return false // bidi isolates
    return true
  }).join('')
  return out.trim().slice(0, max)
}

/** A ws:// or wss:// relay URL. */
function isRelayUrl(u: string): boolean {
  try {
    const x = new URL(u)
    return x.protocol === 'wss:' || x.protocol === 'ws:'
  } catch {
    return false
  }
}

/** Parse a nostrconnect:// URI, or null if it is not a well-formed one. */
export function parseNostrConnectURI(uri: string): NostrConnectRequest | null {
  if (typeof uri !== 'string' || uri.length > MAX_URI_LEN) return null
  if (!uri.startsWith('nostrconnect://')) return null
  try {
    // Swap the scheme so the URL parser handles host + query for us.
    const url = new URL(uri.replace('nostrconnect://', 'https://'))
    const clientPubkey = url.hostname.toLowerCase()
    if (!/^[0-9a-f]{64}$/.test(clientPubkey)) return null

    const relays = url.searchParams.getAll('relay')
      .map((r) => r.trim())
      .filter((r, i, a) => r.length > 0 && a.indexOf(r) === i && isRelayUrl(r))
    const secret = url.searchParams.get('secret') ?? ''
    if (relays.length === 0 || !secret) return null

    const perms = (url.searchParams.get('perms') ?? '')
      .split(',').map((p) => p.trim()).filter(Boolean)

    let appName = 'Unknown app'
    const nameParam = url.searchParams.get('name')
    if (nameParam) {
      const safe = sanitizeName(nameParam, 100)
      if (safe) appName = safe
    }

    let appUrl: string | undefined
    const urlParam = url.searchParams.get('url')
    if (urlParam) {
      try {
        const u = new URL(urlParam)
        if (u.protocol === 'https:') appUrl = u.origin.slice(0, 200)
      } catch { /* invalid — leave undefined */ }
    }

    return { clientPubkey, relays, secret, perms, appName, appUrl }
  } catch {
    return null
  }
}

/** True when the input is a well-formed nostrconnect:// URI. */
export function isValidNostrConnect(uri: string): boolean {
  return parseNostrConnectURI(uri.trim()) !== null
}

export interface NostrConnectPermissionResult {
  /** Complete fail-closed policy. Never infer signing from an empty kind list. */
  policy: ExactClientPolicy
  /** Any issue blocks pairing; nothing is silently ignored. */
  issues: string[]
  supplied: boolean
  signing: 'none' | 'all' | 'kinds'
  requestedMethods: string[]
}

const SUPPORTED_PERMISSION_METHODS = new Set([
  'get_public_key',
  'nip04_encrypt',
  'nip04_decrypt',
  'nip44_encrypt',
  'nip44_decrypt',
])
const STANDARD_BUT_UNSUPPORTED = new Set(['switch_relays', 'logout'])
const MAX_PERMISSIONS = 64

/** Parse NIP-46's current `method[:params]` permission grammar into the exact
 * Heartwood policy. Only sign_event defines a parameter today (the event kind).
 * Unknown/malformed/unsupported entries are surfaced and block pairing. */
export function permissionsToClientPolicy(perms: string[]): NostrConnectPermissionResult {
  const issues: string[] = []
  const methods = new Set<string>()
  const requestedMethods = new Set<string>()
  const kinds = new Set<number>()
  let signAll = false

  if (perms.length > MAX_PERMISSIONS) {
    issues.push(`The app requested more than ${MAX_PERMISSIONS} permissions.`)
  }

  for (const raw of perms.slice(0, MAX_PERMISSIONS)) {
    const token = raw.trim()
    const colon = token.indexOf(':')
    const method = colon < 0 ? token : token.slice(0, colon)
    const param = colon < 0 ? null : token.slice(colon + 1)
    requestedMethods.add(method)

    if (method === 'sign_event') {
      if (param === null) {
        methods.add('sign_event')
        signAll = true
        continue
      }
      if (!/^\d+$/.test(param)) {
        issues.push(`Invalid event kind in permission “${raw}”.`)
        continue
      }
      const kind = Number(param)
      if (!Number.isSafeInteger(kind)) {
        issues.push(`Event kind in permission “${raw}” is too large.`)
        continue
      }
      methods.add('sign_event')
      kinds.add(kind)
      continue
    }

    if (SUPPORTED_PERMISSION_METHODS.has(method)) {
      if (param !== null) {
        issues.push(`Permission “${raw}” uses parameters Heartwood cannot safely interpret.`)
      } else {
        methods.add(method)
      }
      continue
    }

    // Ping is implemented and always harmless; it does not need a stored slot
    // grant. Keep it in the human-readable request but not the policy payload.
    if (method === 'ping' && param === null) continue

    if (STANDARD_BUT_UNSUPPORTED.has(method)) {
      issues.push(`This signer does not support the requested “${method}” permission yet.`)
    } else {
      issues.push(`Unknown permission “${raw}”.`)
    }
  }

  const signing = !methods.has('sign_event') ? 'none' : signAll ? 'all' : 'kinds'
  const allowedKinds = signAll ? [] : [...kinds]
  return {
    policy: exactClientPolicy([...methods], allowedKinds),
    issues,
    supplied: perms.length > 0,
    signing,
    requestedMethods: [...requestedMethods],
  }
}

/** Plain confirmation copy for the security boundary shown before pairing. */
export function describeNostrConnectPermissions(result: NostrConnectPermissionResult): string {
  const actions: string[] = []
  if (result.signing === 'all') actions.push('sign any event')
  if (result.signing === 'kinds') actions.push(`sign event kinds ${result.policy.allowed_kinds.join(', ')}`)
  if (result.policy.allowed_methods.includes('nip44_encrypt')) actions.push('NIP-44 encrypt')
  if (result.policy.allowed_methods.includes('nip44_decrypt')) actions.push('NIP-44 decrypt')
  if (result.policy.allowed_methods.includes('nip04_encrypt')) actions.push('NIP-04 encrypt')
  if (result.policy.allowed_methods.includes('nip04_decrypt')) actions.push('NIP-04 decrypt')
  return actions.length
    ? actions.join('; ')
    : 'connect and read your public key only; no automatic signing or decryption'
}

/** Whether any of the app's relays is one the signer serves — the pairing only
 *  works over a shared relay (a WiFi signer can't dial the app's own relay).
 *  Compares on host+path, ignoring a trailing slash and scheme case. */
export function sharesRelay(appRelays: string[], signerRelays: string[]): boolean {
  return sharedRelay(appRelays, signerRelays) !== null
}

/** The first of the app's relays the signer actually serves, or null. This is
 *  the relay the connect reply travels over — name THIS one in the UI, not
 *  simply the first relay the app happened to list. */
export function sharedRelay(appRelays: string[], signerRelays: string[]): string | null {
  const norm = (u: string) => u.trim().replace(/\/+$/, '').toLowerCase()
  const serve = new Set(signerRelays.map(norm))
  return appRelays.find((r) => serve.has(norm(r))) ?? null
}
