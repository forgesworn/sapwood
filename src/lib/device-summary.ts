// Device tab summary logic: the section-row status words (always shown, one
// per section) and the Needs-attention cards (0 to n, shown only for the
// handful of concerns that need a decision). Pure so the wording and ordering
// are unit-tested without a rendered component.

import type { UnlockMode } from './phone-unlock.js'

/** "unknown" is a neutral, muted state: not good, not bad, just not knowable
 *  from here (e.g. a WiFi signer that hasn't proved its backup or unlock
 *  state). It must never read as green. */
export type SummaryDot = 'ok' | 'unknown' | 'attention' | 'problem'

export type SummaryRowId = 'firmware' | 'power-cut' | 'backup'

/** A section row's status word, shown beside its title whether the section
 *  is open or not. */
export interface SummaryRow {
  id: SummaryRowId
  /** The fixed, bold concern label shown before the state text, e.g. "Firmware". */
  label: string
  dot: SummaryDot
  text: string
}

export type AttentionRowId = 'not-encrypted' | 'firmware' | 'backup' | 'storage' | 'health' | 'status-lost'

/** A Needs-attention card: only ever `problem` or `attention`. */
export interface AttentionRow {
  id: AttentionRowId
  dot: SummaryDot
  label: string
  text: string
  /** Label for the card's one button, or null when there is nothing to press. */
  actionLabel: string | null
}

export interface DeviceSummaryInput {
  /** A newer firmware build than the one running. */
  updateAvailable: boolean
  updateVersion: string | null
  runningVersion: string | null
  /** The after-a-power-cut mode: read from the firmware's own `at_rest`
   *  report when it sends one, otherwise inferred from side effects; null
   *  when it cannot be told either way. */
  unlockMode: UnlockMode | null
  phoneCount: number | null
  /** The firmware sent an `at_rest` value this build does not recognise, so
   *  `unlockMode` is null for that reason rather than for lack of any report
   *  at all. Distinguishes "update Sapwood" from "connect by USB to check". */
  atRestUnrecognised: boolean
  overUsb: boolean
  /** The signer is locked over USB (VaultUnlock owns the unlock itself; this
   *  only changes the After-a-power-cut row's status). */
  locked: boolean
  needsBackup: boolean
  lastExportAt: number | null
  /** The signer's last restart was a crash. */
  crash: boolean
  /** The signer's heap is fragmented. */
  fragmented: boolean
  /** The signer restarted itself to recover from a wedged relay service. */
  recovering: boolean
  storageState: 'ok' | 'warn' | 'full' | null
  storagePct: number | null
  /** A relay signer stopped answering status polls: what is on screen may be
   *  stale. Never true over USB or bridge, where a dropped connection is
   *  obvious immediately. */
  statusLost: boolean
}

function severityRank(dot: SummaryDot): number {
  return dot === 'problem' ? 0 : dot === 'attention' ? 1 : dot === 'unknown' ? 2 : 3
}

function formatDate(at: number): string {
  return new Date(at).toLocaleDateString(undefined, { dateStyle: 'medium' })
}

function firmwareRow(input: DeviceSummaryInput): SummaryRow {
  if (input.updateAvailable && input.updateVersion) {
    return { id: 'firmware', label: 'Firmware', dot: 'attention', text: `Update available: v${input.updateVersion}` }
  }
  if (input.runningVersion) {
    return { id: 'firmware', label: 'Firmware', dot: 'ok', text: `Up to date (v${input.runningVersion})` }
  }
  // Unknown must never read green (F7): nothing here has been confirmed up to date.
  return { id: 'firmware', label: 'Firmware', dot: 'unknown', text: 'Version unknown' }
}

function powerCutRow(input: DeviceSummaryInput): SummaryRow {
  const label = 'After a power cut'
  if (input.locked) {
    return { id: 'power-cut', label, dot: 'problem', text: 'Locked' }
  }
  if (input.unlockMode === 'phone') {
    const n = input.phoneCount ?? 0
    return { id: 'power-cut', label, dot: 'ok', text: `Unlocks from your phone (${n} phone${n === 1 ? '' : 's'})` }
  }
  if (input.unlockMode === 'sapwood') {
    return { id: 'power-cut', label, dot: 'ok', text: 'Waits for Sapwood or its PIN' }
  }
  if (input.unlockMode === 'none') {
    return { id: 'power-cut', label, dot: 'problem', text: 'Not encrypted' }
  }
  if (input.atRestUnrecognised) {
    return { id: 'power-cut', label, dot: 'unknown', text: 'Update Sapwood to read this setting' }
  }
  if (input.overUsb) {
    return { id: 'power-cut', label, dot: 'unknown', text: 'Unknown: no vault key held here' }
  }
  return { id: 'power-cut', label, dot: 'unknown', text: 'Unknown: connect by USB to check' }
}

