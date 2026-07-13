// Browser flasher — the flasher.meshtastic.org / Raspberry Pi Imager model.
// Flashes device firmware over Web Serial with esptool-js. Firmware-only
// flashes preserve the config partition by default; the guided setup wizard
// explicitly opts in to writing a config blob so a new device boots already
// configured (no separate network setup step).
// See heartwood-esp32/docs/2026-06-19-web-flasher-flash-and-configure.md
//
// Flash layout (must match the board's heartwood-esp32 partition table). The
// partition table (0x08000) and the first app slot (0x10000) are the same across
// our layouts; the bootloader and config offsets vary BY BOARD (see BoardSpec):
//   bootloader.bin   0x00000 on S3/C6, 0x01000 on the classic ESP32 (T-Display)
//   partition-table  0x08000
//   app.bin          0x10000  (ota_0 on heltec's 2 MB A/B layout; factory on 4 MB)
//   config blob      board.configOffset  (optional; setup/reconfigure only)
//                    (0x410000 heltec / 0x310000 the 4 MB boards)
//
// Testability: every side effect (Web Serial port pick, esptool session, firmware
// fetch) is reached through a `FlasherBackend`. The default backend wraps esptool-js
// verbatim; tests inject a fake so the whole flash *sequence* — region offsets,
// full-erase, progress mapping, best-effort reset, error/cleanup paths — is
// exercised without hardware. The esptool-js coupling lives in ONE place below.

import { ESPLoader, Transport } from 'esptool-js'
import { ed25519 } from '@noble/curves/ed25519.js'
import type { NetConfig } from './frame'
import { buildConfigBlob } from './flash-config'
import { releaseGrantedPorts } from './serial-ports'

export interface BoardSpec {
  id: string
  label: string
  /** path under /firmware where this board's bootloader/table/app live */
  assets: string
  /** flash offset of the `config` partition for this board's table */
  configOffset: number
  /**
   * Flash offset of the bootloader. The classic ESP32 (and S2) load it from
   * 0x1000; the S3/C6 and other newer chips from 0x0. Omitted ⇒ 0x0.
   */
  bootloaderOffset?: number
  /** hint to pre-select from the serial port name */
  portHint: RegExp
}

// The supported Wi-Fi signer boards. heltec-v3/v4 are ESP32-S3 (2 MB A/B OTA;
// config @ 0x410000; bootloader @ 0x0). tdisplay is a CLASSIC ESP32 — its
// bootloader loads from 0x1000, not 0x0 — and c6 is a RISC-V ESP32-C6; both use
// the 4 MB single-factory layout (config @ 0x310000, no OTA). heltec-v4 MUST stay
// first: it is the default selection in Flash.svelte and the Flasher test picks it.
//
// The esp8266 signer is deliberately NOT here: it has no Wi-Fi and no config
// partition (it is a USB-tethered signer flashed as ONE image at 0x0 and
// provisioned over serial), so it does not fit this flash-and-configure wizard.
// Its image still ships in /firmware/esp8266; see esp8266-firmware/FLASHING.md.
export const BOARDS: BoardSpec[] = [
  { id: 'heltec-v4', label: 'Heltec WiFi LoRa 32 V4', assets: '/firmware/v4', configOffset: 0x410000, portHint: /usbmodem/i },
  { id: 'heltec-v3', label: 'Heltec WiFi LoRa 32 V3', assets: '/firmware/v3', configOffset: 0x410000, portHint: /usbserial|SLAB/i },
  { id: 'tdisplay', label: 'LilyGO T-Display (ESP32)', assets: '/firmware/tdisplay', configOffset: 0x310000, bootloaderOffset: 0x1000, portHint: /wchusb|usbserial|CH9102/i },
  { id: 'c6', label: 'Waveshare ESP32-C6 (LCD 1.47)', assets: '/firmware/c6', configOffset: 0x310000, portHint: /usbmodem|wchusb|usbserial/i },
]

// The USB-tethered ESP8266 signer — kept apart from BOARDS because it is NOT a
// flash-and-configure WiFi board. It flashes as ONE image at 0x0 (the esp8266
// `elf2image` output — no bootloader/partition/config partition) and is set up
// over serial + the bridge, not the wizard's network step. `configOffset` /
// `bootloaderOffset` do not apply to it (see `flashTetheredImage`).
export const TETHERED_BOARDS: BoardSpec[] = [
  {
    id: 'esp8266',
    label: 'ESP8266 tethered signer',
    assets: '/firmware/esp8266',
    configOffset: 0,
    portHint: /wchusb|usbserial|ttyusb|cu\.usb/i,
  },
]

