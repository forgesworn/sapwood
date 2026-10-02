// The reset that boots a freshly flashed board into its new firmware.
//
// esptool-js's HardReset (0.5 to 0.7 at least) only ever drives RTS low. It
// leaves out the RTS-high step Python esptool does first, so EN is never
// pulled low and nothing resets: a board the flash left in the ROM loader
// stays there, screen dark, until someone presses RESET. Bench, 2026-10-02,
// T-Display (CH9102): after esptool-js's sequence the ROM printed nothing and
// the firmware answered 0 of 10 queries; with the pulse below it booted
// SPI_FAST_FLASH_BOOT and answered 10 of 10. Field report the same day: a
// tester updated over USB and the board never restarted.

/** The two control lines, as esptool-js's Transport exposes them. */
export interface ResetLines {
  setDTR(state: boolean): Promise<void>
  setRTS(state: boolean): Promise<void>
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

/** Python esptool's HardReset: EN low then high, with IO0 left high so the
 *  chip boots its app rather than the loader. `nativeUsb` (USB-Serial-JTAG or
 *  USB-OTG) takes esptool's longer holds. */
export class PulsedHardReset<T extends ResetLines> {
  constructor(public transport: T, private nativeUsb = false) {}

  async reset(): Promise<void> {
    await this.transport.setDTR(false) // IO0 high: run the app, not the loader
    await this.transport.setRTS(true) // EN low: hold the chip in reset
    await sleep(this.nativeUsb ? 200 : 100)
    await this.transport.setRTS(false) // EN high: boot
    if (this.nativeUsb) await sleep(200)
  }
}