function backupRow(input: DeviceSummaryInput): SummaryRow {
  const label = 'Backup'
  if (!input.overUsb) {
    return input.needsBackup
      ? { id: 'backup', label, dot: 'attention', text: 'Backup needed' }
      : { id: 'backup', label, dot: 'unknown', text: 'Connect by USB to back up' }
  }
  if (!input.needsBackup && input.lastExportAt) {
    return { id: 'backup', label, dot: 'ok', text: `Backed up ${formatDate(input.lastExportAt)}` }
  }
  return { id: 'backup', label, dot: 'attention', text: 'Backup needed' }
}

/**
 * The section-row status words, in the tab's fixed display order (After a
 * power cut, Firmware, Backup). Network, Display and Diagnostics compute
 * their own row words directly in the component; they carry no attention
 * cards of their own.
 */
export function deviceSummaryRows(input: DeviceSummaryInput): SummaryRow[] {
  return [powerCutRow(input), firmwareRow(input), backupRow(input)]
}

function notEncryptedAttention(input: DeviceSummaryInput): AttentionRow | null {
  // A locked signer's encryption mode cannot be read, so it is reported as
  // "Locked" (via the row, and via VaultUnlock's own banner), never as "Not
  // encrypted": the two are different problems needing different actions.
  if (input.locked || input.unlockMode !== 'none') return null
  return {
    id: 'not-encrypted', dot: 'problem', label: 'Not encrypted',
    text: 'Anyone holding it can read the keys.', actionLabel: 'Choose how it unlocks',
  }
}

function firmwareAttention(input: DeviceSummaryInput): AttentionRow | null {
  if (!input.updateAvailable || !input.updateVersion) return null
  return input.overUsb
    ? { id: 'firmware', dot: 'attention', label: 'Update available', text: `v${input.updateVersion} is ready to install.`, actionLabel: 'Update' }
    : { id: 'firmware', dot: 'attention', label: 'Update available', text: `v${input.updateVersion} is ready. Updates need the USB cable.`, actionLabel: 'How to update' }
}

function backupAttention(input: DeviceSummaryInput): AttentionRow | null {
  if (!input.needsBackup) return null
  if (!input.overUsb) {
    return {
      id: 'backup', dot: 'attention', label: 'Back up your app pairings',
      text: 'Connect by USB to back up. The signer asks for a button press.', actionLabel: null,
    }
  }
  const text = input.lastExportAt
    ? `Pairings changed since your last backup on ${formatDate(input.lastExportAt)}.`
    : 'Pairings changed and this browser has no backup on record.'
  return { id: 'backup', dot: 'attention', label: 'Back up your app pairings', text, actionLabel: 'Back up' }
}

function storageAttention(input: DeviceSummaryInput): AttentionRow | null {
  if (input.storageState !== 'warn' && input.storageState !== 'full') return null
  const pct = input.storagePct ?? 0
  return {
    id: 'storage',
    dot: input.storageState === 'full' ? 'problem' : 'attention',
    label: `Storage ${pct}% full`,
    text: 'Remove an unused persona or app pairing to free space.',
    actionLabel: 'Details',
  }
}

function healthAttention(input: DeviceSummaryInput): AttentionRow | null {
  const reasons: string[] = []
  if (input.crash) reasons.push('The last restart was a crash.')
  if (input.fragmented) reasons.push('Memory is fragmented.')
  if (input.recovering) reasons.push('It restarted itself to recover.')
  if (!reasons.length) return null
  return { id: 'health', dot: 'attention', label: 'Health', text: reasons.join(' '), actionLabel: 'Details' }
}

function statusLostAttention(input: DeviceSummaryInput): AttentionRow | null {
  if (!input.statusLost) return null
  return {
    id: 'status-lost', dot: 'problem', label: 'Not answering',
    text: 'The signer stopped answering over WiFi. What you see may be out of date.', actionLabel: null,
  }
}

/**
 * The Needs-attention cards, worst first (problem, then attention). Absent
 * entirely when nothing needs a decision.
 */
export function attentionRows(input: DeviceSummaryInput): AttentionRow[] {
  const rows = [
    notEncryptedAttention(input),
    statusLostAttention(input),
    firmwareAttention(input),
    backupAttention(input),
    storageAttention(input),
    healthAttention(input),
  ].filter((row): row is AttentionRow => row !== null)
  return [...rows].sort((a, b) => severityRank(a.dot) - severityRank(b.dot))
}
