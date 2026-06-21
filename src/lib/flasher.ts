// Browser flasher — the flasher.meshtastic.org / Raspberry Pi Imager model.
// Flashes the device firmware *and* a config blob over Web Serial with
// esptool-js, so the device boots already configured (no separate setup step).
// See heartwood-esp32/docs/2026-06-19-web-flasher-flash-and-configure.md
//
// Flash layout (must match heartwood-esp32 partitions.csv):
//   0x00000  bootloader.bin
//   0x08000  partition-table.bin  (6-entry: nvs/otadata/phy_init/ota_0/ota_1/config)
//   0x10000  app.bin              (ota_0)
//   0x410000 config blob          (config partition; built by buildConfigBlob)
//
// Testability: every side effect (Web Serial port pick, esptool session, firmware
// fetch) is reached through a `FlasherBackend`. The default backend wraps esptool-js
// verbatim; tests inject a fake so the whole flash *sequence* — region offsets,
// full-erase, progress mapping, best-effort reset, error/cleanup paths — is
// exercised without hardware. The esptool-js coupling lives in ONE place below.

import { ESPLoader, Transport } from 'esptool-js'
import type { NetConfig } from './frame'
import { buildConfigBlob } from './flash-config'

export interface BoardSpec {
  id: string
  label: string
  /** path under /firmware where this board's bootloader/table/app live */
  assets: string
  /** flash offset of the `config` partition for this board's table */
  configOffset: number
  /** hint to pre-select from the serial port name */
  portHint: RegExp
}

// Both Heltec boards are ESP32-S3 with the same partition layout; they differ in
// the firmware binary (USB wiring / pin map). config @ 0x410000 (after 2×2MB OTA).
// Reset: esptool-js default_reset works for both — and on the S3 native USB it
// avoids re-enumerating the device mid-flash (which would drop the port handle).
export const BOARDS: BoardSpec[] = [
  { id: 'heltec-v4', label: 'Heltec WiFi LoRa 32 V4', assets: '/firmware/v4', configOffset: 0x410000, portHint: /usbmodem/i },
  { id: 'heltec-v3', label: 'Heltec WiFi LoRa 32 V3', assets: '/firmware/v3', configOffset: 0x410000, portHint: /usbserial|SLAB/i },
]

const FIRMWARE_REGIONS = [
  { file: 'bootloader.bin', address: 0x0, label: 'bootloader' },
  { file: 'partition-table.bin', address: 0x8000, label: 'partition table' },
  { file: 'app.bin', address: 0x10000, label: 'firmware' },
]

const BAUD_RATE = 921600

/** A flash region: raw bytes destined for an absolute flash offset. */
export interface FlashRegion {
  address: number
  data: Uint8Array
}

/** esptool-js's writeFlash progress callback shape. */
export type ReportProgress = (fileIndex: number, written: number, total: number) => void

/** Minimal terminal sink esptool-js logs through. */
export interface FlashTerminal {
  clean(): void
  writeLine(data: string): void
  write(data: string): void
}

/**
 * One esptool session bound to a serial port. Wraps the bits of esptool-js the
 * flash sequence needs, so the orchestration never touches esptool directly.
 */
export interface FlashSession {
  /** Reset into download mode + detect the chip. Returns the chip description. */
  detectChip(): Promise<string>
  /** Erase the entire flash (incl. NVS / master seeds). DESTRUCTIVE. */
  eraseFlash(): Promise<void>
  /** Write all regions, reporting progress per esptool's callback. */
  writeFlash(regions: FlashRegion[], reportProgress: ReportProgress): Promise<void>
  /** Hard-reset into the freshly flashed firmware. Best-effort on S3 native USB. */
  hardReset(): Promise<void>
  /** Release the serial port. Always called, even on error. */
  close(): Promise<void>
}

/**
 * The seam between the flash orchestration and the outside world. The default
 * implementation (`defaultBackend`) is the only code that knows about esptool-js
 * and `navigator.serial`; tests pass a fake.
 */
export interface FlasherBackend {
  hasWebSerial(): boolean
  /** Prompt the user to pick a serial port (must be a user gesture). */
  requestPort(): Promise<unknown>
  /** Fetch a firmware binary by URL. */
  fetchBin(url: string): Promise<Uint8Array>
  /** Open an esptool session on `port`. */
  openSession(port: unknown, opts: { baudrate: number; terminal: FlashTerminal }): Promise<FlashSession>
}

async function fetchBin(url: string): Promise<Uint8Array> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`fetch ${url} failed: ${res.status}`)
  return new Uint8Array(await res.arrayBuffer())
}