// The esp-idf image set for a board. The bootloader offset is chip-dependent
// (0x1000 on the classic ESP32, 0x0 on S3/C6); the partition table (0x8000) and
// first app slot (0x10000) are identical across our 2 MB and 4 MB layouts.
function firmwareRegions(board: BoardSpec) {
  return [
    { file: 'bootloader.bin', address: board.bootloaderOffset ?? 0x0, label: 'bootloader' },
    { file: 'partition-table.bin', address: 0x8000, label: 'partition table' },
    { file: 'app.bin', address: 0x10000, label: 'firmware' },
  ]
}

// 460800 is the highest rate that works reliably across CH9102, CH340, and
// CP210x adapters. 921600 stalls silently on CH9102 (VID 0x1a86) after the
// stub switches speed, before any flash write begins.
const BAUD_RATE = 460800

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
  /** Fetch the served firmware manifest (for the integrity check). */
  fetchManifest(): Promise<FirmwareManifest>
  /** Open an esptool session on `port`. */
  openSession(port: unknown, opts: { baudrate: number; terminal: FlashTerminal }): Promise<FlashSession>
}

// The served firmware manifest (public/firmware/version.json, written by
// heartwood-esp32's sync-firmware). The per-board app SHA-256 guards freshness
// and corruption; the Ed25519 release signature authenticates the image against
// the pinned Heartwood release key below before any bytes are flashed.
export interface FirmwareManifest {
  version?: string
  builtAt?: string
  boards?: Record<string, { app?: string; sha256?: string; bytes?: number; ota?: boolean; signature?: string }>
}

/** Absolute path to the served firmware manifest. */
const MANIFEST_URL = '/firmware/version.json'
const OTA_RELEASE_PUBKEY_HEX = '3cdfa635d0a058119b412999f061870e7e0a6d41df5deffadb0c1ff4a9d339b7'
const OTA_SIGNING_DOMAIN = new TextEncoder().encode('heartwood-ota-v1')
const OTA_RELEASE_PUBKEY = hexToBytes(OTA_RELEASE_PUBKEY_HEX, 'OTA release public key', 32)

