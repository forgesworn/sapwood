import { describe, expect, it } from 'vitest'
import { describeReset, formatUptime } from './reset-reason.js'

describe('describeReset', () => {
  it('marks deliberate restarts as non-crashes', () => {
    expect(describeReset('software-restart')).toEqual({ text: 'planned restart', crash: false })
    expect(describeReset('power-on').crash).toBe(false)
  })

  it('marks panic, watchdogs and brownout as crashes', () => {
    for (const reason of ['panic', 'interrupt-watchdog', 'task-watchdog', 'watchdog', 'brownout']) {
      expect(describeReset(reason).crash).toBe(true)
    }
  })

  it('passes unknown reasons through', () => {
    expect(describeReset('unknown')).toEqual({ text: 'unknown', crash: true })
    expect(describeReset('future-cause')).toEqual({ text: 'future-cause', crash: false })
  })
})

describe('formatUptime', () => {
  it('formats seconds, minutes, hours and days', () => {
    expect(formatUptime(42)).toBe('42s')
    expect(formatUptime(5 * 60)).toBe('5m')
    expect(formatUptime(2 * 3600 + 12 * 60)).toBe('2h 12m')
    expect(formatUptime(3 * 86_400 + 4 * 3600)).toBe('3d 4h')
  })

  it('rejects nonsense', () => {
    expect(formatUptime(-1)).toBe('--')
    expect(formatUptime(NaN)).toBe('--')
  })
})
