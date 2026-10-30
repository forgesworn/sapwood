// Permission presets for the "connect an app" flow (admin Home).
//
// A client slot's `allowed_kinds` controls which event kinds the device will
// auto-sign; an empty list means "everything" (unrestricted). These presets
// turn that low-level model into a few plain choices a newcomer can reason
// about — "what is this app allowed to do?" — without learning kind numbers.
//
// Pure data + mapping functions so the logic is exhaustively unit-testable with
// no UI. Tone: plain, no jargon, no exclamation marks (house voice).

import { CONNECT_METHODS, SIGNING_METHODS, exactClientPolicy } from './client-policy.js'
import type { ExactClientPolicy } from './types.js'

export type PresetId =
  | 'posting' | 'everything' | 'messaging'
  | 'sign-in' | 'v4v-listener' | 'v4v-artist' | 'kithmoot-private'
  | 'custom'

/** What a V4V listener asks their signer for: sign-in, tips, live chat,
 *  playlists and their deletion, the library set, listening status and the
 *  encrypted entitlement list (30078). Unlocking paid releases and reading
 *  that list need NIP-44 through the signer as well. */
export const V4V_LISTENER_KINDS: readonly number[] = [1, 5, 1311, 9734, 21236, 27201, 30003, 30078, 30315]

/** The artist's additions: deposit and ungate authorisations set a release's
 *  money terms, the gated release itself, and the sales authorisation that
 *  reads and settles what was sold. */
export const V4V_ARTIST_KINDS: readonly number[] = [27117, 27118, 27202, 30808]

export interface PermissionPreset {
  id: PresetId
  label: string
  /** One-line plain-language description shown under the label. */
  description: string
  /**
   * Kinds to auto-sign, or null for unrestricted (everything). For 'custom'
   * this is null and the UI lets the operator pick the kinds by hand.
   */
  kinds: number[] | null
  /** Exact NIP-46 methods this preset may run automatically. */
  methods: readonly string[]
}

export const PERMISSION_PRESETS: readonly PermissionPreset[] = [
  {
    id: 'posting',
    label: 'Posting only',
    description: 'Notes, reactions, reposts, articles and app settings. Keeps an app away from your profile and contacts.',
    kinds: [1, 5, 6, 7, 30023, 30078],
    methods: ['get_public_key', 'sign_event'],
  },
  {
    id: 'everything',
    label: 'Everything',
    description: 'Sign anything this app asks for. Use only for a personal app you trust with profile, contacts and relay-list changes.',
    kinds: null,
    methods: SIGNING_METHODS,
  },
  {
    id: 'messaging',
    label: 'Messages only',
    description: 'Direct messages and room device credentials; encrypted account settings need the KithMoot profile. Good for a chat app.',
    // Legacy NIP-04 plus signed NIP-17 seals/gift wraps. Kinds 14/15 are
    // deliberately absent: NIP-17 message rumors are unsigned.
    kinds: [4, 13, 1059, 20460],
    methods: [...CONNECT_METHODS, 'sign_event'],
  },
  {
    id: 'sign-in',
    label: 'Sign in only',
    description:
      'Prove who you are to a site that signs in with Signet, such as V4V or KithMoot. Nothing else is signed without a press on the device.',
    kinds: [21236],
    methods: ['get_public_key', 'sign_event'],
  },
  {
    id: 'v4v-listener',
    label: 'V4V listener',
    description:
      'Sign in to V4V, tip, chat on a live stage, keep your library, playlists and listening status, and unlock what you have paid for. Account-wide: these kinds are not restricted to V4V.',
    kinds: [...V4V_LISTENER_KINDS],
    methods: ['get_public_key', 'sign_event', 'nip44_encrypt', 'nip44_decrypt'],
  },
  {
    id: 'v4v-artist',
    label: 'V4V artist',
    description:
      'Everything a listener signs, plus publishing gated releases, setting their price and deposit terms, and reading and settling your sales. Sets money terms, so pair only a device you control.',
    kinds: [...V4V_LISTENER_KINDS, ...V4V_ARTIST_KINDS].sort((a, b) => a - b),
    methods: ['get_public_key', 'sign_event', 'nip44_encrypt', 'nip44_decrypt'],
  },
  {
    id: 'kithmoot-private',
    label: 'KithMoot private rooms',
    description:
      'Sign in, authorise devices and sync encrypted room bookmarks and read state. Grants account-wide sign-in proofs, device credentials and app settings; not restricted to KithMoot tags.',
    kinds: [20460, 21236, 30078],
    methods: ['get_public_key', 'sign_event', 'nip44_encrypt', 'nip44_decrypt'],
  },
  {
    id: 'custom',
    label: 'Let me choose',
    description: 'Pick exactly which kinds of event this app may sign.',
    kinds: null,
    methods: ['get_public_key', 'sign_event'],
  },
] as const

export function presetById(id: PresetId): PermissionPreset {
  return PERMISSION_PRESETS.find((p) => p.id === id) ?? PERMISSION_PRESETS[0]!
}

/**
 * Resolve the `allowed_kinds` to apply for a preset selection. `customKinds` is
 * used only for the 'custom' preset. Returns null for unrestricted (everything),
 * matching the device's "empty list = all kinds auto-sign" convention. UI
 * callers must reject an empty custom selection before calling this; otherwise
 * an empty hand-picked list is indistinguishable from "Everything" on device.
 */
export function resolveKinds(id: PresetId, customKinds: number[] = []): number[] | null {
  if (id === 'everything') return null
  if (id === 'custom') {
    const cleaned = [...new Set(customKinds)].filter((k) => Number.isInteger(k) && k >= 0)
    return cleaned.length ? cleaned.sort((a, b) => a - b) : null
  }
  return presetById(id).kinds
}

/** True when a preset restricts signing (i.e. needs an allowed_kinds update). */
export function isRestricted(id: PresetId, customKinds: number[] = []): boolean {
  return resolveKinds(id, customKinds) !== null
}

/** Resolve a preset to the complete v2 policy installed atomically on device. */
export function resolvePolicy(id: PresetId, customKinds: number[] = []): ExactClientPolicy {
  const preset = presetById(id)
  return exactClientPolicy(preset.methods, resolveKinds(id, customKinds) ?? [])
}
