// Mapping from heartwood-esp32's storage/revocation reply text (introduced in
// fix/nvs-atomic-blob-write, PR #197) to plain, structured outcomes Sapwood
// can show instead of a generic error. See parseStorageOutcome's doc comment
// for the exact firmware strings this matches.

import { describe, expect, it } from 'vitest'
import { parseStorageOutcome } from './storage-outcomes.js'

describe('parseStorageOutcome', () => {
  it('returns null for text with no recognised storage prefix (older firmware, unrelated errors)', () => {
    expect(parseStorageOutcome('')).toBeNull()
    expect(parseStorageOutcome('slots full')).toBeNull()
    expect(parseStorageOutcome('pairing not found')).toBeNull()
    expect(parseStorageOutcome('unauthenticated bridge session')).toBeNull()
    expect(parseStorageOutcome('Storage error')).toBeNull()
  })

  it('maps the PIN_UNLOCK storage-full NACK: never a wrong PIN, never counted', () => {
    const outcome = parseStorageOutcome('storage_full: the PIN was not tried')
    expect(outcome).not.toBeNull()
    expect(outcome!.kind).toBe('pin-not-tried')
    expect(outcome!.applied).toBe(false)
    expect(outcome!.restartAdvised).toBe(false)
    expect(outcome!.message).toMatch(/not.*wrong PIN/i)
    expect(outcome!.message).toMatch(/does not count/i)
    expect(outcome!.message).not.toMatch(/storage_full:/)
  })

  it('maps a revocation that holds only until the next restart', () => {
    const outcome = parseStorageOutcome(
      'storage_unavailable: pairing revocation holds until the next restart only; it could not be saved, try again',
    )
    expect(outcome).not.toBeNull()
    expect(outcome!.kind).toBe('revocation-delayed')
    expect(outcome!.applied).toBe(true)
    expect(outcome!.restartAdvised).toBe(false)
    expect(outcome!.message).toMatch(/Pairing revocation/)
    expect(outcome!.message).toMatch(/applied now/i)
    expect(outcome!.message).toMatch(/could not be saved/i)
    expect(outcome!.message).not.toMatch(/^storage_/)
  })

  it('maps a revocation whose sibling pairings are lost at the next restart (table lost)', () => {
    const outcome = parseStorageOutcome(
      "storage_full: permission change is saved, but this identity's other pairings could not be rewritten and are lost at the next restart unless a later change saves them",
    )
    expect(outcome).not.toBeNull()
    expect(outcome!.kind).toBe('revocation-table-lost')
    expect(outcome!.applied).toBe(true)
    expect(outcome!.restartAdvised).toBe(false)
    expect(outcome!.message).toMatch(/Permission change/)
    expect(outcome!.message).toMatch(/applied/i)
    expect(outcome!.message).toMatch(/other pairings/i)
  })

  it('maps a revocation where every pairing of the identity is gone after a restart (table gone)', () => {
    const outcome = parseStorageOutcome(
      'storage_full: client revocation is saved, but every pairing of this identity is gone after a restart; restart the device before making any other change, then re-pair or restore a backup',
    )
    expect(outcome).not.toBeNull()
    expect(outcome!.kind).toBe('revocation-table-gone')
    expect(outcome!.applied).toBe(true)
    expect(outcome!.restartAdvised).toBe(true)
    expect(outcome!.message).toMatch(/Client revocation/)
    expect(outcome!.message).toMatch(/every pairing.*gone after a restart/i)
    expect(outcome!.message).toMatch(/re-pair or restore a backup/i)
  })

  it('maps an uncertain part-written table', () => {
    const outcome = parseStorageOutcome(
      'storage_failed: identity approval revocation holds until the next restart; the pairing table could not be written and after a restart it is either as it was or gone; restart the device before making any other change, then check and revoke again',
    )
    expect(outcome).not.toBeNull()
    expect(outcome!.kind).toBe('revocation-uncertain')
    expect(outcome!.applied).toBe(true)
    expect(outcome!.restartAdvised).toBe(true)
    expect(outcome!.message).toMatch(/Identity approval revocation/)
    expect(outcome!.message).toMatch(/either as it was or gone/i)
    expect(outcome!.message).toMatch(/check and revoke again/i)
  })

  it('maps a growth write that was rolled back (pairing not saved)', () => {
    const outcome = parseStorageOutcome('storage_unavailable: pairing was not saved')
    expect(outcome).not.toBeNull()
    expect(outcome!.kind).toBe('write-not-saved')
    expect(outcome!.applied).toBe(false)
    expect(outcome!.restartAdvised).toBe(false)
    expect(outcome!.message).toMatch(/out of storage/i)
    expect(outcome!.message).toMatch(/nothing changed/i)
  })

  it('maps a growth write that was rolled back with a trailing restart advisory', () => {
    const outcome = parseStorageOutcome(
      'storage_unavailable: permissions were not saved; restart the device before making any other change',
    )
    expect(outcome).not.toBeNull()
    expect(outcome!.kind).toBe('write-not-saved')
    expect(outcome!.applied).toBe(false)
    expect(outcome!.restartAdvised).toBe(true)
    expect(outcome!.message).toMatch(/restart the device/i)
  })

  it('never treats a plain "storage_unavailable" write-not-saved reply as a revocation', () => {
    const outcome = parseStorageOutcome('storage_unavailable: pairing was not saved')
    expect(outcome!.kind).not.toMatch(/^revocation/)
  })
})
