// "Your signer" summary rows: the handful of plain-English lines at the top
// of the Device panel, one per concern, ordered so anything needing
// attention comes first. Pure so the ordering and wording are unit-tested
// without a rendered component.

import type { UnlockMode } from './phone-unlock.js'

export type SummaryDot = 'ok' | 'attention' | 'problem'

export type SummaryRowId = 'firmware' | 'power-cut' | 'backup' | 'connection' | 'storage'

export interface SummaryRow {
  id: SummaryRowId
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
  /** The inferred after-a-power-cut mode; null when it cannot be told. */
  unlockMode: UnlockMode | null
  phoneCount: number | null
  overUsb: boolean
  needsBackup: boolean
  lastExportAt: number | null
  /** The signer's last restart was a crash. */
  crash: boolean
  /** The signer's heap is fragmented. */
  fragmented: boolean
  storageState: 'ok' | 'warn' | 'full' | null
  /** "USB cable" / "WiFi" / "Bridge" / "Disconnected". */
  modeLabel: string
}

function severityRank(dot: SummaryDot): number {
  return dot === 'problem' ? 0 : dot === 'attention' ? 1 : 2
}

function firmwareRow(input: DeviceSummaryInput): SummaryRow {
  if (input.updateAvailable && input.updateVersion) {
    return { id: 'firmware', dot: 'attention', text: `Update available: v${input.updateVersion}`, actionLabel: 'Update' }
  }
  if (input.runningVersion) {
    return { id: 'firmware', dot: 'ok', text: `Up to date (v${input.runningVersion})`, actionLabel: null }
  }
  return { id: 'firmware', dot: 'ok', text: 'Firmware version unknown', actionLabel: null }
}

function powerCutRow(input: DeviceSummaryInput): SummaryRow {
  if (input.unlockMode === 'phone') {
    const n = input.phoneCount ?? 0
    return {
      id: 'power-cut', dot: 'ok',
      text: `Unlocks from your phone (${n} phone${n === 1 ? '' : 's'})`,
      actionLabel: 'Change',
    }
  }
  if (input.unlockMode === 'sapwood') {
    return { id: 'power-cut', dot: 'ok', text: 'Waits for Sapwood', actionLabel: 'Change' }
  }
  if (input.unlockMode === 'none') {
    return {
      id: 'power-cut', dot: 'problem',
      text: 'Not encrypted: anyone holding it can read the keys',
      actionLabel: 'Change',
    }
  }
  return { id: 'power-cut', dot: 'attention', text: 'Unknown: connect by USB to check', actionLabel: 'Change' }
}

function backupDate(at: number): string {
  return new Date(at).toLocaleDateString()
}

function backupRow(input: DeviceSummaryInput): SummaryRow {
  if (!input.overUsb) {
    return {
      id: 'backup', dot: input.needsBackup ? 'attention' : 'ok',
      text: 'Connect by USB to back up', actionLabel: null,
    }
  }
  if (!input.needsBackup && input.lastExportAt) {
    return { id: 'backup', dot: 'ok', text: `Pairings backed up ${backupDate(input.lastExportAt)}`, actionLabel: 'Back up' }
  }
  return { id: 'backup', dot: 'attention', text: 'Back up needed', actionLabel: 'Back up' }
}

function connectionRow(input: DeviceSummaryInput): SummaryRow {
  if (input.modeLabel === 'Disconnected') {
    return { id: 'connection', dot: 'problem', text: 'Disconnected', actionLabel: null }
  }
  const reasons: string[] = []
  if (input.crash) reasons.push('last restart was a crash')
  if (input.fragmented) reasons.push('memory is fragmented')
  if (input.storageState === 'full') reasons.push('storage is full')
  else if (input.storageState === 'warn') reasons.push('storage is filling up')
  const text = reasons.length
    ? `Connected over ${input.modeLabel}: ${reasons.join(', ')}`
    : `Connected over ${input.modeLabel}`
  return { id: 'connection', dot: reasons.length ? 'attention' : 'ok', text, actionLabel: 'Details' }
}

function storageRow(input: DeviceSummaryInput): SummaryRow | null {
  if (input.storageState !== 'warn' && input.storageState !== 'full') return null
  return {
    id: 'storage',
    dot: input.storageState === 'full' ? 'problem' : 'attention',
    text: input.storageState === 'full' ? 'Storage nearly full' : 'Storage filling up',
    actionLabel: 'Details',
  }
}

/**
 * The "Your signer" rows, in display order: anything needing attention
 * (problem, then attention) comes before rows that are simply ok.
 */
export function deviceSummaryRows(input: DeviceSummaryInput): SummaryRow[] {
  const rows = [firmwareRow(input), powerCutRow(input), backupRow(input), connectionRow(input), storageRow(input)]
    .filter((row): row is SummaryRow => row !== null)
  return [...rows].sort((a, b) => severityRank(a.dot) - severityRank(b.dot))
}
