// Bridge setup help for the USB-tethered ESP8266 signer.
//
// The ESP8266 has no WiFi: it answers NIP-46 over Nostr relays only because a
// `heartwood-bridge` daemon (on a Pi or other always-on host) couriers traffic
// across the USB serial link. That daemon needs a small data dir — three files —
// which this module renders as copy-paste text. We cannot create them from the
// browser (they live on the user's host), so the tethered wizard SHOWS them and
// the run command; the user pastes them on their Pi.
//
// The `bridge.secret` here MUST be the same 32 bytes written to the device with
// SET_BRIDGE_SECRET (frame 0x23) — that shared secret is what authenticates the
// daemon↔device session. See heartwood-esp32/esp8266-firmware/FLASHING.md §6.

/** Inputs for the bridge data dir. */
export interface BridgeConfig {
  /** The serial device path ON THE BRIDGE HOST (e.g. the Pi: /dev/ttyUSB0), NOT
   *  this browser's port. */
  devicePort: string
  /** The 32-byte bridge secret as 64 lowercase hex chars — the SAME value
   *  written to the device with SET_BRIDGE_SECRET. */
  secretHex: string
  /** Relays the bridge subscribes for this signer. */
  relays: string[]
  /** Where the bridge keeps this signer's data (one dir per tethered signer). */
  dataDir?: string
}

export interface BridgeArtifacts {
  dataDir: string
  /** `master.payload` content — tells the bridge this is an HSM-mode signer on a port. */
  masterPayload: string
  /** `config.json` content (pretty-printed). */
  configJson: string
  /** `bridge.secret` content (the hex secret). */
  secretHex: string
  /** A copy-paste shell block that creates the dir + all three files. */
  setupScript: string
  /** The command to run the bridge against this data dir. */
  runCommand: string
}

const DEFAULT_DATA_DIR = '/var/lib/heartwood/esp8266'

/** True for a 64-char lowercase-hex string (a 32-byte secret). */
function isHex32(s: string): boolean {
  return /^[0-9a-f]{64}$/.test(s)
}

/** Generate a fresh 32-byte bridge secret as 64 lowercase hex chars. */
export function generateBridgeSecret(): string {
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/**
 * Render the `heartwood-bridge` data dir + run command for a tethered signer.
 * Pure: no I/O, deterministic for given inputs. Throws on a malformed secret or
 * empty relay list so a bad setup fails here, not silently on the Pi.
 */
export function bridgeArtifacts(cfg: BridgeConfig): BridgeArtifacts {
  if (!isHex32(cfg.secretHex)) {
    throw new Error('bridge secret must be 64 lowercase hex characters (32 bytes)')
  }
  const relays = cfg.relays.map((r) => r.trim()).filter(Boolean)
  if (relays.length === 0) {
    throw new Error('at least one relay is required so the signer can be reached')
  }
  if (!cfg.devicePort.trim()) {
    throw new Error('the bridge host serial port is required (e.g. /dev/ttyUSB0)')
  }

  const dataDir = (cfg.dataDir || DEFAULT_DATA_DIR).trim()
  const devicePort = cfg.devicePort.trim()
  const masterPayload = `hsm:${devicePort}`
  const configJson = JSON.stringify({ relays }, null, 2)

  // A heredoc for config.json keeps its JSON intact; printf for the single-line
  // files avoids a trailing newline the firmware/daemon don't expect.
  const setupScript = [
    `sudo mkdir -p ${dataDir}`,
    `printf '%s' '${masterPayload}' | sudo tee ${dataDir}/master.payload >/dev/null`,
    `printf '%s' '${cfg.secretHex}' | sudo tee ${dataDir}/bridge.secret >/dev/null`,
    `sudo tee ${dataDir}/config.json >/dev/null <<'JSON'`,
    configJson,
    'JSON',
  ].join('\n')

  const runCommand = `sudo HEARTWOOD_DATA_DIR=${dataDir} RUST_LOG=info heartwood-bridge`

  return { dataDir, masterPayload, configJson, secretHex: cfg.secretHex, setupScript, runCommand }
}
