// A local freshness marker for the encrypted pairing backup. It deliberately
// stores no pairing data, passphrase or device secret: the backup itself still
// comes only from the signer's button-confirmed BACKUP_EXPORT operation.

export const PAIRING_BACKUP_EVENT = 'sapwood:pairing-backup-status'

const KEY_PREFIX = 'sapwood.pairing-backup.v1:'

export interface PairingBackupStatus {
  /** A successful slot mutation happened after the last confirmed export. */
  needsBackup: boolean
  /** Milliseconds since epoch, or null when this browser has never confirmed an export. */
  lastExportAt: number | null
  /** Milliseconds since epoch, or null when no local mutation is known. */
  lastMutationAt: number | null
}

interface StoredStatus extends PairingBackupStatus {
  version: 1
}

function storage(): Storage | null {
  try { return typeof localStorage === 'undefined' ? null : localStorage } catch { return null }
}

function key(scope: string): string | null {
  const clean = scope.trim()
  return clean ? `${KEY_PREFIX}${clean}` : null
}

function validTime(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null
}

function empty(): PairingBackupStatus {
  return { needsBackup: false, lastExportAt: null, lastMutationAt: null }
}

function announce(): void {
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(PAIRING_BACKUP_EVENT))
}

/** Read this browser's non-secret freshness marker for a connected signer. */
export function pairingBackupStatus(scope: string): PairingBackupStatus {
  const store = storage()
  const storageKey = key(scope)
  if (!store || !storageKey) return empty()
  try {
    const raw = JSON.parse(store.getItem(storageKey) ?? '') as Partial<StoredStatus>
    if (raw.version !== 1 || typeof raw.needsBackup !== 'boolean') return empty()
    return {
      needsBackup: raw.needsBackup,
      lastExportAt: validTime(raw.lastExportAt),
      lastMutationAt: validTime(raw.lastMutationAt),
    }
  } catch {
    return empty()
  }
}

function save(scope: string, status: PairingBackupStatus): void {
  const store = storage()
  const storageKey = key(scope)
  if (!store || !storageKey) return
  try {
    store.setItem(storageKey, JSON.stringify({ version: 1, ...status } satisfies StoredStatus))
    announce()
  } catch { /* Private-mode/storage failures must not block signer management. */ }
}

/** Mark a successful slot mutation as newer than the last encrypted export. */
export function markPairingBackupStale(scope: string): void {
  const previous = pairingBackupStatus(scope)
  save(scope, { ...previous, needsBackup: true, lastMutationAt: Date.now() })
}

/** Record that this browser completed an encrypted, button-confirmed export. */
export function markPairingBackupExported(scope: string): void {
  const now = Date.now()
  save(scope, { needsBackup: false, lastExportAt: now, lastMutationAt: null })
}
