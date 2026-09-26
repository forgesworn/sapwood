import { describe, it, expect } from 'vitest'
import { deviceSummaryRows, attentionRows, type DeviceSummaryInput } from './device-summary.js'

function base(overrides: Partial<DeviceSummaryInput> = {}): DeviceSummaryInput {
  return {
    updateAvailable: false,
    updateVersion: null,
    runningVersion: '0.18.0',
    unlockMode: 'sapwood',
    phoneCount: null,
    atRestUnrecognised: false,
    overUsb: true,
    locked: false,
    needsBackup: false,
    lastExportAt: Date.parse('2026-09-01T00:00:00Z'),
    crash: false,
    fragmented: false,
    recovering: false,
    storageState: 'ok',
    storagePct: null,
    statusLost: false,
    ...overrides,
  }
}

describe('deviceSummaryRows', () => {
  it('reports firmware up to date, in fixed section order', () => {
    const rows = deviceSummaryRows(base())
    expect(rows.map((r) => r.id)).toEqual(['power-cut', 'firmware', 'backup'])
    expect(rows.find((r) => r.id === 'firmware')).toEqual({
      id: 'firmware', label: 'Firmware', dot: 'ok', text: 'Up to date (v0.18.0)',
    })
  })

  it('gives an unknown version a grey dot, never green', () => {
    const rows = deviceSummaryRows(base({ runningVersion: null }))
    const row = rows.find((r) => r.id === 'firmware')!
    expect(row.dot).toBe('unknown')
    expect(row.text).toBe('Version unknown')
  })

  it('flags an available update on the firmware row', () => {
    const rows = deviceSummaryRows(base({ updateAvailable: true, updateVersion: '0.19.0' }))
    expect(rows.find((r) => r.id === 'firmware')).toEqual({
      id: 'firmware', label: 'Firmware', dot: 'attention', text: 'Update available: v0.19.0',
    })
  })

  it('describes phone unlock with a phone count', () => {
    const rows = deviceSummaryRows(base({ unlockMode: 'phone', phoneCount: 2 }))
    expect(rows.find((r) => r.id === 'power-cut')).toEqual({
      id: 'power-cut', label: 'After a power cut', dot: 'ok', text: 'Unlocks from your phone (2 phones)',
    })
  })

  it('singularises one phone', () => {
    const rows = deviceSummaryRows(base({ unlockMode: 'phone', phoneCount: 1 }))
    expect(rows.find((r) => r.id === 'power-cut')?.text).toBe('Unlocks from your phone (1 phone)')
  })

  it('marks no encryption as a problem, row text just "Not encrypted"', () => {
    const rows = deviceSummaryRows(base({ unlockMode: 'none' }))
    expect(rows.find((r) => r.id === 'power-cut')).toEqual({
      id: 'power-cut', label: 'After a power cut', dot: 'problem', text: 'Not encrypted',
    })
  })

  it('gives a locked signer a problem row reading "Locked"', () => {
    const rows = deviceSummaryRows(base({ locked: true, unlockMode: null }))
    expect(rows.find((r) => r.id === 'power-cut')).toEqual({
      id: 'power-cut', label: 'After a power cut', dot: 'problem', text: 'Locked',
    })
  })

  it('names an unknown mode over WiFi and over USB, both neutral', () => {
    const wifi = deviceSummaryRows(base({ unlockMode: null, overUsb: false }))
    expect(wifi.find((r) => r.id === 'power-cut')).toEqual({
      id: 'power-cut', label: 'After a power cut', dot: 'unknown', text: 'Unknown: connect by USB to check',
    })
    const usb = deviceSummaryRows(base({ unlockMode: null, overUsb: true }))
    expect(usb.find((r) => r.id === 'power-cut')).toEqual({
      id: 'power-cut', label: 'After a power cut', dot: 'unknown', text: 'Unknown: no vault key held here',
    })
  })

  it('names an unrecognised firmware report distinctly', () => {
    const rows = deviceSummaryRows(base({ unlockMode: null, atRestUnrecognised: true }))
    const row = rows.find((r) => r.id === 'power-cut')!
    expect(row.dot).toBe('unknown')
    expect(row.text).toBe('Update Sapwood to read this setting')
  })

  it('reads a fresh backup with its date, green', () => {
    const rows = deviceSummaryRows(base({ lastExportAt: Date.parse('2026-09-01T00:00:00Z') }))
    const row = rows.find((r) => r.id === 'backup')!
    expect(row.dot).toBe('ok')
    expect(row.text).toContain('Backed up')
  })

  it('reports backup needed, over USB or WiFi', () => {
    expect(deviceSummaryRows(base({ needsBackup: true })).find((r) => r.id === 'backup')).toEqual({
      id: 'backup', label: 'Backup', dot: 'attention', text: 'Backup needed',
    })
    expect(deviceSummaryRows(base({ overUsb: false, needsBackup: true })).find((r) => r.id === 'backup')).toEqual({
      id: 'backup', label: 'Backup', dot: 'attention', text: 'Backup needed',
    })
  })

  it('points a WiFi signer at USB for backup, neutral', () => {
    const rows = deviceSummaryRows(base({ overUsb: false }))
    expect(rows.find((r) => r.id === 'backup')).toEqual({
      id: 'backup', label: 'Backup', dot: 'unknown', text: 'Connect by USB to back up',
    })
  })
})

