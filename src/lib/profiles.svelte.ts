// Reactive cache of resolved profile display names, keyed by lowercase hex
// pubkey. Components call ensureProfiles() for the pubkeys they show (e.g. from
// an $effect) and read profileName() in their markup; the name fills in once
// the kind-0 lookup returns and the UI updates reactively.

import { resolveProfiles, profileDisplayName } from './profiles.js'
import { getProfileRelays } from './profile-relays.js'

// pubkey(lowercase hex) -> display name. '' means "looked up, no name" (which
// stops repeat lookups); an absent key means "not looked up yet".
const names = $state<Record<string, string>>({})
const inflight = new Set<string>()

/** The resolved display name for a pubkey, or undefined if none is known. */
export function profileName(pubkeyHex: string): string | undefined {
  const n = names[pubkeyHex.toLowerCase()]
  return n ? n : undefined
}

/** Look up and cache names for any of `pubkeys` not already known. Safe to call
 *  repeatedly (e.g. from an $effect): only unfetched, well-formed keys hit the
 *  network, and a miss is remembered as "no name" so it does not loop. */
export async function ensureProfiles(pubkeys: string[]): Promise<void> {
  const missing = [...new Set(pubkeys.map((p) => p.toLowerCase()))].filter(
    (p) => /^[0-9a-f]{64}$/.test(p) && !(p in names) && !inflight.has(p),
  )
  if (missing.length === 0) return
  for (const p of missing) inflight.add(p)
  try {
    const resolved = await resolveProfiles(missing, getProfileRelays())
    for (const p of missing) {
      const profile = resolved.get(p)
      names[p] = profile ? profileDisplayName(profile) : ''
    }
  } catch {
    for (const p of missing) names[p] = '' // give up quietly; do not retry-loop
  } finally {
    for (const p of missing) inflight.delete(p)
  }
}

/** Forget all cached names — call when the profile relays change so names
 *  re-resolve from the new source. */
export function clearProfileCache(): void {
  for (const k of Object.keys(names)) delete names[k]
  inflight.clear()
}
