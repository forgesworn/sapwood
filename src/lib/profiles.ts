// Profile resolver — fetches kind 0 (metadata) events from Nostr relays to
// resolve hex pubkeys to human-readable names.
//
// The relays are operator-configurable (profile-relays.ts): all are read from,
// and any profile found is mirrored (the signed event re-published verbatim)
// to the relays marked `write` — so a kind-0 that only lives on the public
// indexes becomes resolvable from the project relay next time. The newest
// kind-0 per author wins. Pure parsing is split out (parseKind0Content) so it
// can be unit-tested without a relay, and the relay query + publish are
// injectable for the same reason.

import { SimplePool } from 'nostr-tools/pool'
import type { Event as NostrEvent } from 'nostr-tools/core'
import { getProfileRelays, type ProfileRelay } from './profile-relays.js'

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

/** The kind-0 event shape the resolver needs. The full-event fields (id, sig,
 *  kind, tags) are what relays actually return and are required to mirror the
 *  event to a write relay; resolution itself only needs the first three. */
export interface Kind0Event {
  pubkey: string
  content: string
  created_at: number
  id?: string
  sig?: string
  kind?: number
  tags?: string[][]
}

/** Query kind-0 events for `pubkeys` from `relays`. Injectable for tests. */
export type FetchKind0 = (relays: string[], pubkeys: string[]) => Promise<Kind0Event[]>

/** Publish signed kind-0 events to `relays`. Injectable for tests. */
export type PublishKind0 = (relays: string[], events: Kind0Event[]) => Promise<void>

const defaultFetch: FetchKind0 = async (relays, pubkeys) => {
  const pool = new SimplePool()
  try {
    return (await pool.querySync(relays, { kinds: [0], authors: pubkeys }, { maxWait: TIMEOUT_MS })) as Kind0Event[]
  } finally {
    pool.destroy()
  }
}

const defaultPublish: PublishKind0 = async (relays, events) => {
  const pool = new SimplePool()
  try {
    // Per-relay rejections (duplicates, rate limits) are fine — best-effort.
    await Promise.allSettled(events.flatMap((e) => pool.publish(relays, e as NostrEvent)))
  } finally {
    pool.destroy()
  }
}

/** Mirror the resolved kind-0s to the write relays, fire-and-forget. Only full
 *  signed events can be re-published; relays keep the newest replaceable event,
 *  so re-sending something a write relay already has is a cheap duplicate. */
function mirrorToWriteRelays(relays: ProfileRelay[], newest: Map<string, Kind0Event>, publish: PublishKind0): void {
  const writes = relays.filter((r) => r.write).map((r) => r.url)
  if (writes.length === 0) return
  const events = [...newest.values()].filter((e) => e.id && e.sig)
  if (events.length === 0) return
  void publish(writes, events).catch(() => {
    /* mirroring is a convenience — never let it surface */
  })
}

/** Resolve profiles for a list of hex pubkeys. Returns the newest profile per
 *  author; pubkeys with no resolvable profile are absent from the map. Never
 *  rejects — a relay failure yields whatever was gathered (possibly empty).
 *  Relays given as bare strings are treated as read-only. */
export async function resolveProfiles(
  pubkeys: string[],
  relays: (string | ProfileRelay)[] = getProfileRelays(),
  fetchKind0: FetchKind0 = defaultFetch,
  publishKind0: PublishKind0 = defaultPublish,
): Promise<Map<string, Profile>> {
  const out = new Map<string, Profile>()
  const list = relays.map((r) => (typeof r === 'string' ? { url: r, write: false } : r))
  if (pubkeys.length === 0 || list.length === 0) return out

  let events: Kind0Event[]
  try {
    events = await fetchKind0(list.map((r) => r.url), pubkeys)
  } catch {
    return out
  }

  // Keep the newest kind-0 per author.
  const newest = new Map<string, Kind0Event>()
  for (const e of events) {
    const cur = newest.get(e.pubkey)
    if (!cur || e.created_at > cur.created_at) newest.set(e.pubkey, e)
  }

  // Seed the write relays without delaying name resolution.
  mirrorToWriteRelays(list, newest, publishKind0)

  for (const [pk, e] of newest) {
    const profile = parseKind0Content(e.content)
    if (profile) out.set(pk, profile)
  }
  return out
}
