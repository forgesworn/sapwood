// The app-only USB update (esptool, single-slot boards) as app-level state.
//
// The flasher needs the port to itself, so the update starts by closing the
// console's serial session. That flips device.connected, App swaps the device
// panel for the connection picker, and OtaUpdate unmounts: progress kept in
// the component went with it, and the write carried on with nothing on screen
// (and nothing on the signer either, whose app is not running while the ROM
// loader rewrites it). Holding the run here lets App show it while no device
// is connected, and OtaUpdate pick it up again after the reconnect.

import { flashAppOnly, type BoardSpec, type FlasherBackend } from './flasher'

export type UsbUpdateStatus = 'idle' | 'waiting' | 'uploading' | 'done' | 'error'

export const usbUpdate = $state({
  status: 'idle' as UsbUpdateStatus,
  progress: 0,
  message: '',
  /** The version the last successful run wrote, until the signer reports it. */
  installedVersion: null as string | null,
  /** The board the last run wrote, so the RESET step can name its button. */
  board: null as { id: string; label: string } | null,
})

/** A run is in flight. */
export function usbUpdateBusy(): boolean {
  return usbUpdate.status === 'waiting' || usbUpdate.status === 'uploading'
}

/** Forget a finished run's outcome (the banner's dismiss). */
export function clearUsbUpdate(): void {
  if (usbUpdateBusy()) return
  usbUpdate.status = 'idle'
  usbUpdate.progress = 0
  usbUpdate.message = ''
}

export interface UsbUpdateOptions {
  /** The version being written, for the success message. */
  version: string | null
  /** Close the console's serial session first (the flasher needs the port). */
  release?: () => Promise<void>
  backend?: FlasherBackend
}

/**
 * Write `board`'s bundled app over USB, keeping the outcome in [`usbUpdate`].
 * Never throws: a failure lands in `usbUpdate` as status 'error'.
 */
export async function runUsbUpdate(board: BoardSpec, opts: UsbUpdateOptions): Promise<void> {
  if (usbUpdateBusy()) return
  usbUpdate.status = 'waiting'
  usbUpdate.progress = 0
  usbUpdate.installedVersion = null
  usbUpdate.board = { id: board.id, label: board.label }
  usbUpdate.message = 'Pick the signer in the browser port chooser…'
  try {
    await opts.release?.()
    await flashAppOnly(board, {
      // The stretches without byte counts (port, download, partition table
      // read, reset) would otherwise show nothing at all.
      onLog: (line) => {
        if (usbUpdate.status === 'waiting' && line.trim()) usbUpdate.message = line.trim()
      },
      onProgress: (pct, stage) => {
        if (stage === 'done') return
        usbUpdate.status = 'uploading'
        usbUpdate.progress = pct
        usbUpdate.message = `Writing firmware… ${pct}%. The signer's screen stays dark or frozen until it restarts; leave the cable in.`
      },
    }, opts.backend)
    usbUpdate.status = 'done'
    usbUpdate.progress = 100
    usbUpdate.installedVersion = opts.version
    // Written is not running: the RESET step (ResetCallout) is shown beside
    // this, since esptool's automatic reset does not take on every board.
    usbUpdate.message = opts.version
      ? `Firmware v${opts.version} is written. Identity and settings were kept. Press RESET on the board, then reconnect.`
      : 'The firmware is written. Identity and settings were kept. Press RESET on the board, then reconnect.'
  } catch (e) {
    usbUpdate.status = 'error'
    usbUpdate.message = e instanceof Error ? e.message : 'The update could not be completed.'
  }
}
