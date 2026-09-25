import { describe, it, expect } from 'vitest'
import { deviceSummaryRows, type DeviceSummaryInput } from './device-summary.js'

function base(overrides: Partial<DeviceSummaryInput> = {}): DeviceSummaryInput {
  return {
    updateAvailable: false,
    updateVersion: null,
    runningVersion: '0.18.0',
    unlockMode: 'sapwood',
    phoneCount: null,
    overUsb: true,
    needsBackup: false,
    lastExportAt: Date.parse('2026-09-01T00:00:00Z'),
    crash: false,
    fragmented: false,
    recovering: false,
    storageState: 'ok',
    modeLabel: 'USB cable',
    ...overrides,
  }
}

describe('deviceSummaryRows', () => {
  it('reports firmware up to date and no storage row when everything is ok', () => {
    const rows = deviceSummaryRows(base())
    expect(rows.find((r) => r.id === 'firmware')).toEqual({
      id: 'firmware', label: 'Firmware', dot: 'ok', text: 'Up to date (v0.18.0)', actionLabel: null,
    })
    expect(rows.find((r) => r.id === 'storage')).toBeUndefined()
  })

  it('flags an available update with an Update action', () => {
    const rows = deviceSummaryRows(base({ updateAvailable: true, updateVersion: '0.19.0' }))
    expect(rows.find((r) => r.id === 'firmware')).toEqual({
      id: 'firmware', label: 'Firmware', dot: 'attention', text: 'Update available: v0.19.0', actionLabel: 'Update',
    })
  })

  it('describes phone unlock with a phone count', () => {
    const rows = deviceSummaryRows(base({ unlockMode: 'phone', phoneCount: 2 }))
    expect(rows.find((r) => r.id === 'power-cut')).toEqual({
      id: 'power-cut', label: 'After a power cut', dot: 'ok',
      text: 'Unlocks from your phone (2 phones)', actionLabel: 'Change',
    })
  })

  it('singularises one phone', () => {
    const rows = deviceSummaryRows(base({ unlockMode: 'phone', phoneCount: 1 }))
    expect(rows.find((r) => r.id === 'power-cut')?.text).toBe('Unlocks from your phone (1 phone)')
  })

  it('marks no encryption as a problem', () => {
    const rows = deviceSummaryRows(base({ unlockMode: 'none' }))
    expect(rows.find((r) => r.id === 'power-cut')).toEqual({
      id: 'power-cut', label: 'After a power cut', dot: 'problem',
      text: 'Not encrypted: anyone holding it can read the keys',
      actionLabel: 'Change',
    })
  })

  it('names the transport for an unknown mode over WiFi, with a neutral dot', () => {
    const rows = deviceSummaryRows(base({ unlockMode: null, overUsb: false, modeLabel: 'WiFi' }))
    expect(rows.find((r) => r.id === 'power-cut')).toEqual({
      id: 'power-cut', label: 'After a power cut', dot: 'unknown',
      text: 'Unknown over WiFi. Connect by USB to check', actionLabel: 'Change',
    })
  })

  it('gives a different unknown reason over USB, still neutral', () => {
    const rows = deviceSummaryRows(base({ unlockMode: null, overUsb: true }))
    const row = rows.find((r) => r.id === 'power-cut')!
    expect(row.dot).toBe('unknown')
    expect(row.text).toBe('Unknown: no vault key held here')
  })

  it('reads a fresh backup with its date, green', () => {
    const rows = deviceSummaryRows(base({ lastExportAt: Date.parse('2026-09-01T00:00:00Z') }))
    const row = rows.find((r) => r.id === 'backup')!
    expect(row.dot).toBe('ok')
    expect(row.text).toContain('Backed up')
    expect(row.actionLabel).toBe('Back up')
  })

  it('asks for a backup when one is needed', () => {
    const rows = deviceSummaryRows(base({ needsBackup: true }))
    expect(rows.find((r) => r.id === 'backup')).toEqual({
      id: 'backup', label: 'Backup', dot: 'attention', text: 'Back up needed', actionLabel: 'Back up',
    })
  })

  it('asks for a backup when none has ever been recorded', () => {
    const rows = deviceSummaryRows(base({ lastExportAt: null }))
    expect(rows.find((r) => r.id === 'backup')).toEqual({
      id: 'backup', label: 'Backup', dot: 'attention', text: 'Back up needed', actionLabel: 'Back up',
    })
  })

  it('points a WiFi signer at USB for backup, neutral (not green) and with no action button', () => {
    const rows = deviceSummaryRows(base({ overUsb: false, modeLabel: 'WiFi' }))
    expect(rows.find((r) => r.id === 'backup')).toEqual({
      id: 'backup', label: 'Backup', dot: 'unknown', text: 'Connect by USB to back up', actionLabel: null,
    })
  })

  it('flags a needed backup over WiFi as amber, not neutral', () => {
    const rows = deviceSummaryRows(base({ overUsb: false, modeLabel: 'WiFi', needsBackup: true }))
    expect(rows.find((r) => r.id === 'backup')).toEqual({
      id: 'backup', label: 'Backup', dot: 'attention', text: 'Back up needed: connect by USB', actionLabel: null,
    })
  })

  it('reports a plain connection when nothing is wrong', () => {
    const rows = deviceSummaryRows(base())
    expect(rows.find((r) => r.id === 'connection')).toEqual({
      id: 'connection', label: 'Connection', dot: 'ok', text: 'Connected over USB cable', actionLabel: 'Details',
    })
  })

  it('names crash, fragmentation and recovery, but never storage', () => {
    const rows = deviceSummaryRows(base({ crash: true, fragmented: true, recovering: true, storageState: 'full' }))
    const row = rows.find((r) => r.id === 'connection')!
    expect(row.dot).toBe('attention')
    expect(row.text).toBe(
      'Connected over USB cable: last restart was a crash, memory is fragmented, recovering from a restart',
    )
    expect(row.text).not.toContain('storage')
  })

  it('does not cite storage in the connection row even when storage alone is warn', () => {
    const rows = deviceSummaryRows(base({ storageState: 'warn' }))
    const row = rows.find((r) => r.id === 'connection')!
    expect(row.dot).toBe('ok')
    expect(row.text).toBe('Connected over USB cable')
  })

  it('reports disconnected as a problem with no action', () => {
    const rows = deviceSummaryRows(base({ modeLabel: 'Disconnected' }))
    expect(rows.find((r) => r.id === 'connection')).toEqual({
      id: 'connection', label: 'Connection', dot: 'problem', text: 'Disconnected', actionLabel: null,
    })
  })

  it('adds a storage row only when it is warn or full', () => {
    expect(deviceSummaryRows(base({ storageState: 'ok' })).find((r) => r.id === 'storage')).toBeUndefined()
    expect(deviceSummaryRows(base({ storageState: 'warn' })).find((r) => r.id === 'storage')).toEqual({
      id: 'storage', label: 'Storage', dot: 'attention', text: 'Filling up', actionLabel: 'Details',
    })
    expect(deviceSummaryRows(base({ storageState: 'full' })).find((r) => r.id === 'storage')).toEqual({
      id: 'storage', label: 'Storage', dot: 'problem', text: 'Nearly full', actionLabel: 'Details',
    })
  })

  it('orders problems first, then attention, then unknown, then ok rows', () => {
    const rows = deviceSummaryRows(base({
      unlockMode: 'none', // problem
      storageState: 'warn', // attention, standalone row
      overUsb: false, // backup becomes 'unknown'
      modeLabel: 'WiFi',
    }))
    const rank = (d: string) => (d === 'problem' ? 0 : d === 'attention' ? 1 : d === 'unknown' ? 2 : 3)
    const dots = rows.map((r) => r.dot)
    for (let i = 1; i < dots.length; i++) {
      expect(rank(dots[i])).toBeGreaterThanOrEqual(rank(dots[i - 1]))
    }
    expect(rows[0].id).toBe('power-cut')
  })
})
