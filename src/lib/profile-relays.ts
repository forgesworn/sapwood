// Configurable relay list for kind-0 (profile metadata) lookups.
//
// Profiles are resolved by querying kind-0 events from these relays (see
// profiles.ts). The list is operator-configurable in Settings and persisted in
// localStorage, defaulting to the project relay. Separate from the device's own
// relays (known-devices.ts) and the bridge config — profile lookups are a
// read-only convenience and may want a different, better-indexed relay.

const LS_KEY = 'heartwood.profileRelays'

export const DEFAULT_PROFILE_RELAYS = ['wss://relay.trotters.cc']

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

/** The configured profile relays, or the default if none are stored/valid. */
export function getProfileRelays(): string[] {
  try {
    const raw = localStorage.getItem(LS_KEY)
    if (!raw) return [...DEFAULT_PROFILE_RELAYS]
    const arr = JSON.parse(raw) as unknown
    if (!Array.isArray(arr)) return [...DEFAULT_PROFILE_RELAYS]
    const valid = arr.filter((r): r is string => typeof r === 'string' && isValidRelayUrl(r))
    return valid.length ? dedupe(valid) : [...DEFAULT_PROFILE_RELAYS]
  } catch {
    return [...DEFAULT_PROFILE_RELAYS]
  }
}

/** Persist the profile relays (trimmed, validated, de-duplicated, order kept). */
export function setProfileRelays(relays: string[]): void {
  const clean = dedupe(relays.map((r) => r.trim()).filter(isValidRelayUrl))
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(clean))
  } catch {
    // localStorage unavailable (private mode / quota) — non-fatal for a lookup convenience.
  }
}

function dedupe(relays: string[]): string[] {
  const seen = new Set<string>()
  return relays.filter((r) => (seen.has(r) ? false : (seen.add(r), true)))
}
