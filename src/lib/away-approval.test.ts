import { describe, expect, it } from 'vitest'
import { awayApprovalAvailability, awayApprovalNotApplied, AWAY_APPROVAL_RISKS } from './away-approval.js'

describe('awayApprovalAvailability', () => {
  it('is offered over the relay, where the board is in WiFi mode by definition', () => {
    expect(awayApprovalAvailability({ transport: 'relay', boardMode: null })).toEqual({ available: true })
  })

  it('is offered over USB for a WiFi-mode board', () => {
    expect(awayApprovalAvailability({ transport: 'serial', boardMode: 'wifi' })).toEqual({ available: true })
  })

  it('is offered over USB while the board mode is not yet known', () => {
    expect(awayApprovalAvailability({ transport: 'serial', boardMode: null }).available).toBe(true)
  })

  it('is refused for a USB-mode board, which could never hear the phone', () => {
    const result = awayApprovalAvailability({ transport: 'serial', boardMode: 'usb' })
    expect(result.available).toBe(false)
    if (!result.available) expect(result.reason).toMatch(/WiFi mode/)
  })

  it('is refused over the bridge and when disconnected', () => {
    expect(awayApprovalAvailability({ transport: 'http', boardMode: 'wifi' }).available).toBe(false)
    expect(awayApprovalAvailability({ transport: null, boardMode: null }).available).toBe(false)
  })
})

describe('away approval copy', () => {
  it('names the operator key and the 10-minute window in the risks', () => {
    const text = AWAY_APPROVAL_RISKS.join(' ')
    expect(text).toMatch(/operator key/)
    expect(text).toMatch(/10 minutes/)
  })

  it('points a WiFi failure to turn it off at USB', () => {
    expect(awayApprovalNotApplied(false, 'relay')).toMatch(/over USB/)
    expect(awayApprovalNotApplied(true, 'serial')).toMatch(/did not turn on/)
  })
})
