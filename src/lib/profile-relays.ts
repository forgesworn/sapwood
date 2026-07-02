// Configurable relay list for kind-0 (profile metadata) lookups.
//
// Profiles are resolved by querying kind-0 events from ALL of these relays
// (see profiles.ts). Relays marked `write` additionally receive a mirror of
// any profile found — so a kind-0 that only lives on the big public indexes
// becomes resolvable from the project relay next time. The list is
// operator-configurable in Settings and persisted in localStorage. Separate
// from the device's own relays (known-devices.ts) and the bridge config.

const LS_KEY = 'heartwood.profileRelays'

/** A profile relay: always read from; `write: true` also receives mirrored
 *  kind-0s (the project relay, so profiles accumulate where our devices look). */
export interface ProfileRelay {
  url: string
  write: boolean
}

const PROJECT_RELAY = 'wss://relay.trotters.cc'

// The project relay is the only write target; the rest are the widely-mirrored
// public indexes the pallasite apps read profiles from, so a profile published
// from any mainstream client still resolves — and gets mirrored home.
export const DEFAULT_PROFILE_RELAYS: ProfileRelay[] = [
  { url: PROJECT_RELAY, write: true },
  { url: 'wss://purplepag.es', write: false },
  { url: 'wss://relay.damus.io', write: false },
  { url: 'wss://relay.nostr.band', write: false },
  { url: 'wss://nos.lol', write: false },
  { url: 'wss://relay.primal.net', write: false },
  { url: 'wss://relay.ditto.pub', write: false },
]

/** A relay URL is valid if it is wss://, or ws:// against localhost (dev only). */
export function isValidRelayUrl(url: string): boolean {
  let parsed: URL
  try {
    parsed = new URL(url.trim())
  } catch {
    return false
  }
  if (parsed.protocol === 'wss:') return true
  return parsed.protocol === 'ws:' && (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1')
}

/** Coerce one stored entry to a ProfileRelay, or null if unusable. A bare
 *  string is the pre-read/write storage shape: the project relay keeps its
 *  write role, anything else is read-only (nothing was ever published there). */
function coerce(entry: unknown): ProfileRelay | null {
  if (typeof entry === 'string') {
    const url = entry.trim()
    return isValidRelayUrl(url) ? { url, write: url === PROJECT_RELAY } : null
  }
  if (typeof entry === 'object' && entry !== null) {
    const rec = entry as Record<string, unknown>
    if (typeof rec.url !== 'string') return null
    const url = rec.url.trim()
    return isValidRelayUrl(url) ? { url, write: rec.write === true } : null
  }
  return null
}

/** The configured profile relays, or the default if none are stored/valid. */
export function getProfileRelays(): ProfileRelay[] {
  try {
    const raw = localStorage.getItem(LS_KEY)
    if (!raw) return structuredClone(DEFAULT_PROFILE_RELAYS)
    const arr = JSON.parse(raw) as unknown
    if (!Array.isArray(arr)) return structuredClone(DEFAULT_PROFILE_RELAYS)
    const valid = dedupe(arr.map(coerce).filter((r): r is ProfileRelay => r !== null))
    return valid.length ? valid : structuredClone(DEFAULT_PROFILE_RELAYS)
  } catch {
    return structuredClone(DEFAULT_PROFILE_RELAYS)
  }
}

/** Persist the profile relays (trimmed, validated, de-duplicated, order kept). */
export function setProfileRelays(relays: ProfileRelay[]): void {
  const clean = dedupe(relays.map(coerce).filter((r): r is ProfileRelay => r !== null))
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(clean))
  } catch {
    // localStorage unavailable (private mode / quota) — non-fatal for a lookup convenience.
  }
}

function dedupe(relays: ProfileRelay[]): ProfileRelay[] {
  const seen = new Set<string>()
  return relays.filter((r) => (seen.has(r.url) ? false : (seen.add(r.url), true)))
}
