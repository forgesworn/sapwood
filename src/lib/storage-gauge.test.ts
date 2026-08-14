import { describe, it, expect } from 'vitest'
import { storageGauge } from './storage-gauge.js'

describe('storageGauge', () => {
  it('maps entry counts to a clamped percentage', () => {
    expect(storageGauge(0, 378)).toEqual({ pct: 0, state: 'ok', label: '0% used' })
    expect(storageGauge(189, 378)).toEqual({ pct: 50, state: 'ok', label: '50% used' })
    expect(storageGauge(400, 378)).toMatchObject({ pct: 100, state: 'full' })
  })

  it('warns at 80 and reads full at 95', () => {
    expect(storageGauge(79, 100)?.state).toBe('ok')
    expect(storageGauge(80, 100)?.state).toBe('warn')
    expect(storageGauge(94, 100)?.state).toBe('warn')
    expect(storageGauge(95, 100)?.state).toBe('full')
  })

  it('returns null when the signer did not report stats', () => {
    expect(storageGauge(undefined, 378)).toBeNull()
    expect(storageGauge(10, undefined)).toBeNull()
    expect(storageGauge(10, 0)).toBeNull()
    expect(storageGauge(-1, 378)).toBeNull()
  })
})