/** The production backend: esptool-js over Web Serial. Coupling isolated here. */
export const defaultBackend: FlasherBackend = {
  hasWebSerial: () => typeof navigator !== 'undefined' && 'serial' in navigator,
  requestPort: () => navigator.serial.requestPort(),
  fetchBin,
  async openSession(port, { baudrate, terminal }) {
    const transport = new Transport(port as never, false)
    const esploader = new ESPLoader({ transport, baudrate, terminal })
    // Wrappers normalise esptool-js return types to the FlashSession contract
    // (some of its methods resolve to values we don't use).
    return {
      detectChip: () => esploader.main(),
      eraseFlash: async () => { await esploader.eraseFlash() },
      writeFlash: async (regions, reportProgress) => {
        await esploader.writeFlash({
          fileArray: regions as never,
          flashSize: 'keep',
          flashMode: 'keep',
          flashFreq: 'keep',
          eraseAll: false,
          compress: true,
          reportProgress,
        })
      },
      hardReset: async () => { await esploader.after('hard_reset') },
      close: async () => { await transport.disconnect() },
    }
  },
}

export interface FlashHandlers {
  onLog?: (line: string) => void
  onProgress?: (pct: number, stage: string) => void
  /**
   * Erase the *entire* flash (incl. the NVS partition holding provisioned
   * master seeds) before writing. Needed for a clean slate: a re-flash with
   * `eraseAll: false` keeps any existing master, which makes the device boot
   * straight into wifi-standalone mode and refuse USB provisioning. Wipe first
   * and the device boots into provision-wait mode instead. DESTRUCTIVE.
   */
  fullErase?: boolean
}

/**
 * Flash `board` with its firmware plus a `config` blob built from `cfg`, over
 * Web Serial. Prompts the user to pick the serial port (must be a user gesture).
 * The device boots already configured.
 *
 * `backend` is injectable purely for testing; production always uses esptool-js.
 */
export async function flashDevice(
  board: BoardSpec,
  cfg: NetConfig,
  h: FlashHandlers = {},
  backend: FlasherBackend = defaultBackend,
): Promise<void> {
  if (!backend.hasWebSerial()) {
    throw new Error('Web Serial unavailable — use Chrome or Edge.')
  }
  const log = (s: string) => h.onLog?.(s.replace(/\s+$/, ''))

  // 1. Fetch firmware binaries for the selected board.
  log(`Fetching firmware for ${board.label}…`)
  const regions: FlashRegion[] = await Promise.all(
    FIRMWARE_REGIONS.map(async (r) => ({ address: r.address, data: await backend.fetchBin(`${board.assets}/${r.file}`) })),
  )
  const labels = FIRMWARE_REGIONS.map((r) => r.label)

  // 2. Build the config blob and append it at the config-partition offset.
  const configBlob = buildConfigBlob(cfg)
  regions.push({ address: board.configOffset, data: configBlob })
  labels.push('config')
  log(`Config blob: ${configBlob.length} bytes → 0x${board.configOffset.toString(16)}`)

  // 3. Ask for the serial port and open an esptool session.
  log('Select the device serial port…')
  const port = await backend.requestPort()
  const terminal: FlashTerminal = {
    clean() {},
    writeLine: (data: string) => log(data),
    write: (data: string) => log(data),
  }
  const session = await backend.openSession(port, { baudrate: BAUD_RATE, terminal })

  try {
    const chip = await session.detectChip() // reset into download mode + detect chip
    log(`Connected: ${chip}`)

    // 3a. Optional full chip erase — wipes NVS (master seeds) for a clean slate
    // so the device boots into provision-wait mode rather than reusing an old
    // master. Slow (whole flash), so it gets its own indeterminate progress.
    if (h.fullErase) {
      log('Full erase requested — wiping entire flash (incl. master seeds)…')
      h.onProgress?.(0, 'erasing flash')
      await session.eraseFlash()
      log('Flash erased — device will boot fresh.')
    }

    // 4. Flash all regions; report smooth overall progress across them.
    await session.writeFlash(regions, (fileIndex, written, total) => {
      const frac = (fileIndex + (total ? written / total : 0)) / regions.length
      h.onProgress?.(Math.round(frac * 100), labels[fileIndex] ?? `region ${fileIndex + 1}`)
    })

    // Reset into the new firmware. On the S3's native USB-Serial-JTAG the
    // auto-reset is unreliable (no real DTR/RTS lines), so treat it as
    // best-effort: the flash itself already succeeded. The caller tells the
    // user to press RESET / replug if the device doesn't reboot on its own.
    log('Flash complete — resetting…')
    try {
      await session.hardReset()
      log('Reset sent. If the device does not reboot, press its RESET button (or unplug/replug).')
    } catch (e) {
      log(`Auto-reset failed (${e instanceof Error ? e.message : e}). Press RESET on the device (or unplug/replug) to boot the new firmware.`)
    }
    h.onProgress?.(100, 'done')
  } finally {
    try {
      await session.close()
    } catch {
      /* ignore */
    }
  }
}
