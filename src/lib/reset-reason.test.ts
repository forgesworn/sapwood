import { describe, expect, it } from 'vitest'
import { describeReset, formatUptime, formatBytes } from './reset-reason.js'

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

  it('treats a USB or JTAG reset as routine, not a crash', () => {
    // A host re-opening the port resets a native-USB board (V4, C6). Before
    // the firmware mapped these they arrived as "unknown", which this table
    // scores as a crash, so an ordinary reconnect looked like a fault.
    expect(describeReset('usb-peripheral-reset')).toEqual({ text: 'USB reset by host', crash: false })
    expect(describeReset('jtag-reset').crash).toBe(false)
  })
})

describe('formatBytes', () => {
  it('formats bytes, kilobytes and megabytes', () => {
    expect(formatBytes(512)).toBe('512 B')
    expect(formatBytes(1024)).toBe('1.0 KB')
    expect(formatBytes(20_480)).toBe('20.0 KB')
    // Past 100 KB the decimal is noise, so it rounds.
    expect(formatBytes(180 * 1024)).toBe('180 KB')
    expect(formatBytes(2 * 1024 * 1024)).toBe('2.0 MB')
  })

  it('rejects nonsense', () => {
    expect(formatBytes(-1)).toBe('--')
    expect(formatBytes(NaN)).toBe('--')
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
