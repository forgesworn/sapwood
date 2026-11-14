// Plain-English mapping for heartwood-esp32's storage/revocation reply text.
//
// heartwood-esp32 fix/nvs-atomic-blob-write (PR #197) added `storage_full:`,
// `storage_failed:` and `storage_unavailable:` prefixed NACK/error text so a
// host can tell a genuine storage problem from a generic refusal, and tell a
// revocation that has already taken effect from one that has not. Before
// this, Sapwood showed either the raw firmware string or a generic message
// ("Revoke rejected") that hid both facts.
//
// Two independent things can go wrong when a change to the pairing table is
// asked for:
//
//  - A *narrowing* change (revoking a pairing, a client key or an identity
//    grant, or narrowing a slot's permissions) is never rolled back: the
//    signer keeps the narrower table in RAM immediately, whatever happens to
//    the flash write. The reply says only what a restart would find.
//  - A *growth* change (a new pairing, a wider permission) IS rolled back on
//    a failed write, so the change never took effect at all.
//
// This module only recognises the exact reply shapes the firmware produces
// today (see each case below); anything else, including every reply from
// older firmware, returns null and the caller's existing fallback applies.

export type StorageOutcomeKind =
  | 'pin-not-tried'
  | 'revocation-delayed'
  | 'revocation-table-lost'
  | 'revocation-table-gone'
  | 'revocation-uncertain'
  | 'write-not-saved'

export interface StorageOutcome {
  readonly kind: StorageOutcomeKind
  /** True when the change (usually a revocation) is already in effect now,
   *  regardless of what a restart would find. False when the write was
   *  rolled back and nothing changed. */
  readonly applied: boolean
  /** True when the firmware itself advises restarting the device before any
   *  other change to this identity's pairings. */
  readonly restartAdvised: boolean
  /** Plain-English text ready to show the operator. Carries the firmware's
   *  own claims, reworded; never adds detail the firmware reply didn't. */
  readonly message: string
}

const RESTART_ADVICE = 'restart the device before making any other change'

function capitalise(s: string): string {
  return s.length ? s[0].toUpperCase() + s.slice(1) : s
}

/**
 * Classify a NACK/error reason string from a heartwood-esp32 signer running
 * fix/nvs-atomic-blob-write (PR #197) into a plain, structured outcome.
 * Returns null when `reason` does not match one of the known reply shapes,
 * which includes every reply from firmware predating that change.
 */
export function parseStorageOutcome(reason: string): StorageOutcome | null {
  const text = reason.trim()
  if (!text) return null

  // PIN_UNLOCK (0x26): the guess counter could not be charged before the PIN
  // was checked, so firmware refuses the guess untried rather than risk an
  // uncounted attempt. Nothing about the PIN itself was learned.
  if (text === 'storage_full: the PIN was not tried') {
    return {
      kind: 'pin-not-tried',
      applied: false,
      restartAdvised: false,
      message:
        'The signer is low on storage, so it could not record this PIN attempt. '
        + 'This is not a wrong PIN and does not count towards the wipe limit. '
        + 'Free up storage or restart the signer, then try again.',
    }
  }

  // Revocation family: persist_revocation().describe() in firmware/src/policy.rs.
  // The revoked/narrowed state is already active; only persistence differs.

  let m = text.match(/^storage_unavailable: (.+) holds until the next restart only; it could not be saved, try again$/)
  if (m) {
    const what = capitalise(m[1])
    return {
      kind: 'revocation-delayed',
      applied: true,
      restartAdvised: false,
      message: `${what} has been applied now, but it could not be saved: it holds until the next restart only. Try again to make it permanent.`,
    }
  }

  m = text.match(/^storage_full: (.+) is saved, but this identity's other pairings could not be rewritten and are lost at the next restart unless a later change saves them$/)
  if (m) {
    const what = capitalise(m[1])
    return {
      kind: 'revocation-table-lost',
      applied: true,
      restartAdvised: false,
      message: `${what} has been applied and saved, but this identity's other pairings could not be rewritten. They are lost at the next restart unless a later change saves the table.`,
    }
  }

  m = text.match(/^storage_full: (.+) is saved, but every pairing of this identity is gone after a restart; restart the device before making any other change, then re-pair or restore a backup$/)
  if (m) {
    const what = capitalise(m[1])
    return {
      kind: 'revocation-table-gone',
      applied: true,
      restartAdvised: true,
      message: `${what} has been applied and saved, but every pairing of this identity is gone after a restart. Restart the signer, then re-pair or restore a backup.`,
    }
  }

  m = text.match(/^storage_failed: (.+) holds until the next restart; the pairing table could not be written and after a restart it is either as it was or gone; restart the device before making any other change, then check and revoke again$/)
  if (m) {
    const what = capitalise(m[1])
    return {
      kind: 'revocation-uncertain',
      applied: true,
      restartAdvised: true,
      message: `${what} has been applied now, but the pairing table could not be written. After a restart it is either as it was or gone. Restart the signer, then check and revoke again.`,
    }
  }

  // Growth family: a new pairing or a wider permission change, rolled back on
  // a failed write (firmware/src/connslot.rs). Nothing took effect.
  m = text.match(/^storage_unavailable: (pairing|permissions) (?:was|were) not saved(?:; (.+))?$/)
  if (m) {
    const restartAdvised = m[2] === RESTART_ADVICE
    const noun = m[1] === 'pairing' ? 'the connection' : 'the permission change'
    return {
      kind: 'write-not-saved',
      applied: false,
      restartAdvised,
      message: `The signer is out of storage: ${noun} was not saved and nothing changed.`
        + (restartAdvised ? ` Restart the device before making any other change to this identity.` : ''),
    }
  }

  return null
}