describe('attentionRows', () => {
  it('is empty when nothing needs attention', () => {
    expect(attentionRows(base())).toEqual([])
  })

  it('flags no encryption as a problem card, with a "Choose how it unlocks" action', () => {
    const rows = attentionRows(base({ unlockMode: 'none' }))
    expect(rows).toEqual([{
      id: 'not-encrypted', dot: 'problem', label: 'Not encrypted',
      text: 'Anyone holding it can read the keys.', actionLabel: 'Choose how it unlocks',
    }])
  })

  it('does not flag a locked signer as "not encrypted"', () => {
    expect(attentionRows(base({ locked: true, unlockMode: null }))).toEqual([])
  })

  it('offers an Update action over USB, and How to update over WiFi', () => {
    const usb = attentionRows(base({ updateAvailable: true, updateVersion: '0.19.0' }))
    expect(usb).toEqual([{
      id: 'firmware', dot: 'attention', label: 'Update available',
      text: 'v0.19.0 is ready to install.', actionLabel: 'Update',
    }])
    const wifi = attentionRows(base({ updateAvailable: true, updateVersion: '0.19.0', overUsb: false }))
    expect(wifi).toEqual([{
      id: 'firmware', dot: 'attention', label: 'Update available',
      text: 'v0.19.0 is ready. Updates need the USB cable.', actionLabel: 'How to update',
    }])
  })

  it('names the backup date when one is on record, over USB', () => {
    const rows = attentionRows(base({ needsBackup: true, lastExportAt: Date.parse('2026-09-01T00:00:00Z') }))
    expect(rows[0].text).toContain('Pairings changed since your last backup on')
    expect(rows[0].actionLabel).toBe('Back up')
  })

  it('says no backup is on record when none exists', () => {
    const rows = attentionRows(base({ needsBackup: true, lastExportAt: null }))
    expect(rows[0].text).toBe('Pairings changed and this browser has no backup on record.')
  })

  it('gives a WiFi backup card no button, and the USB-cable copy', () => {
    const rows = attentionRows(base({ overUsb: false, needsBackup: true }))
    expect(rows).toEqual([{
      id: 'backup', dot: 'attention', label: 'Back up your app pairings',
      text: 'Connect by USB to back up. The signer asks for a button press.', actionLabel: null,
    }])
  })

  it('shows the storage percentage, and problem dot only when full', () => {
    const warn = attentionRows(base({ storageState: 'warn', storagePct: 87 }))
    expect(warn[0]).toEqual({
      id: 'storage', dot: 'attention', label: 'Storage 87% full',
      text: 'Remove an unused persona or app pairing to free space.', actionLabel: 'Details',
    })
    const full = attentionRows(base({ storageState: 'full', storagePct: 98 }))
    expect(full[0].dot).toBe('problem')
    expect(full[0].label).toBe('Storage 98% full')
  })

  it('is null (absent) when nothing needs a health card', () => {
    expect(attentionRows(base())).toHaveLength(0)
  })

  it('joins several health reasons with a space, as a Health card, not Connection', () => {
    const rows = attentionRows(base({ crash: true, fragmented: true, recovering: true }))
    expect(rows).toEqual([{
      id: 'health', dot: 'attention', label: 'Health',
      text: 'The last restart was a crash. Memory is fragmented. It restarted itself to recover.',
      actionLabel: 'Details',
    }])
  })

  it('flags a stopped relay as "Not answering", with no button', () => {
    const rows = attentionRows(base({ statusLost: true }))
    expect(rows).toEqual([{
      id: 'status-lost', dot: 'problem', label: 'Not answering',
      text: 'The signer stopped answering over WiFi. What you see may be out of date.', actionLabel: null,
    }])
  })

  it('orders problem cards before attention cards', () => {
    const rows = attentionRows(base({ unlockMode: 'none', storageState: 'warn', storagePct: 50 }))
    expect(rows.map((r) => r.dot)).toEqual(['problem', 'attention'])
    expect(rows[0].id).toBe('not-encrypted')
  })
})
