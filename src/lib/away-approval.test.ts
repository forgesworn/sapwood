import { describe, expect, it } from 'vitest'
import { awayApprovalAvailability, awayApprovalNotApplied, awayApprovalOffered, AWAY_APPROVAL_PHONE_SETUP, AWAY_APPROVAL_RISKS } from './away-approval.js'
import { MANAGER_SLOT_LABEL } from './client-policy.js'

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

describe('awayApprovalOffered', () => {
  it('is offered on an ordinary app pairing', () => {
    expect(awayApprovalOffered({ label: 'Primal', escalate: false })).toBe(true)
    expect(awayApprovalOffered({ escalate: false })).toBe(true)
  })

  it('is not offered on Sapwood\'s own manager pairing', () => {
    expect(awayApprovalOffered({ label: MANAGER_SLOT_LABEL, escalate: false })).toBe(false)
  })

  it('still shows on a manager pairing already switched on, so it can be turned off', () => {
    expect(awayApprovalOffered({ label: MANAGER_SLOT_LABEL, escalate: true })).toBe(true)
  })
})

describe('away approval copy', () => {
  it('names the Signet pairing and the operator key the phone needs', () => {
    const text = AWAY_APPROVAL_PHONE_SETUP.join(' ')
    expect(text).toMatch(/Heartwood connect/)
    expect(text).toMatch(/operator key/)
    expect(text).toMatch(/Waiting for approval/)
  })

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
