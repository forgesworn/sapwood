/** Read-only recovery; vault signing and publishing are never exposed here. */
import { createVaultRelayReader, readVaultHeadRotations, vaultKeyContext } from 'signet-protocol/experimental'
import { openVaultPayload } from '@forgesworn/signet-contacts/wire'
import { parseDependantsManifest } from './recovery.js'
import type { DependantsManifest } from './recovery.js'

export type VaultReadRequest = (method: 'get_public_key' | 'nip44_decrypt', params: string[],
  context: { purpose: string; index: number }) => Promise<string>

/** Null means a completed relay query proved no profiles vault at index zero.
 * All other failures stop recovery instead of silently selecting stale legacy data.
 */
export async function recoverVaultFamilyRoster(relays: string[], request: VaultReadRequest): Promise<DependantsManifest | null> {
  const result = await readVaultHeadRotations(async rotation => {
    const context = vaultKeyContext('profiles', rotation)
    const author = await request('get_public_key', [], context)
    if (!/^[0-9a-f]{64}$/.test(author)) throw new Error('Invalid profiles vault public key')
    return { author, reader: createVaultRelayReader(relays, (content, peer) => openVaultPayload(content, {
      nip44Decrypt: (sender, ciphertext) => request('nip44_decrypt', [sender, ciphertext], context),
    }, peer)) }
  }, vaultKeyContext('profiles').purpose)
  if (result.state === 'absent') return null
  if (result.state === 'unavailable') throw new Error('Could not read the private backup. Check the signer connection and backup relays, then retry.')
  if (result.state !== 'ready') throw new Error('The private backup is incomplete or could not be verified. Recovery has stopped to protect newer family data.')
  const dependants = new Map<string, Record<string, unknown>>()
  for (const snapshot of result.snapshots) {
    let profiles: unknown
    try { profiles = JSON.parse(snapshot.plaintext) } catch { throw new Error('The private profiles backup is not valid JSON.') }
    if (!profiles || typeof profiles !== 'object' || Array.isArray(profiles)
      || (profiles as { v?: unknown }).v !== 1 || !('dependants' in profiles)) {
      throw new Error('This private profiles format is not supported. Update Sapwood before recovering.')
    }
    const section = (profiles as { dependants: { dependants?: Record<string, unknown>[] } }).dependants
    const parsed = parseDependantsManifest(JSON.stringify(section))
    if (!Array.isArray(section.dependants) || parsed.dependants.length !== section.dependants.length) throw new Error('Private family data is incomplete.')
    for (const raw of section.dependants) {
      const id = raw.id as string
      const old = dependants.get(id)
      const extras = new Map<string, unknown>()
      for (const source of [old, raw]) {
        if (Array.isArray(source?.extras)) for (const extra of source.extras) {
          if (extra && typeof extra.derivationName === 'string') extras.set(extra.derivationName, extra)
        }
      }
      const tombstones = [...(Array.isArray(old?.extraPersonaTombstones) ? old.extraPersonaTombstones : []),
        ...(Array.isArray(raw.extraPersonaTombstones) ? raw.extraPersonaTombstones : [])]
      for (const tombstone of tombstones) if (tombstone && typeof tombstone.derivationName === 'string') extras.delete(tombstone.derivationName)
      dependants.set(id, { ...old, ...raw, extras: [...extras.values()], extraPersonaTombstones: tombstones })
    }
  }
  return parseDependantsManifest(JSON.stringify({ v: 1, dependants: [...dependants.values()] }))
}
