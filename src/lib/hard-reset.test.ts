import { describe, expect, it } from 'vitest'

import { PulsedHardReset, type ResetLines } from './hard-reset.js'

function recordingLines(): ResetLines & { calls: string[] } {
  const calls: string[] = []
  return {
    calls,
    async setDTR(state) { calls.push(`DTR=${state ? 1 : 0}`) },
    async setRTS(state) { calls.push(`RTS=${state ? 1 : 0}`) },
  }
}

describe('PulsedHardReset', () => {
  it('pulses EN (RTS high then low) with IO0 released, unlike esptool-js', async () => {
    const lines = recordingLines()
    await new PulsedHardReset(lines).reset()
    // DTR off first so the chip boots its app, then the EN pulse that
    // esptool-js's own HardReset leaves out.
    expect(lines.calls).toEqual(['DTR=0', 'RTS=1', 'RTS=0'])
  })

  it('holds the reset for 100 ms on a USB-UART bridge and 200 ms on native USB', async () => {
    for (const [nativeUsb, min] of [[false, 90], [true, 390]] as const) {
      const lines = recordingLines()
      const started = Date.now()
      await new PulsedHardReset(lines, nativeUsb).reset()
      expect(Date.now() - started).toBeGreaterThanOrEqual(min)
      expect(lines.calls).toEqual(['DTR=0', 'RTS=1', 'RTS=0'])
    }
  })
})
