import { beforeEach, describe, expect, it } from 'vitest'
import {
  markPairingBackupExported,
  markPairingBackupStale,
  pairingBackupStatus,
} from './pairing-backup.js'

const SCOPE = 'npub1test-signer'

describe('pairing backup freshness marker', () => {
  beforeEach(() => localStorage.clear())

  it('starts quiet until this browser observes a successful slot mutation', () => {
    expect(pairingBackupStatus(SCOPE)).toEqual({
      needsBackup: false,
      lastExportAt: null,
      lastMutationAt: null,
    })
  })

  it('stays stale after a slot mutation until an encrypted export is recorded', () => {
    markPairingBackupStale(SCOPE)
    const stale = pairingBackupStatus(SCOPE)
    expect(stale.needsBackup).toBe(true)
    expect(stale.lastExportAt).toBeNull()
    expect(stale.lastMutationAt).toEqual(expect.any(Number))

    markPairingBackupExported(SCOPE)
    const fresh = pairingBackupStatus(SCOPE)
    expect(fresh.needsBackup).toBe(false)
    expect(fresh.lastExportAt).toEqual(expect.any(Number))
    expect(fresh.lastMutationAt).toBeNull()
  })

  it('makes a later mutation stale again without discarding the prior export time', () => {
    markPairingBackupExported(SCOPE)
    const exportedAt = pairingBackupStatus(SCOPE).lastExportAt
    markPairingBackupStale(SCOPE)

    expect(pairingBackupStatus(SCOPE)).toEqual(expect.objectContaining({
      needsBackup: true,
      lastExportAt: exportedAt,
      lastMutationAt: expect.any(Number),
    }))
  })
})
