import { beforeEach, describe, expect, it } from 'vitest'
import {
  markPairingBackupExported,
  markPairingBackupStale,
  pairingBackupStatus,
  pairingBackupRelativeTime,
} from './pairing-backup.js'

const SCOPE = 'npub1test-signer'
const SCOPE_B = 'npub1other-signer'

describe('pairing backup freshness marker', () => {
  beforeEach(() => localStorage.clear())

  it('starts quiet until this browser observes a successful slot mutation', () => {
    expect(pairingBackupStatus(SCOPE)).toEqual({
      needsBackup: false,
      lastExportAt: null,
      lastMutationAt: null,
      lastExportSlotCount: null,
    })
  })

  it('a device that has never exported reads as never, not stale', () => {
    const never = pairingBackupStatus(SCOPE)
    expect(never.needsBackup).toBe(false)
    expect(never.lastExportAt).toBeNull()
    expect(never.lastExportSlotCount).toBeNull()
  })

  it('stays stale after a slot mutation until an encrypted export is recorded', () => {
    markPairingBackupStale(SCOPE)
    const stale = pairingBackupStatus(SCOPE)
    expect(stale.needsBackup).toBe(true)
    expect(stale.lastExportAt).toBeNull()
    expect(stale.lastMutationAt).toEqual(expect.any(Number))

    markPairingBackupExported(SCOPE, 3)
    const fresh = pairingBackupStatus(SCOPE)
    expect(fresh.needsBackup).toBe(false)
    expect(fresh.lastExportAt).toEqual(expect.any(Number))
    expect(fresh.lastMutationAt).toBeNull()
    expect(fresh.lastExportSlotCount).toBe(3)
  })

  it('makes a later mutation stale again without discarding the prior export time', () => {
    markPairingBackupExported(SCOPE, 2)
    const exportedAt = pairingBackupStatus(SCOPE).lastExportAt
    markPairingBackupStale(SCOPE)

    expect(pairingBackupStatus(SCOPE)).toEqual(expect.objectContaining({
      needsBackup: true,
      lastExportAt: exportedAt,
      lastMutationAt: expect.any(Number),
      lastExportSlotCount: 2,
    }))
  })

  it('round-trips the slot count and ignores a malformed one', () => {
    markPairingBackupExported(SCOPE, 5)
    expect(pairingBackupStatus(SCOPE).lastExportSlotCount).toBe(5)

    markPairingBackupExported(SCOPE, -1)
    expect(pairingBackupStatus(SCOPE).lastExportSlotCount).toBeNull()

    markPairingBackupExported(SCOPE, Number.NaN)
    expect(pairingBackupStatus(SCOPE).lastExportSlotCount).toBeNull()

    markPairingBackupExported(SCOPE)
    expect(pairingBackupStatus(SCOPE).lastExportSlotCount).toBeNull()
  })

  it('tracks two devices side by side without one clobbering the other', () => {
    markPairingBackupExported(SCOPE, 4)
    markPairingBackupStale(SCOPE_B)

    expect(pairingBackupStatus(SCOPE)).toEqual(expect.objectContaining({
      needsBackup: false, lastExportSlotCount: 4,
    }))
    expect(pairingBackupStatus(SCOPE_B)).toEqual(expect.objectContaining({
      needsBackup: true, lastExportSlotCount: null,
    }))

    markPairingBackupExported(SCOPE_B, 1)
    expect(pairingBackupStatus(SCOPE)).toEqual(expect.objectContaining({
      needsBackup: false, lastExportSlotCount: 4,
    }))
    expect(pairingBackupStatus(SCOPE_B)).toEqual(expect.objectContaining({
      needsBackup: false, lastExportSlotCount: 1,
    }))
  })
})

describe('pairingBackupRelativeTime', () => {
  it('reads coarse relative age, matching the app\'s other "ago" readouts', () => {
    const now = Date.now()
    expect(pairingBackupRelativeTime(now - 10_000)).toBe('just now')
    expect(pairingBackupRelativeTime(now - 5 * 60_000)).toBe('5m ago')
    expect(pairingBackupRelativeTime(now - 3 * 3_600_000)).toBe('3h ago')
    expect(pairingBackupRelativeTime(now - 2 * 86_400_000)).toBe('2d ago')
  })
})
