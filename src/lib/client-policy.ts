import type { ConnectSlot, ExactClientPolicy } from './types.js'

export const CONNECT_METHODS = [
  'get_public_key',
  'nip44_encrypt',
  'nip44_decrypt',
  'nip04_encrypt',
  'nip04_decrypt',
] as const

export const SIGNING_METHODS = ['sign_event', ...CONNECT_METHODS] as const

const SUPPORTED = new Set<string>(SIGNING_METHODS)

/** Build a canonical full-policy payload. `sign_event` is the only method for
 * which an empty kind list means "all"; without it the list is always cleared. */
export function exactClientPolicy(
  allowedMethods: readonly string[],
  allowedKinds: readonly number[] = [],
  autoApprove = true,
): ExactClientPolicy {
  const methods = [...new Set(['get_public_key', ...allowedMethods])]
    .filter((method) => SUPPORTED.has(method))
  const canSign = methods.includes('sign_event')
  const kinds = canSign
    ? [...new Set(allowedKinds)]
      .filter((kind) => Number.isSafeInteger(kind) && kind >= 0)
      .sort((a, b) => a - b)
    : []
  return {
    allowed_methods: methods,
    allowed_kinds: kinds,
    auto_approve: autoApprove,
  }
}

/** Broad legacy-equivalent policy used only when the operator explicitly asks
 * an advanced connection to sign anything. */
export function fullClientPolicy(allowSigning = true): ExactClientPolicy {
  return exactClientPolicy(allowSigning ? SIGNING_METHODS : CONNECT_METHODS)
}

/** Methods Sapwood's own manager pairing needs for persona management over
 * the USB NIP-46 path. Deliberately NOT added to SUPPORTED: they must never
 * appear in the app-facing permissions UI, and `exactClientPolicy` must keep
 * filtering them out of ordinary app slots. */
export const MANAGER_METHODS = [
  'get_public_key',
  'heartwood_derive_persona',
  'heartwood_remove_persona',
  'heartwood_rename_persona',
] as const

/** Policy ceiling for the Sapwood manager slot. Auto-approve is deliberate:
 * creating the slot needs an authenticated bridge session, and installing
 * this ceiling is button-confirmed on the device, so the pairing ceremony
 * itself is the physical consent. No signing, no encrypt/decrypt. */
export function managerClientPolicy(): ExactClientPolicy {
  return {
    allowed_methods: [...MANAGER_METHODS],
    allowed_kinds: [],
    auto_approve: true,
  }
}

/** Preserve an existing slot while converting a replacement link to the exact
 * v2 policy model. Never infer signing from kinds alone. */
export function exactPolicyFromSlot(slot: ConnectSlot): ExactClientPolicy {
  const methods = (slot.allowed_methods ?? []).filter((method) =>
    method !== 'sign_event' || slot.signing_approved,
  )
  return exactClientPolicy(methods, slot.allowed_kinds, slot.auto_approve)
}

export function policiesEqual(
  expected: ExactClientPolicy,
  actual: { allowed_methods?: unknown; allowed_kinds?: unknown; auto_approve?: unknown },
): boolean {
  if (!Array.isArray(actual.allowed_methods) || !actual.allowed_methods.every((value) => typeof value === 'string')) return false
  if (!Array.isArray(actual.allowed_kinds) || !actual.allowed_kinds.every((value) => typeof value === 'number')) return false
  const expectedMethods = [...new Set(expected.allowed_methods)].sort()
  const actualMethods = [...new Set(actual.allowed_methods as string[])].sort()
  const expectedKinds = [...new Set(expected.allowed_kinds)].sort((a, b) => a - b)
  const actualKinds = [...new Set(actual.allowed_kinds as number[])].sort((a, b) => a - b)
  return actual.auto_approve === expected.auto_approve
    && expectedMethods.length === actualMethods.length
    && expectedMethods.every((method, index) => method === actualMethods[index])
    && expectedKinds.length === actualKinds.length
    && expectedKinds.every((kind, index) => kind === actualKinds[index])
}
