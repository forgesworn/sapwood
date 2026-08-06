import type { MasterInfo } from './types.js'

/**
 * A stable, unique `{#each}` key for an identity row.
 *
 * Neither field of a MasterInfo is unique on its own. A derived persona carries
 * its OWNING master's slot, so slot repeats across the list; and the same secret
 * provisioned into two slots (say an nsec added twice under different labels)
 * repeats the npub. A keyed each with a repeated key throws `each_key_duplicate`,
 * which unmounts the whole surrounding component: the Identity panel went blank
 * for any signer holding a master plus a derived identity.
 *
 * The triple (kind, slot, npub) is unique for every list the signer can report.
 */
export function identityKey(m: Pick<MasterInfo, 'slot' | 'npub' | 'persona'>): string {
  return `${m.persona ? 'p' : 'm'}:${m.slot}:${m.npub}`
}

/**
 * Drop rows that would collide anyway (a signer reporting the same identity
 * twice), so no identity list can blank a panel. Order is preserved.
 */
export function dedupeIdentities<T extends Pick<MasterInfo, 'slot' | 'npub' | 'persona'>>(
  rows: T[],
): T[] {
  const seen = new Set<string>()
  return rows.filter((row) => {
    const key = identityKey(row)
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}
