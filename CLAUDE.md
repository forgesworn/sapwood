# Sapwood

Web management UI for the Heartwood ESP32 signing device. Connects directly to the device via Web Serial API (Chrome/Edge). Hosted as a static SPA on GitHub Pages or Hetzner -- no server component needed.

## What it does

Two surfaces: a guided **Home** (signer card, connect-an-app flow, connected apps with inline permissions, operator-key backup nudge, firmware nudge, phone handoff) and an **Advanced console** with four sections:

- **Apps** -- create connections, approve/revoke apps, per-kind signing permissions (one surface for USB, WiFi and bridge transports); when the signer holds more than one identity, an identity picker chooses which one new connections bind to
- **Identity** -- identities (master slots) on the signer, add-identity (provision, including derive-by-name: the signer derives the nsec-tree child from a master it already holds via DERIVE_IDENTITY 0x60, no secret in the browser; browser-side phrase/nsec derivation is the fallback for older firmware), identity-card sync, NIP-05 short-address generator (nostr.json for bunker discovery), operator key, profile relays
- **Device** -- connection info, network mode, OTA firmware updates (SHA-256 verified), security (boot PIN, bridge secret), bridge control, danger zone (disconnect all apps, factory reset -- physical button confirm)
- **Logs** -- real-time ESP-IDF log output from the device

UI copy says "apps" and "identities"; code and the wire protocol keep the frame/struct names (clients, masters, slots). Shared design primitives (buttons, cards, fields, tags) live in `src/app.css`; components keep only layout in scoped styles.

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

`src/lib/serial.ts` wraps the Web Serial API. Event-based: components subscribe to frame and log events. The byte-stream splitting (frame magic hunting, log-line separation) lives in `src/lib/frame-stream.ts`, and the UART write pacing in `src/lib/pacing.ts`; both are shared with the CLI.

### Command line (`cli/`)

`sapwood` — the console as a cross-platform CLI (Linux/macOS/Windows, Node 20+) over node-serialport. Shares `src/lib` (frame, frame-stream, pacing, ota, types); its own transport is `cli/transport.ts`, commands in `cli/commands.ts` (pure, tested against a fake transport). Build with `npm run build:cli` (esbuild bundle to `dist-cli/sapwood.mjs`, serialport external), typecheck with `npm run check:cli`. Commands: ports, device, identities, identities remove, derive, apps, apps revoke, logs, firmware update, key backup (offline nsec/ncryptsec -> 24 words, no device). `--json` everywhere. Same security model: management frames only, button gates destructive operations.

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

### Network tiers

- **WiFi-standalone (standard)** -- the signer joins the user's WiFi and serves NIP-46 over relays itself. Convenient, manageable from anywhere, no extra software. This is what the guided flasher produces by default.
- **USB-only, radio off (hardened)** -- no network stack runs on the key-holding chip at all; its remote attack surface is zero. Remote signing requires the heartwood bridge daemon on an always-on host with the signer plugged in. Presented as the advanced option in the flasher and the Device > Network panel.

Regardless of tier, firmware updates, factory reset and PIN changes always require the USB cable -- deliberate physical-presence gates. Identity management works over WiFi too: derive-by-name sends no secret at all (the signer holds the root), and importing a phrase/nsec/ncryptsec travels NIP-44 encrypted end-to-end under the operator-signer conversation key, so relays only ever carry ciphertext.

### Future: Web Bluetooth (portable mode only)

BLE connectivity planned for portable mode (child key only, short range). Additional requirements before shipping BLE:
1. Rate limiting on management frame types in firmware
2. BLE pairing requires button press to accept
3. CSP headers on static hosting

## Conventions

- British English in all prose, comments, and UI copy
- ESM-only (`"type": "module"`, target ES2022)
- Monospace font throughout (terminal/cockpit feel)
- Dark theme only
- Tone: sovereign, precise, calm. No exclamation marks. State facts.
- No em dashes in UI copy: use a full stop, comma or colon instead. (A bare "--" as an empty-value placeholder in tables is fine.)
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
| PROVISION_REMOVE | 0x04 | host -> device | slot_u8 (ACK, then device reboots; remaining slots renumber) |
| PROVISION_LIST | 0x05 | host -> device | (empty) |
| PROVISION_LIST_RESPONSE | 0x07 | device -> host | JSON `Vec<MasterInfo>` (masters, then derived personas with `persona: true`) |
| DERIVE_IDENTITY | 0x60 | host -> device | parent_slot (1) + name utf8; device derives the nsec-tree child on-device |
| DERIVE_IDENTITY_RESPONSE | 0x61 | device -> host | JSON `{slot, label, npub, parent_slot, purpose, existing}` |
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

Foundation work. Manages existing shipped functionality.
