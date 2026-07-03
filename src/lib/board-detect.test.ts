import { describe, it, expect } from 'vitest'
import { boardCandidates } from './board-detect'

describe('boardCandidates', () => {
  it('maps Espressif native USB to both native-USB boards', () => {
    const r = boardCandidates({ usbVendorId: 0x303a, usbProductId: 0x1001 })
    expect(r.boardIds).toEqual(['heltec-v4', 'c6'])
  })

  it('maps CP210x to the Heltec V3', () => {
    expect(boardCandidates({ usbVendorId: 0x10c4, usbProductId: 0xea60 }).boardIds).toEqual(['heltec-v3'])
  })

  it('splits WCH bridges by product id: CH9102 → T-Display, CH340 → ESP8266', () => {
    expect(boardCandidates({ usbVendorId: 0x1a86, usbProductId: 0x55d4 }).boardIds).toEqual(['tdisplay'])
    expect(boardCandidates({ usbVendorId: 0x1a86, usbProductId: 0x7523 }).boardIds).toEqual(['esp8266'])
  })

  it('offers both WCH families when the product id is unknown', () => {
    expect(boardCandidates({ usbVendorId: 0x1a86, usbProductId: 0x9999 }).boardIds)
      .toEqual(['tdisplay', 'esp8266'])
  })

  it('maps FTDI to the ESP8266', () => {
    expect(boardCandidates({ usbVendorId: 0x0403, usbProductId: 0x6001 }).boardIds).toEqual(['esp8266'])
  })

  it('returns no candidates for unknown vendors or missing descriptors', () => {
    expect(boardCandidates({ usbVendorId: 0xdead }).boardIds).toEqual([])
    expect(boardCandidates({}).boardIds).toEqual([])
  })
})
