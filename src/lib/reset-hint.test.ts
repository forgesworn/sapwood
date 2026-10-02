import { describe, expect, it } from 'vitest'

import { BOARDS, TETHERED_BOARDS } from './flasher.js'
import { resetButtonHint } from './reset-hint.js'

describe('resetButtonHint', () => {
  it('names a specific button for every board Sapwood can flash', () => {
    const generic = resetButtonHint(undefined)
    for (const board of [...BOARDS, ...TETHERED_BOARDS]) {
      if (board.id === 'esp8266') continue // tethered dev boards vary; the generic wording fits
      expect(resetButtonHint(board.id), board.id).not.toBe(generic)
    }
  })

  it('warns off the button people confuse with reset', () => {
    expect(resetButtonHint('heltec-v4')).toMatch(/not PRG/)
    expect(resetButtonHint('heltec-v3')).toMatch(/not PRG/)
    expect(resetButtonHint('c6')).toMatch(/not BOOT/)
    expect(resetButtonHint('tdisplay')).toMatch(/not the two front buttons/)
  })

  it('falls back to generic wording for an unknown board', () => {
    expect(resetButtonHint('mystery')).toMatch(/RST or RESET/)
    expect(resetButtonHint(null)).toMatch(/RST or RESET/)
  })
})
