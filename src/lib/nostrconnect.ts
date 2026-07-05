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

/** The per-kind signing limit implied by the perms list (its sign_event:<kind>
 *  entries). Empty means no per-kind limit was requested (unrestricted). */
export function permsToAllowedKinds(perms: string[]): number[] {
  const kinds = new Set<number>()
  for (const p of perms) {
    const m = /^sign_event:(\d+)$/.exec(p)
    if (m) kinds.add(Number(m[1]))
  }
  return [...kinds]
}

/** Whether any of the app's relays is one the signer serves — the pairing only
 *  works over a shared relay (a WiFi signer can't dial the app's own relay).
 *  Compares on host+path, ignoring a trailing slash and scheme case. */
export function sharesRelay(appRelays: string[], signerRelays: string[]): boolean {
  const norm = (u: string) => u.trim().replace(/\/+$/, '').toLowerCase()
  const serve = new Set(signerRelays.map(norm))
  return appRelays.some((r) => serve.has(norm(r)))
}
