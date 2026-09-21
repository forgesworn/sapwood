// Pure review logic for the additive KithMoot private-rooms permission upgrade.
//
// This module holds no reactive state, performs no I/O, and mutates nothing.
// It answers three questions for the UI: is the upgrade available, what are the
// complete final permission arrays, and has the slot changed since the review
// was opened. The arrays are never narrowed or filtered; unknown methods the
// slot already carries are preserved so an unrelated permission is not lost.

import type { ConnectSlot } from './types.js'
import type { ExactClientPolicy } from './types.js'

export const KITHMOOT_PRIVATE_KINDS: readonly number[] = [20460, 21236, 30078]
export const KITHMOOT_PRIVATE_METHODS: readonly string[] = [
  'get_public_key',
  'sign_event',
  'nip44_encrypt',
  'nip44_decrypt',
]

export type ConnectSlotMode = 'serial' | 'relay'

/**
 * A pinned view of a slot captured when the review opened. The same shape is
 * recaptured from a fresh read at confirm; any difference aborts the action.
 */
export interface KithmootPermissionReview {
  slot: ConnectSlot
  masterSlot: number
  connectionGeneration: number
  mode: ConnectSlotMode
}

function hasRetainedOrCurrentKey(slot: ConnectSlot): boolean {
  if (slot.current_pubkey) return true
  return Array.isArray(slot.authorized_pubkeys) && slot.authorized_pubkeys.length > 0
}

/**
 * Reason the additive KithMoot upgrade cannot be offered for this slot, or null
 * when it is available. Already enabled is reported as a blocked reason so the
 * caller can show the correct disabled copy.
 */
export function kithmootUpgradeBlockedReason(slot: ConnectSlot): string | null {
  if (slot.signing_approved !== true) return 'Signing approval needed first'
  if (!Array.isArray(slot.allowed_methods) || !slot.allowed_methods.includes('sign_event')) {
    return 'App must already allow sign_event'
  }
  if (!hasRetainedOrCurrentKey(slot)) return 'No authorised key available'
  if (kithmootAlreadyEnabled(slot)) return 'KithMoot rooms already enabled'
  return null
}

/**
 * True when every preset method is already present and the slot is either
 * unrestricted (empty allowed_kinds) or already contains every preset kind.
 */
export function kithmootAlreadyEnabled(slot: ConnectSlot): boolean {
  const methods = Array.isArray(slot.allowed_methods) ? slot.allowed_methods : []
  if (!KITHMOOT_PRIVATE_METHODS.every((m) => methods.includes(m))) return false
  const kinds = Array.isArray(slot.allowed_kinds) ? slot.allowed_kinds : []
  if (kinds.length === 0) return true
  return KITHMOOT_PRIVATE_KINDS.every((k) => kinds.includes(k))
}

/**
 * The complete final methods and kinds arrays the operator confirms. The
 * existing slot arrays are unioned with the preset methods/kinds, deduplicated
 * and (for kinds) sorted ascending. Unknown methods already on the slot are
 * preserved verbatim so an unrelated permission is not silently dropped.
 *
 * An empty `allowed_kinds` means unrestricted for sign_event: it stays empty
 * rather than being rewritten to the preset kinds.
 */
export function kithmootPermissionChanges(
  slot: ConnectSlot,
): Pick<ExactClientPolicy, 'allowed_methods' | 'allowed_kinds'> {
  if (!Array.isArray(slot.allowed_methods)) {
    throw new Error('Slot allowed_methods is missing or malformed; refusing to widen permissions.')
  }
  for (const m of slot.allowed_methods) {
    if (typeof m !== 'string') {
      throw new Error('Slot allowed_methods contains a non-string entry; refusing to widen permissions.')
    }
  }
  if (!Array.isArray(slot.allowed_kinds)) {
    throw new Error('Slot allowed_kinds is missing or malformed; refusing to widen permissions.')
  }
  for (const k of slot.allowed_kinds) {
    if (typeof k !== 'number' || !Number.isInteger(k) || k < 0) {
      throw new Error('Slot allowed_kinds contains a non-integer/negative entry; refusing to widen permissions.')
    }
  }

  const existingMethods = slot.allowed_methods
  const finalMethods = [...new Set([...existingMethods, ...KITHMOOT_PRIVATE_METHODS])]

  const existingKinds = slot.allowed_kinds
  const finalKinds =
    existingKinds.length === 0
      ? []
      : [...new Set([...existingKinds, ...KITHMOOT_PRIVATE_KINDS])].sort((a, b) => a - b)

  return { allowed_methods: finalMethods, allowed_kinds: finalKinds }
}

function normalisedSet(values: readonly string[] | readonly number[]): string {
  return [...new Set(values.map((v) => String(v)))].sort().join('\u0000')
}

/**
 * Compare two slot snapshots that must agree before a permission write. Returns
 * true only when the fingerprint, authorised key set (current + retained),
 * methods, kinds, auto-approve, signing approval, strict-permission flag, label
 * and persona/approved-identity tags all match. Array order is not significant;
 * the authorised key set is compared as a set, not the display order.
 */
export function permissionSlotUnchanged(
  expected: ConnectSlot,
  actual: ConnectSlot,
): boolean {
  if (expected.slot_index !== actual.slot_index) return false
  if ((expected.secret_fingerprint ?? '') !== (actual.secret_fingerprint ?? '')) return false

  // Raw USB/backup wire ids must match only when either side carries them.
  // The relay path summarises approvals into `approved_identities` and leaves
  // `ids` absent, so an absent-vs-absent comparison is the only safe rule.
  const expectedIds = expected.ids ?? ''
  const actualIds = actual.ids ?? ''
  if (expectedIds !== actualIds) return false

  const expectedKeys = new Set<string>()
  if (expected.current_pubkey) expectedKeys.add(expected.current_pubkey)
  for (const k of expected.authorized_pubkeys ?? []) expectedKeys.add(k)
  const actualKeys = new Set<string>()
  if (actual.current_pubkey) actualKeys.add(actual.current_pubkey)
  for (const k of actual.authorized_pubkeys ?? []) actualKeys.add(k)
  if (expectedKeys.size !== actualKeys.size) return false
  for (const k of expectedKeys) if (!actualKeys.has(k)) return false

  if (normalisedSet(expected.allowed_methods ?? []) !== normalisedSet(actual.allowed_methods ?? [])) {
    return false
  }
  if (normalisedSet(expected.allowed_kinds ?? []) !== normalisedSet(actual.allowed_kinds ?? [])) {
    return false
  }

  if (Boolean(expected.auto_approve) !== Boolean(actual.auto_approve)) return false
  if (Boolean(expected.signing_approved) !== Boolean(actual.signing_approved)) return false
  if (Boolean(expected.strict_permissions) !== Boolean(actual.strict_permissions)) return false

  if (Boolean(expected.wb) !== Boolean(actual.wb)) return false
  if ((expected.label ?? '') !== (actual.label ?? '')) return false

  if (normalisedSet(expected.approved_identities ?? []) !== normalisedSet(actual.approved_identities ?? [])) {
    return false
  }

  if ((expected.bound_identity ?? null) !== (actual.bound_identity ?? null)) return false
  if (Boolean(expected.escalate) !== Boolean(actual.escalate)) return false
  if (Boolean(expected.petition_on_deny) !== Boolean(actual.petition_on_deny)) return false
  if (Boolean(expected.audit_child_wrap) !== Boolean(actual.audit_child_wrap)) return false
  if (Boolean(expected.guardian_notice_wrap) !== Boolean(actual.guardian_notice_wrap)) return false

  return true
}
