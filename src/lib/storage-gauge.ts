// Identity & app storage gauge maths.
//
// The signer's identities, app pairings, policy and network config share one
// NVS entry table; the firmware reports used/free/total entries (FIRMWARE_INFO
// over USB, get_status over the relay) and refuses persona writes before the
// pool is truly full, reserving headroom for policy writes. This module turns
// those numbers into one honest percentage with warn/full states, pure so the
// thresholds are unit-tested.

export interface StorageGauge {
  /** Whole-number percentage used, clamped 0..100. */
  pct: number
  state: 'ok' | 'warn' | 'full'
  /** One-line human reading, e.g. '62% used'. */
  label: string
}

/** Warn from 80% — plan a clean-up. */
export const STORAGE_WARN_PCT = 80

/** Full from 95% — the firmware's clean refusals are close; act now. */
export const STORAGE_FULL_PCT = 95

export function storageGauge(
  usedEntries: number | undefined,
  totalEntries: number | undefined,
): StorageGauge | null {
  if (
    typeof usedEntries !== 'number' || typeof totalEntries !== 'number'
    || !Number.isFinite(usedEntries) || !Number.isFinite(totalEntries)
    || usedEntries < 0 || totalEntries <= 0
  ) {
    return null
  }
  const pct = Math.min(100, Math.max(0, Math.round((usedEntries / totalEntries) * 100)))
  const state = pct >= STORAGE_FULL_PCT ? 'full' : pct >= STORAGE_WARN_PCT ? 'warn' : 'ok'
  return { pct, state, label: `${pct}% used` }
}
