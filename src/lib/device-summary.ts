// "Your signer" summary rows: the handful of plain-English lines at the top
// of the Device panel, one per concern, ordered so anything needing
// attention comes first. Pure so the ordering and wording are unit-tested
// without a rendered component.

import type { UnlockMode } from './phone-unlock.js'

/** "unknown" is a neutral, muted state: not good, not bad, just not knowable
 *  from here (e.g. a WiFi signer that hasn't proved its backup or unlock
 *  state). It must never read as green. */
export type SummaryDot = 'ok' | 'unknown' | 'attention' | 'problem'

export type SummaryRowId = 'firmware' | 'power-cut' | 'backup' | 'connection' | 'storage'

export interface SummaryRow {
  id: SummaryRowId
  /** The fixed, bold concern label shown before the state text, e.g. "Firmware". */
  label: string
  dot: SummaryDot
  text: string
  /** Label for the row's one primary button, or null when there is nothing to do. */
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
  needsBackup: boolean
  lastExportAt: number | null
  /** The signer's last restart was a crash. */
  crash: boolean
  /** The signer's heap is fragmented. */
  fragmented: boolean
  /** The signer restarted itself to recover from a wedged relay service. */
  recovering: boolean
  storageState: 'ok' | 'warn' | 'full' | null
  /** "USB cable" / "WiFi" / "Bridge" / "Disconnected". */
  modeLabel: string
}

function severityRank(dot: SummaryDot): number {
  return dot === 'problem' ? 0 : dot === 'attention' ? 1 : dot === 'unknown' ? 2 : 3
}

function firmwareRow(input: DeviceSummaryInput): SummaryRow {
  if (input.updateAvailable && input.updateVersion) {
    return {
      id: 'firmware', label: 'Firmware', dot: 'attention',
      text: `Update available: v${input.updateVersion}`, actionLabel: 'Update',
    }
  }
  if (input.runningVersion) {
    return {
      id: 'firmware', label: 'Firmware', dot: 'ok',
      text: `Up to date (v${input.runningVersion})`, actionLabel: null,
    }
  }
  return { id: 'firmware', label: 'Firmware', dot: 'ok', text: 'Version unknown', actionLabel: null }
}

function powerCutRow(input: DeviceSummaryInput): SummaryRow {
  const label = 'After a power cut'
  if (input.unlockMode === 'phone') {
    const n = input.phoneCount ?? 0
    return {
      id: 'power-cut', label, dot: 'ok',
      text: `Unlocks from your phone (${n} phone${n === 1 ? '' : 's'})`,
      actionLabel: 'Change',
    }
  }
  if (input.unlockMode === 'sapwood') {
    return { id: 'power-cut', label, dot: 'ok', text: 'Waits for Sapwood', actionLabel: 'Change' }
  }
  if (input.unlockMode === 'none') {
    return {
      id: 'power-cut', label, dot: 'problem',
      text: 'Not encrypted: anyone holding it can read the keys',
      actionLabel: 'Change',
    }
  }
  const text = input.atRestUnrecognised
    ? "Your signer reported a setting this version of Sapwood doesn't know. Update Sapwood."
    : input.overUsb
      ? 'Unknown: no vault key held here'
      : `Unknown over ${input.modeLabel}. Connect by USB to check`
  return { id: 'power-cut', label, dot: 'unknown', text, actionLabel: 'Change' }
}

function backupDate(at: number): string {
  return new Date(at).toLocaleDateString()
}

function backupRow(input: DeviceSummaryInput): SummaryRow {
  const label = 'Backup'
  if (!input.overUsb) {
    return input.needsBackup
      ? { id: 'backup', label, dot: 'attention', text: 'Back up needed: connect by USB', actionLabel: null }
      : { id: 'backup', label, dot: 'unknown', text: 'Connect by USB to back up', actionLabel: null }
  }
  if (!input.needsBackup && input.lastExportAt) {
    return { id: 'backup', label, dot: 'ok', text: `Backed up ${backupDate(input.lastExportAt)}`, actionLabel: 'Back up' }
  }
  return { id: 'backup', label, dot: 'attention', text: 'Back up needed', actionLabel: 'Back up' }
}

function connectionRow(input: DeviceSummaryInput): SummaryRow {
  const label = 'Connection'
  if (input.modeLabel === 'Disconnected') {
    return { id: 'connection', label, dot: 'problem', text: 'Disconnected', actionLabel: null }
  }
  // Storage has its own row when it needs attention; naming it here too would
  // repeat the same fact twice on the page.
  const reasons: string[] = []
  if (input.crash) reasons.push('last restart was a crash')
  if (input.fragmented) reasons.push('memory is fragmented')
  if (input.recovering) reasons.push('recovering from a restart')
  const text = reasons.length
    ? `Connected over ${input.modeLabel}: ${reasons.join(', ')}`
    : `Connected over ${input.modeLabel}`
  return { id: 'connection', label, dot: reasons.length ? 'attention' : 'ok', text, actionLabel: 'Details' }
}

function storageRow(input: DeviceSummaryInput): SummaryRow | null {
  if (input.storageState !== 'warn' && input.storageState !== 'full') return null
  return {
    id: 'storage',
    label: 'Storage',
    dot: input.storageState === 'full' ? 'problem' : 'attention',
    text: input.storageState === 'full' ? 'Nearly full' : 'Filling up',
    actionLabel: 'Details',
  }
}

/**
 * The "Your signer" rows, in display order: anything needing attention
 * (problem, then attention, then unknown) comes before rows that are simply ok.
 */
export function deviceSummaryRows(input: DeviceSummaryInput): SummaryRow[] {
  const rows = [firmwareRow(input), powerCutRow(input), backupRow(input), connectionRow(input), storageRow(input)]
    .filter((row): row is SummaryRow => row !== null)
  return [...rows].sort((a, b) => severityRank(a.dot) - severityRank(b.dot))
}
