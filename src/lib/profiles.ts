// Profile resolver — fetches kind 0 (metadata) events from Nostr relays to
// resolve hex pubkeys to human-readable names.
//
// The relays are operator-configurable (profile-relays.ts). The newest kind-0
// per author wins. Pure parsing is split out (parseKind0Content) so it can be
// unit-tested without a relay, and the relay query is injectable for the same
// reason.

import { SimplePool } from 'nostr-tools/pool'
import { getProfileRelays } from './profile-relays.js'

const TIMEOUT_MS = 5000

export interface Profile {
  name: string
  display_name?: string
  picture?: string
  nip05?: string
}

/** Parse a kind-0 event's `content` JSON into a Profile, or null if it is not
 *  valid JSON / not an object. `name` falls back through display_name. */
export function parseKind0Content(content: string): Profile | null {
  let data: unknown
  try {
    data = JSON.parse(content)
  } catch {
    return null
  }
  if (typeof data !== 'object' || data === null) return null
  const rec = data as Record<string, unknown>
  const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined)
  const displayName = str(rec.display_name) ?? str(rec.displayName)
  return {
    name: str(rec.name) ?? displayName ?? '',
    display_name: displayName,
    picture: str(rec.picture),
    nip05: str(rec.nip05),
  }
}

/** The best human label for a profile, or '' if it carries none. */
export function profileDisplayName(p: Profile): string {
  return p.display_name || p.name || ''
}

/** The minimal kind-0 event shape the resolver needs. */
interface Kind0Event {
  pubkey: string
  content: string
  created_at: number
}

/** Query kind-0 events for `pubkeys` from `relays`. Injectable for tests. */
export type FetchKind0 = (relays: string[], pubkeys: string[]) => Promise<Kind0Event[]>

const defaultFetch: FetchKind0 = async (relays, pubkeys) => {
  const pool = new SimplePool()
  try {
    return (await pool.querySync(relays, { kinds: [0], authors: pubkeys }, { maxWait: TIMEOUT_MS })) as Kind0Event[]
  } finally {
    pool.destroy()
  }
}

/** Resolve profiles for a list of hex pubkeys. Returns the newest profile per
 *  author; pubkeys with no resolvable profile are absent from the map. Never
 *  rejects — a relay failure yields whatever was gathered (possibly empty). */
export async function resolveProfiles(
  pubkeys: string[],
  relays: string[] = getProfileRelays(),
  fetchKind0: FetchKind0 = defaultFetch,
): Promise<Map<string, Profile>> {
  const out = new Map<string, Profile>()
  if (pubkeys.length === 0 || relays.length === 0) return out

  let events: Kind0Event[]
  try {
    events = await fetchKind0(relays, pubkeys)
  } catch {
    return out
  }

  // Keep the newest kind-0 per author.
  const newest = new Map<string, Kind0Event>()
  for (const e of events) {
    const cur = newest.get(e.pubkey)
    if (!cur || e.created_at > cur.created_at) newest.set(e.pubkey, e)
  }
  for (const [pk, e] of newest) {
    const profile = parseKind0Content(e.content)
    if (profile) out.set(pk, profile)
  }
  return out
}