function hexToBytes(hex: string, label: string, expectedLength?: number): Uint8Array {
  if (!/^[0-9a-f]+$/i.test(hex) || hex.length % 2 !== 0) {
    throw new Error(`${label} is not valid hex.`)
  }
  const bytes = new Uint8Array(hex.length / 2)
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  if (expectedLength !== undefined && bytes.length !== expectedLength) {
    throw new Error(`${label} must be ${expectedLength} bytes, got ${bytes.length}.`)
  }
  return bytes
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

function otaSigningBoardId(boardId: string): string {
  // The UI calls the Waveshare board "c6"; firmware signs with board::BOARD.
  return boardId === 'c6' ? 'esp32c6' : boardId
}

function otaSigningMessage(boardId: string, digest: Uint8Array): Uint8Array {
  const board = new TextEncoder().encode(otaSigningBoardId(boardId))
  const msg = new Uint8Array(OTA_SIGNING_DOMAIN.length + 1 + board.length + 1 + digest.length)
  let off = 0
  msg.set(OTA_SIGNING_DOMAIN, off); off += OTA_SIGNING_DOMAIN.length
  msg[off++] = 0
  msg.set(board, off); off += board.length
  msg[off++] = 0
  msg.set(digest, off)
  return msg
}

// Firmware images are fetched `no-store`: the browser otherwise heuristically
// disk-caches the large app.bin, so a re-flash after an update silently writes
// the OLD image (there is no service worker; version.json revalidates via etag,
// app.bin does not). `no-store` guarantees fresh bytes on every flash.
async function fetchBin(url: string): Promise<Uint8Array> {
  const res = await fetch(url, { cache: 'no-store' })
  if (!res.ok) throw new Error(`fetch ${url} failed: ${res.status}`)
  return new Uint8Array(await res.arrayBuffer())
}

async function fetchManifest(): Promise<FirmwareManifest> {
  const res = await fetch(MANIFEST_URL, { cache: 'no-store' })
  if (!res.ok) throw new Error(`fetch ${MANIFEST_URL} failed: ${res.status}`)
  return (await res.json()) as FirmwareManifest
}

/** SHA-256 of `data` as lowercase hex. */
async function sha256Bytes(data: Uint8Array): Promise<Uint8Array> {
  // Copy into a fresh ArrayBuffer so digest() gets a concrete BufferSource
  // (a Uint8Array may be a view over a larger/offset buffer).
  const buf = new ArrayBuffer(data.byteLength)
  new Uint8Array(buf).set(data)
  const digest = await crypto.subtle.digest('SHA-256', buf)
  return new Uint8Array(digest)
}

/**
 * Fail loudly if the fetched app image doesn't match the manifest's SHA-256 or
 * if the release signature doesn't verify with the pinned public key. This is a
 * hard gate: an unavailable/stale manifest, missing signature, wrong board id or
 * tampered image aborts before the esptool session opens.
 */
async function verifyAppIntegrity(
  manifest: FirmwareManifest,
  boardId: string,
  appData: Uint8Array,
  log: (s: string) => void,
): Promise<void> {
  const meta = manifest.boards?.[boardId]
  const expected = meta?.sha256
  if (!expected) {
    throw new Error(`Firmware manifest has no SHA-256 for ${boardId}; refusing to flash unsigned bytes.`)
  }
  const digest = await sha256Bytes(appData)
  const actual = bytesToHex(digest)
  if (actual !== expected) {
    throw new Error(
      `Firmware integrity check failed for ${boardId}: expected ${expected.slice(0, 16)}…, got ${actual.slice(0, 16)}…. ` +
        'This usually means a stale cached download — hard-refresh (Cmd/Ctrl+Shift+R) and flash again.',
    )
  }
  if (!meta?.signature) {
    throw new Error(`Firmware manifest has no release signature for ${boardId}; refusing to flash unsigned firmware.`)
  }
  const signature = hexToBytes(meta.signature, 'Firmware release signature', 64)
  let ok = false
  try {
    ok = ed25519.verify(signature, otaSigningMessage(boardId, digest), OTA_RELEASE_PUBKEY)
  } catch {
    ok = false
  }
  if (!ok) {
    throw new Error(`Firmware release signature failed for ${boardId}; refusing to flash this image.`)
  }
  log(`Firmware verified (sha256 ${actual.slice(0, 16)}…, signed for ${otaSigningBoardId(boardId)}).`)
}

/** The production backend: esptool-js over Web Serial. Coupling isolated here. */
export const defaultBackend: FlasherBackend = {
  hasWebSerial: () => typeof navigator !== 'undefined' && 'serial' in navigator,
  requestPort: () => navigator.serial.requestPort(),
  fetchBin,
  fetchManifest,
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
  /**
   * Write `cfg` into the board's config partition. This is deliberately opt-in:
   * a firmware update/re-flash must preserve the existing Wi-Fi, relays, mode
   * and operator unless the caller is explicitly running setup/reconfigure.
   * Required with `fullErase`, because a whole-chip erase destroys config.
   */
  writeConfig?: boolean
}

/**
 * Flash `board` over Web Serial. By default only firmware regions are written,
 * preserving the existing config partition. Pass `writeConfig: true` to append
 * a config blob built from `cfg` during explicit setup/reconfiguration.
 * Prompts the user to pick the serial port (must be a user gesture).
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
  if (h.fullErase && !h.writeConfig) {
    throw new Error('A full erase destroys device configuration; enable writeConfig to install replacement settings.')
  }
  const log = (s: string) => h.onLog?.(s.replace(/\s+$/, ''))

  // 1. Ask for the serial port FIRST, before any other await. requestPort() must
  //    run within the click's user-gesture activation; fetching the firmware
  //    first (a multi-MB download) consumes the activation, and Chrome then
  //    rejects requestPort with "Must be handling a user gesture".
  log('Select the device serial port…')
  const port = await backend.requestPort()

  // Close any port left open by a previous flash (or an ESP32-S3 USB
  // re-enumeration after reset) before esptool opens this one — without this,
  // the open fails with "port in use" until the device is unplugged. Run AFTER
  // requestPort so its awaits don't consume the click's user-gesture activation.
  await releaseGrantedPorts()

  // 2. Fetch firmware binaries for the selected board (bootloader offset is
  //    per-board: 0x1000 on the classic ESP32, 0x0 on S3/C6).
  log(`Fetching firmware for ${board.label}…`)
  const fwRegions = firmwareRegions(board)
  const regions: FlashRegion[] = await Promise.all(
    fwRegions.map(async (r) => ({ address: r.address, data: await backend.fetchBin(`${board.assets}/${r.file}`) })),
  )
  const labels = fwRegions.map((r) => r.label)

  // 2a. Verify the app image against the signed manifest before touching the
  //     device. A stale/corrupt/tampered app.bin must never reach flash.
  const manifest = await backend.fetchManifest().catch((e) => {
    throw new Error(`Firmware manifest unavailable: ${e instanceof Error ? e.message : e}`)
  })
  await verifyAppIntegrity(manifest, board.id, regions[fwRegions.findIndex((r) => r.file === 'app.bin')].data, log)

  // 3. Config is a separate trust/configuration boundary. Ordinary firmware
  // updates leave the partition untouched; only explicit setup/reconfigure
  // appends a replacement blob.
  if (h.writeConfig) {
    const configBlob = buildConfigBlob(cfg)
    regions.push({ address: board.configOffset, data: configBlob })
    labels.push('config')
    log(`Config blob: ${configBlob.length} bytes → 0x${board.configOffset.toString(16)}`)
  } else {
    log('Config partition preserved (Wi-Fi, relays, mode and operator unchanged).')
  }

  // 4. Open an esptool session on the chosen port.
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

    // 4. Flash all regions; report progress weighted by BYTES, not region count.
    //    The bootloader (~21KB) and partition table (~3KB) flash in a blink but
    //    are 2 of 3 firmware regions (4 during setup), so per-region weighting
    //    jumped the bar far ahead before the ~1.8MB app.bin had really started.
    //    Byte-weighting makes the big app
    //    dominate the bar, as the user expects.
    const sizes = regions.map((r) => r.data.length)
    const totalBytes = sizes.reduce((a, b) => a + b, 0) || 1
    const bytesBefore = sizes.map((_, i) => sizes.slice(0, i).reduce((a, b) => a + b, 0))
    await session.writeFlash(regions, (fileIndex, written, total) => {
      const regionFrac = total > 0 ? written / total : 0
      const done = (bytesBefore[fileIndex] ?? 0) + regionFrac * (sizes[fileIndex] ?? 0)
      h.onProgress?.(Math.round((done / totalBytes) * 100), labels[fileIndex] ?? `region ${fileIndex + 1}`)
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

/**
 * Flash a USB-tethered signer (the ESP8266): a SINGLE image at 0x0 — the esp8266
 * `elf2image` output, which already bundles the bootloader stub. No partition
 * table and no config blob (the device is provisioned over serial + bridged, not
 * configured at flash time). Otherwise mirrors `flashDevice`'s esptool session.
 */
export async function flashTetheredImage(
  board: BoardSpec,
  h: FlashHandlers = {},
  backend: FlasherBackend = defaultBackend,
): Promise<void> {
  if (!backend.hasWebSerial()) {
    throw new Error('Web Serial unavailable — use Chrome or Edge.')
  }
  const log = (s: string) => h.onLog?.(s.replace(/\s+$/, ''))

  // requestPort FIRST (preserve the click's user gesture), then release any
  // stale port — exactly as flashDevice does.
  log('Select the device serial port…')
  const port = await backend.requestPort()
  await releaseGrantedPorts()

  log(`Fetching firmware for ${board.label}…`)
  const data = await backend.fetchBin(`${board.assets}/app.bin`)
  const manifest = await backend.fetchManifest().catch((e) => {
    throw new Error(`Firmware manifest unavailable: ${e instanceof Error ? e.message : e}`)
  })
  await verifyAppIntegrity(manifest, board.id, data, log)
  const regions: FlashRegion[] = [{ address: 0x0, data }]

  const terminal: FlashTerminal = {
    clean() {},
    writeLine: (d: string) => log(d),
    write: (d: string) => log(d),
  }
  const session = await backend.openSession(port, { baudrate: BAUD_RATE, terminal })

  try {
    const chip = await session.detectChip()
    log(`Connected: ${chip}`)

    if (h.fullErase) {
      log('Full erase requested — wiping entire flash…')
      h.onProgress?.(0, 'erasing flash')
      await session.eraseFlash()
      log('Flash erased.')
    }

    const total = data.length || 1
    await session.writeFlash(regions, (_fileIndex, written, regionTotal) => {
      const frac = regionTotal > 0 ? written / regionTotal : written / total
      h.onProgress?.(Math.round(frac * 100), 'firmware')
    })

    log('Flash complete — resetting…')
    try {
      await session.hardReset()
      log('Reset sent. If the device does not reboot, press its RESET button (or unplug/replug).')
    } catch (e) {
      log(`Auto-reset failed (${e instanceof Error ? e.message : e}). Press RESET on the device (or unplug/replug).`)
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
