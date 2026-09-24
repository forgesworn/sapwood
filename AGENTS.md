# Sapwood

Web management UI for the Heartwood ESP32 signing device. Connects directly to the device via the Web Serial API (Chrome/Edge) for local USB management, or remotely over authenticated Nostr relays once the device is online in WiFi-standalone mode. Hosted as a static SPA on GitHub Pages or Hetzner; no server component needed. The same functionality is also available as a cross-platform CLI (`cli/`, built to `dist-cli/sapwood.mjs`).

## What it does

Two surfaces: a guided **Home** (signer card, connect-an-app flow, connected apps with inline permissions, operator-key backup nudge, firmware nudge, phone handoff) and an **Advanced console** with four sections:

- **Apps** -- create connections, approve/revoke apps, per-kind signing permissions (one surface for USB, WiFi and bridge transports); when the signer holds more than one identity, an identity picker chooses which one new connections bind to
- **Identity** -- identities (master slots) on the signer, add-identity (provision, including derive-by-name: the signer derives the nsec-tree child from a master it already holds via DERIVE_IDENTITY 0x60, no secret in the browser; browser-side phrase/nsec derivation is the fallback for older firmware), family recovery (words-only rebuild of a My Signet family from the encrypted `signet:dependants` roster on the sync relay; the signer decrypts the roster via its own `nip44_decrypt` and every re-derived identity is checked against the roster's expected pubkey; `src/lib/recovery.ts` + `RecoveryWizard.svelte`), identity-card sync, NIP-05 short-address generator (nostr.json for bunker discovery), operator key, profile relays
- **Device** -- connection info, network mode, OTA firmware updates (SHA-256 verified) plus a quick USB app-only update for single-slot boards (T-Display, C6, an early V4 on the legacy table) that reads the partition table off the chip and refuses a two-slot board before writing (`planAppOnlyWrite` in `src/lib/flasher.ts`), after a power cut (the three modes: no encryption, phone unlock, Sapwood or PIN only; plus "Phones that can unlock": list, revoke, and add a Cambium phone over USB by scanning its enrolment code, `src/lib/phone-unlock.ts` + `UnlockPhones.svelte`), security (boot PIN, bridge secret), backup and restore (app pairings + bridge secret to an encrypted file, USB only, button-confirmed), bridge control, danger zone (disconnect all apps, factory reset -- physical button confirm)
- **Logs** -- real-time ESP-IDF log output from the device

UI copy says "apps" and "identities"; code and the wire protocol keep the frame/struct names (clients, masters, slots). Shared design primitives (buttons, cards, fields, tags) live in `src/app.css`; components keep only layout in scoped styles.

## Build & test

| Command | Purpose |
|---------|---------|
| `npm install` | Install dependencies |
| `npm run dev` | Dev server at `localhost:5173` |
| `npm run build` | Production build to `dist/` |
| `npm run build:cli` | Bundle the CLI to `dist-cli/sapwood.mjs` (esbuild, serialport external) |
| `npm run preview` | Preview `dist/` locally |
| `npm test` | Run the test suite (vitest run) |
| `npm run test:watch` | Watch mode |
| `npm run test:e2e` | Playwright end-to-end tests |
| `npm run check` | Type-check the app (svelte-check) |
| `npm run check:cli` | Type-check the CLI (tsc) |
| `npm run sync:firmware` | Sync bundled firmware assets |

CI (`.github/workflows/ci.yml`) also runs an identity guard (no commit or tracked content may name the banned check-in identity) and an `npm audit` gate on production dependencies.

## Architecture

```
GitHub Pages / Hetzner (static files)
        |
   Browser (Sapwood SPA)
        |
   Web Serial API (Chrome/Edge only)  |  Nostr relays (remote)
        |
   ESP32 USB-Serial-JTAG (frame protocol)
```

No bridge or server is needed for local management: the browser speaks the Heartwood frame protocol directly over USB. Remote management sends authenticated, NIP-44-encrypted events (kind 24134) over Nostr relays to the device's outbound WiFi connection (`src/lib/relay-transport.ts`). A separate heartwood bridge daemon (in heartwood-esp32) is only needed for the hardened USB-only tier, where the signing chip's radio stays off and an always-on host relays NIP-46 signing traffic over the cable; `src/lib/bridge-probe.ts` detects whether an origin actually serves that bridge API.

### Frame protocol

TypeScript port of `heartwood-common/src/frame.rs` in `src/lib/frame.ts`. Frame format: `[0x48 0x57] [type_u8] [length_u16_be] [payload...] [crc32_be32]`. CRC32 covers type + length + payload. `frame.test.ts` verifies byte-level compatibility with the Rust implementation; any change to the wire format must be mirrored in the Rust implementation and verified with tests.

### Transport layer

`src/lib/serial.ts` wraps the Web Serial API. Event-based: components subscribe to frame and log events. Byte-stream splitting (frame magic hunting, log-line separation) lives in `src/lib/frame-stream.ts`, and UART write pacing in `src/lib/pacing.ts`; both are shared with the CLI.

### Command line (`cli/`)

`sapwood` -- the console as a cross-platform CLI (Linux/macOS/Windows, Node 20+) over node-serialport. Shares `src/lib` (frame, frame-stream, pacing, ota, types); its own transport is `cli/transport.ts`, commands in `cli/commands.ts` (pure, tested against a fake transport). Commands: `ports`, `device`, `identities`, `identities remove`, `derive`, `apps`, `apps revoke`, `logs`, `firmware update`, `key backup` (offline nsec/ncryptsec -> ForgeSworn Recovery Words v1, no device), `operator new` / `operator restore` (offline operator-key mint/recover, no device), `backup export` / `backup import` (app-pairing backup/restore to an encrypted file, button-confirmed). The pure operator-key derivation is shared with the browser keyring in `src/lib/operator-key.ts`; the backup engine + encrypted envelope (Argon2id + XChaCha20-Poly1305) is shared with the web UI in `src/lib/backup.ts`. `--json` everywhere. Same security model: management frames only, button gates destructive operations.

## Frame types in active use

| Frame | Type | Direction | Payload |
|-------|------|-----------|---------|
| PROVISION_REMOVE | 0x04 | host -> device | slot_u8 (ACK, then device reboots; remaining slots renumber) |
| PROVISION_LIST | 0x05 | host -> device | (empty) |
| PROVISION_LIST_RESPONSE | 0x07 | device -> host | JSON `Vec<MasterInfo>` (masters, then derived personas with `persona: true`) |
| DERIVE_IDENTITY | 0x60 | host -> device | parent_slot (1) + name utf8; device derives the nsec-tree child on-device |
| DERIVE_IDENTITY_RESPONSE | 0x61 | device -> host | JSON `{slot, label, npub, parent_slot, purpose, existing}` |
| ENCRYPTED_REQUEST | 0x10 | host -> device | `[target_pubkey_32][client_pubkey_32][created_at_u64_be_8][nip44_ciphertext_b64]`, a full NIP-46 request; `src/lib/nip46-usb.ts` drives it |
| SIGN_ENVELOPE_RESPONSE | 0x35 | device -> host | signed kind:24133 envelope; `content` decrypts under the client-identity conversation key |
| FACTORY_RESET | 0x24 | host -> device | (empty, requires button) |
| SESSION_AUTH | 0x21 | host -> device | 32-byte bridge secret; reply SESSION_ACK 0x22 (0x00 ok / 0x01 wrong / 0x02 none set) |
| CONNSLOT_LIST | 0x42 | host -> device | master_slot (1); secrets redacted, no session needed |
| CONNSLOT_REVOKE | 0x46 | host -> device | master_slot (1) + slot_index (1); needs SESSION_AUTH first |
| OTA_BEGIN | 0x30 | host -> device | size_u32_be + sha256 (requires button) |
| OTA_CHUNK | 0x31 | host -> device | offset_u32_be + data |
| OTA_FINISH | 0x32 | host -> device | (empty) |
| OTA_STATUS | 0x33 | device -> host | status_byte |
| BACKUP_EXPORT_REQUEST | 0x50 | host -> device | (empty, requires button; device replies 0x51 with JSON `BackupPayload`) |
| BACKUP_EXPORT_RESPONSE | 0x51 | device -> host | JSON `BackupPayload` (masters + connection slots + bridge secret) |
| BACKUP_IMPORT_REQUEST | 0x52 | host -> device | JSON `BackupPayload` (masters pre-filtered to those the device holds; requires button) |
| BACKUP_IMPORT_RESPONSE | 0x53 | device -> host | 1 byte: 0x01 ok / 0x00 fail |
| PHONE_UNLOCK_CMD | 0x64 | host -> device | JSON `{op:"enrol",enrol_pubkey,label}` / `{op:"list"}` / `{op:"revoke",id}` / `{op:"set_announce_operator",on}`; needs SESSION_AUTH; enrol needs a press and is sent once (the signer refuses a reused enrolment key). Firmware before 0.18.0-beta.17 NACKs with no reason. Over the relay: `list_unlock_phones`, `revoke_unlock_phone`, `set_announce_operator` (capability `phone_unlock_v1`); enrol is cable only |
| PHONE_UNLOCK_RESP | 0x65 | device -> host | enrol: `{id, ephemeral_pubkey, sealed}` (sealed to the phone, Sapwood relays it as kind 24137 tagged `["h", rendezvous]` from a throwaway key); list: `{phones:[{id,label}], max, announce_operator}` |

**Not implemented, despite being declared.** `POLICY_LIST_REQUEST` (0x27), `POLICY_LIST_RESPONSE` (0x28), `POLICY_REVOKE` (0x29) and `POLICY_UPDATE` (0x2A) exist in `heartwood-common/src/types.rs` and in `frame.ts`, and the firmware has no handler for any of them. Sapwood only touches them in byte-roundtrip tests. App permissions go over the `CONNSLOT_*` frames instead. Do not use these frames for new work; they read as the way to manage an app without a bridge session and do nothing at all.

### Signing size, and the compact dialect

`max_sign_bytes` in FIRMWARE_INFO is not a hardware limit, it is an encoding one. NIP-46 carries the event as a JSON *string* inside `params`, so its quotes are escaped twice and unescaping grows a buffer by doubling; and `sign_event` echoes the whole signed event back. Each costs one contiguous allocation of about twice the content, and each aborts a no-PSRAM signer on its own.

A client that sends `params[0]` as a JSON **object** and asks for `sign_event_compact` (reply: `{id, sig, pubkey, created_at}`) avoids both, and earns `max_sign_bytes_object` instead: 18 KB against 12 KB on a V4. Both halves are required, and the signer enforces that. Measurements are in `heartwood-esp32/docs/BENCH-2026-08-06-message-sizes.md`.

## Structure

```
src/lib/       -- frame protocol, transports (serial, relay, bridge), device state, provisioning,
                  backup/restore, OTA, flashing, recovery, kinds, operator key (each with its .test.ts)
src/           -- App.svelte, Root.svelte, Flasher.svelte, components/, app.css
cli/           -- cross-platform CLI: args, commands, transport, main
scripts/       -- build-cli.mjs, sync-firmware.mjs, capture-guide-assets.mjs
docs/          -- backup-and-restore.md, key-backup.md, brand-identity.md, kithmoot-permissions.md
e2e/           -- Playwright end-to-end tests
deploy/        -- deployment scripts and config
public/        -- static assets
```

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

Regardless of tier, firmware updates, factory reset and PIN changes always require the USB cable: deliberate physical-presence gates. Identity management works over WiFi too: derive-by-name sends no secret at all (the signer holds the root), and importing a phrase/nsec/ncryptsec travels NIP-44 encrypted end-to-end under the operator-signer conversation key, so relays only ever carry ciphertext.

### Future: Web Bluetooth (portable mode only)

BLE connectivity planned for portable mode (child key only, short range). Additional requirements before shipping BLE:
1. Rate limiting on management frame types in firmware
2. BLE pairing requires button press to accept
3. CSP headers on static hosting

## Conventions

- British English in all prose, comments, and UI copy
- ESM-only (`"type": "module"`, target ES2022)
- TypeScript strict mode; no `any`, no type assertions without justification
- Svelte 5 runes mode (`$state`, `$derived`, `$effect`); no legacy Svelte 4 patterns
- Monospace font throughout (terminal/cockpit feel)
- Dark theme only
- Tone: sovereign, precise, calm. No exclamation marks. State facts.
- No em dashes in UI copy: use a full stop, comma or colon instead (a bare "--" as an empty-value placeholder in tables is fine)
- No third-party runtime dependencies unless strictly necessary
- Git commits: `type: description` format. No Co-Authored-By lines. Conventional types: `feat`, `fix`, `refactor`, `test`, `docs`, `chore`
- One logical change per pull request against `main`; all tests must pass and the build must succeed (`npm run build`)

## Ecosystem

| Component | Repo | Role |
|-----------|------|------|
| Heartwood | heartwood-esp32 | ESP32 signing device (firmware + bridge + provision CLI) |
| **Sapwood** | **this repo** | **Web management UI (static SPA, Web Serial + Nostr relay management)** |
| Bark | bark | Browser extension for NIP-46 signing |
| nsec-tree | nsec-tree | Key derivation library |

## Common pitfalls

- Do not change the frame wire format unilaterally; it must be mirrored in `heartwood-common/src/frame.rs` and verified with tests on both sides.
- `POLICY_LIST_REQUEST`/`POLICY_LIST_RESPONSE`/`POLICY_REVOKE`/`POLICY_UPDATE` (0x27-0x2A) are declared but unimplemented in firmware; use the `CONNSLOT_*` frames for app permissions instead.
- The check-in identity is enforced by `.githooks/pre-commit` and a server-side CI gate (`identity-guard` in `.github/workflows/ci.yml`); commits must not be authored or committed under the banned identity, and tracked content must not name it.
- A static host answering an unknown bridge path with the SPA's own `index.html` (HTML 200) must not be mistaken for a real bridge reply; `src/lib/bridge-probe.ts` guards this.
- `max_sign_bytes` is an encoding limit, not a hardware one; prefer `sign_event_compact` with an object `params[0]` over the string-JSON `sign_event` path for anything but the smallest events.

## How to verify a change

Run `npm test` (vitest) for unit and component coverage, `npm run check` (svelte-check) and, for CLI changes, `npm run check:cli` (tsc) for type-checking, and `npm run build` to confirm the production build succeeds. For frame protocol changes, keep `frame.test.ts` passing and add tests for any new frame type. For end-to-end coverage, `npm run test:e2e` (Playwright).

## Grant status

Foundation work. Manages existing shipped functionality.
