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
    storageState: 'ok',
    modeLabel: 'USB cable',
    ...overrides,
  }
}

describe('deviceSummaryRows', () => {
  it('reports firmware up to date and no storage row when everything is ok', () => {
    const rows = deviceSummaryRows(base())
    expect(rows.find((r) => r.id === 'firmware')).toEqual({
      id: 'firmware', dot: 'ok', text: 'Up to date (v0.18.0)', actionLabel: null,
    })
    expect(rows.find((r) => r.id === 'storage')).toBeUndefined()
  })

  it('flags an available update with an Update action', () => {
    const rows = deviceSummaryRows(base({ updateAvailable: true, updateVersion: '0.19.0' }))
    expect(rows.find((r) => r.id === 'firmware')).toEqual({
      id: 'firmware', dot: 'attention', text: 'Update available: v0.19.0', actionLabel: 'Update',
    })
  })

  it('describes phone unlock with a phone count', () => {
    const rows = deviceSummaryRows(base({ unlockMode: 'phone', phoneCount: 2 }))
    expect(rows.find((r) => r.id === 'power-cut')).toEqual({
      id: 'power-cut', dot: 'ok', text: 'Unlocks from your phone (2 phones)', actionLabel: 'Change',
    })
  })

  it('singularises one phone', () => {
    const rows = deviceSummaryRows(base({ unlockMode: 'phone', phoneCount: 1 }))
    expect(rows.find((r) => r.id === 'power-cut')?.text).toBe('Unlocks from your phone (1 phone)')
  })

  it('marks no encryption as a problem', () => {
    const rows = deviceSummaryRows(base({ unlockMode: 'none' }))
    expect(rows.find((r) => r.id === 'power-cut')).toEqual({
      id: 'power-cut', dot: 'problem',
      text: 'Not encrypted: anyone holding it can read the keys',
      actionLabel: 'Change',
    })
  })

  it('flags an unknown mode as needing attention', () => {
    const rows = deviceSummaryRows(base({ unlockMode: null }))
    expect(rows.find((r) => r.id === 'power-cut')?.dot).toBe('attention')
  })

  it('reads a fresh backup with its date', () => {
    const rows = deviceSummaryRows(base({ lastExportAt: Date.parse('2026-09-01T00:00:00Z') }))
    const row = rows.find((r) => r.id === 'backup')!
    expect(row.dot).toBe('ok')
    expect(row.text).toContain('Pairings backed up')
    expect(row.actionLabel).toBe('Back up')
  })

  it('asks for a backup when one is needed', () => {
    const rows = deviceSummaryRows(base({ needsBackup: true }))
    expect(rows.find((r) => r.id === 'backup')).toEqual({
      id: 'backup', dot: 'attention', text: 'Back up needed', actionLabel: 'Back up',
    })
  })

  it('asks for a backup when none has ever been recorded', () => {
    const rows = deviceSummaryRows(base({ lastExportAt: null }))
    expect(rows.find((r) => r.id === 'backup')).toEqual({
      id: 'backup', dot: 'attention', text: 'Back up needed', actionLabel: 'Back up',
    })
  })

  it('points a WiFi signer at USB for backup, with no action button', () => {
    const rows = deviceSummaryRows(base({ overUsb: false, modeLabel: 'WiFi' }))
    expect(rows.find((r) => r.id === 'backup')).toEqual({
      id: 'backup', dot: 'ok', text: 'Connect by USB to back up', actionLabel: null,
    })
  })

  it('reports a plain connection when nothing is wrong', () => {
    const rows = deviceSummaryRows(base())
    expect(rows.find((r) => r.id === 'connection')).toEqual({
      id: 'connection', dot: 'ok', text: 'Connected over USB cable', actionLabel: 'Details',
    })
  })

  it('names the reasons a connection needs attention', () => {
    const rows = deviceSummaryRows(base({ crash: true, fragmented: true, storageState: 'warn' }))
    const row = rows.find((r) => r.id === 'connection')!
    expect(row.dot).toBe('attention')
    expect(row.text).toBe(
      'Connected over USB cable: last restart was a crash, memory is fragmented, storage is filling up',
    )
  })

  it('reports disconnected as a problem with no action', () => {
    const rows = deviceSummaryRows(base({ modeLabel: 'Disconnected' }))
    expect(rows.find((r) => r.id === 'connection')).toEqual({
      id: 'connection', dot: 'problem', text: 'Disconnected', actionLabel: null,
    })
  })

  it('adds a storage row only when it is warn or full', () => {
    expect(deviceSummaryRows(base({ storageState: 'ok' })).find((r) => r.id === 'storage')).toBeUndefined()
    expect(deviceSummaryRows(base({ storageState: 'warn' })).find((r) => r.id === 'storage')).toEqual({
      id: 'storage', dot: 'attention', text: 'Storage filling up', actionLabel: 'Details',
    })
    expect(deviceSummaryRows(base({ storageState: 'full' })).find((r) => r.id === 'storage')).toEqual({
      id: 'storage', dot: 'problem', text: 'Storage nearly full', actionLabel: 'Details',
    })
  })

  it('orders problems first, then attention, then ok rows', () => {
    const rows = deviceSummaryRows(base({
      unlockMode: 'none', // problem
      storageState: 'warn', // attention (also taints connection to attention)
    }))
    const dots = rows.map((r) => r.dot)
    for (let i = 1; i < dots.length; i++) {
      const rank = (d: string) => (d === 'problem' ? 0 : d === 'attention' ? 1 : 2)
      expect(rank(dots[i])).toBeGreaterThanOrEqual(rank(dots[i - 1]))
    }
    expect(rows[0].id).toBe('power-cut')
  })
})
