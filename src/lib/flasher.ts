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

async function fetchBin(url: string): Promise<Uint8Array> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`fetch ${url} failed: ${res.status}`)
  return new Uint8Array(await res.arrayBuffer())
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
 */
export async function flashDevice(board: BoardSpec, cfg: NetConfig, h: FlashHandlers = {}): Promise<void> {
  if (!('serial' in navigator)) {
    throw new Error('Web Serial unavailable — use Chrome or Edge.')
  }
  const log = (s: string) => h.onLog?.(s.replace(/\s+$/, ''))

  // 1. Fetch firmware binaries for the selected board.
  log(`Fetching firmware for ${board.label}…`)
  const regions: { address: number; data: Uint8Array }[] = await Promise.all(
    FIRMWARE_REGIONS.map(async (r) => ({ address: r.address, data: await fetchBin(`${board.assets}/${r.file}`) })),
  )
  const labels = FIRMWARE_REGIONS.map((r) => r.label)

  // 2. Build the config blob and append it at the config-partition offset.
  const configBlob = buildConfigBlob(cfg)
  regions.push({ address: board.configOffset, data: configBlob })
  labels.push('config')
  log(`Config blob: ${configBlob.length} bytes → 0x${board.configOffset.toString(16)}`)

  // 3. Ask for the serial port and connect with esptool-js.
  log('Select the device serial port…')
  const port = await navigator.serial.requestPort()
  const transport = new Transport(port, false)
  const terminal = {
    clean() {},
    writeLine: (data: string) => log(data),
    write: (data: string) => log(data),
  }
  const esploader = new ESPLoader({ transport, baudrate: 921600, terminal })

  try {
    const chip = await esploader.main() // reset into download mode + detect chip
    log(`Connected: ${chip}`)

    // 3a. Optional full chip erase — wipes NVS (master seeds) for a clean slate
    // so the device boots into provision-wait mode rather than reusing an old
    // master. Slow (whole flash), so it gets its own indeterminate progress.
    if (h.fullErase) {
      log('Full erase requested — wiping entire flash (incl. master seeds)…')
      h.onProgress?.(0, 'erasing flash')
      await esploader.eraseFlash()
      log('Flash erased — device will boot fresh.')
    }

    // 4. Flash all regions; report smooth overall progress across them.
    await esploader.writeFlash({
      fileArray: regions,
      flashSize: 'keep',
      flashMode: 'keep',
      flashFreq: 'keep',
      eraseAll: false,
      compress: true,
      reportProgress: (fileIndex, written, total) => {
        const frac = (fileIndex + (total ? written / total : 0)) / regions.length
        h.onProgress?.(Math.round(frac * 100), labels[fileIndex] ?? `region ${fileIndex + 1}`)
      },
    })
    log('Flash complete — resetting…')
    await esploader.after('hard_reset')
    h.onProgress?.(100, 'done')
  } finally {
    try {
      await transport.disconnect()
    } catch {
      /* ignore */
    }
  }
}
