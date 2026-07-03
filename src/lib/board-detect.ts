// Board detection from USB descriptors.
//
// Web Serial exposes the vendor/product id of a plugged device without opening
// it. That identifies the USB bridge chip, which narrows the board — sometimes
// to one certain match, sometimes to a couple of candidates. Boards on the
// chip's native USB (Espressif 0x303a) can't be split further without an
// esptool probe, so callers get a candidate LIST and decide how to present it.

/** USB ids seen via SerialPort.getInfo(). */
export interface UsbId {
  usbVendorId?: number
  usbProductId?: number
}

export interface BoardCandidates {
  /** BoardSpec ids (or 'esp8266' for the tethered flow), most likely first. */
  boardIds: string[]
  /** Plain-language name of what was recognised on the cable, for the UI tag. */
  via: string
}

const ESPRESSIF = 0x303a // native USB-Serial-JTAG (S3/C6 class chips)
const SILABS = 0x10c4 // CP210x
const WCH = 0x1a86 // CH340 / CH9102
const FTDI = 0x0403

const CH9102_PIDS = new Set([0x55d4, 0x55d3])
const CH340_PIDS = new Set([0x7523, 0x5523])

/**
 * The boards a plugged USB device could be, most likely first. Empty when the
 * descriptor is missing or from a vendor we don't recognise — the caller shows
 * the full untouched list in that case.
 */
export function boardCandidates(info: UsbId): BoardCandidates {
  const vid = info.usbVendorId
  const pid = info.usbProductId
  if (vid === undefined) return { boardIds: [], via: '' }

  switch (vid) {
    case ESPRESSIF:
      // The chip's own USB: Heltec V4 and the Waveshare C6 both look like this.
      return { boardIds: ['heltec-v4', 'c6'], via: "the chip's own USB port" }
    case SILABS:
      return { boardIds: ['heltec-v3'], via: 'a CP210x USB bridge' }
    case WCH:
      if (pid !== undefined && CH9102_PIDS.has(pid)) {
        return { boardIds: ['tdisplay'], via: 'a CH9102 USB bridge' }
      }
      if (pid !== undefined && CH340_PIDS.has(pid)) {
        return { boardIds: ['esp8266'], via: 'a CH340 USB bridge' }
      }
      // Unknown WCH bridge — could be either family.
      return { boardIds: ['tdisplay', 'esp8266'], via: 'a WCH USB bridge' }
    case FTDI:
      return { boardIds: ['esp8266'], via: 'an FTDI USB bridge' }
    default:
      return { boardIds: [], via: '' }
  }
}
