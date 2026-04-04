# Sapwood

Web management UI for the Heartwood ESP32 signing device. Connects directly to the device via Web Serial API (Chrome/Edge). Hosted as a static SPA on GitHub Pages or Hetzner -- no server component needed.

## What it does

- **Masters** -- view provisioned master slots with npubs and modes
- **Clients** -- list, revoke, and update TOFU-approved client policies
- **Firmware** -- OTA firmware updates with SHA-256 verification and progress bar
- **Logs** -- real-time ESP-IDF log output from the device
- **Factory Reset** -- erase all keys and policies (requires physical button confirm)

## Architecture

```
GitHub Pages / Hetzner (static files)
        |
   Browser (Sapwood SPA)
        |
   Web Serial API (Chrome/Edge only)
        |
   ESP32 USB-Serial-JTAG (frame protocol)
```

No bridge or server needed for management. The browser speaks the Heartwood frame protocol directly over USB. The bridge is only needed for relay connectivity (NIP-46 signing over Nostr).

### Frame protocol

TypeScript port of `heartwood-common/src/frame.rs` in `src/lib/frame.ts`. Frame format: `[0x48 0x57] [type_u8] [length_u16_be] [payload...] [crc32_be32]`. CRC32 covers type + length + payload.

The 19 frame.test.ts tests verify byte-level compatibility with the Rust implementation.

### Transport layer

`src/lib/serial.ts` wraps the Web Serial API. It hunts for frame magic bytes in the serial stream, separating ESP-IDF log output from protocol frames. Event-based: components subscribe to frame and log events.

## Build & run

```bash
npm install
npm run dev          # dev server at :5173
npm run build        # production build to dist/ (deploy anywhere)
npm test             # run frame protocol tests
```

## Stack

- **Svelte 5** (runes mode) -- compiles to vanilla JS, no runtime. 21KB gzipped total.
- **Vite** -- build tool
- **TypeScript** -- strict mode
- **Vitest** -- test framework
- **Web Serial API** -- Chrome/Edge 89+

## Security model

Secrets never leave the ESP32. The serial protocol only carries:
- Public keys and npubs (outbound)
- Policy metadata (client pubkeys, labels, methods)
- Unsigned events in, signatures out
- Firmware binary chunks (OTA)

All destructive operations (factory reset, OTA, provisioning) require physical button confirmation on the device. A compromised SPA cannot extract keys or perform destructive actions without physical access to the button.

### Future: Web Bluetooth (portable mode only)

BLE connectivity planned for portable mode (child key only, short range). Additional requirements before shipping BLE:
1. Rate limiting on management frame types in firmware
2. BLE pairing requires button press to accept
3. CSP headers on static hosting

WiFi is never enabled on the ESP32 -- TCP/IP stack is too large an attack surface for a key-holding device.

## Conventions

- British English in all prose, comments, and UI copy
- ESM-only (`"type": "module"`, target ES2022)
- Monospace font throughout (terminal/cockpit feel)
- Dark theme only
- Tone: sovereign, precise, calm. No exclamation marks. State facts.
- Git commits: `type: description` format. No Co-Authored-By lines.

## Ecosystem

| Component | Repo | Role |
|-----------|------|------|
| Heartwood | heartwood-esp32 | ESP32 signing device (firmware + bridge + provision CLI) |
| **Sapwood** | **this repo** | **Web management UI (static SPA, Web Serial)** |
| Bark | bark | Browser extension for NIP-46 signing |
| nsec-tree | nsec-tree | Key derivation library |

## Frame types used

| Frame | Type | Direction | Payload |
|-------|------|-----------|---------|
| PROVISION_LIST | 0x05 | host -> device | (empty) |
| PROVISION_LIST_RESPONSE | 0x07 | device -> host | JSON `Vec<MasterInfo>` |
| FACTORY_RESET | 0x24 | host -> device | (empty, requires button) |
| POLICY_LIST_REQUEST | 0x27 | host -> device | master_slot (1 byte) |
| POLICY_LIST_RESPONSE | 0x28 | device -> host | JSON `Vec<ClientPolicy>` |
| POLICY_REVOKE | 0x29 | host -> device | master_slot (1) + pubkey_hex (64) |
| POLICY_UPDATE | 0x2A | host -> device | master_slot (1) + JSON ClientPolicy |
| OTA_BEGIN | 0x30 | host -> device | size_u32_be + sha256 (requires button) |
| OTA_CHUNK | 0x31 | host -> device | offset_u32_be + data |
| OTA_FINISH | 0x32 | host -> device | (empty) |
| OTA_STATUS | 0x33 | device -> host | status_byte |

## Grant status

Foundation work -- Manages existing shipped functionality. Safe to build regardless of grant status.
