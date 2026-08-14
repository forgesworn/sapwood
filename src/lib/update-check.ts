// Lightweight "is newer firmware bundled?" check for surfacing an update
// prompt outside the Firmware section. The full update UI (OtaUpdate.svelte)
// stays the authority on how to install; this only answers whether to nudge.
import { isUpgrade } from './version'

export interface UpdateCheck {
  latest: string
  running: string | null
  /** True only when the running version is known and strictly older. */
  upgrade: boolean
}

export async function checkForUpdate(running: string | null): Promise<UpdateCheck | null> {
  try {
    const res = await fetch('/firmware/version.json', { cache: 'no-store' })
    if (!res.ok) return null
    const manifest: unknown = await res.json()
    const latest = (manifest as { version?: unknown })?.version
    if (typeof latest !== 'string' || !latest) return null
    return { latest, running, upgrade: !!running && isUpgrade(running, latest) }
  } catch {
    return null
  }
}
