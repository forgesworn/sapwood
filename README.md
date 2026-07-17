# Sapwood

[![GitHub Sponsors](https://img.shields.io/github/sponsors/TheCryptoDonkey?logo=githubsponsors&color=ea4aaa&label=Sponsor)](https://github.com/sponsors/TheCryptoDonkey)

**Shape your signer** -- browser-based local and remote management UI for the [Heartwood](https://github.com/forgesworn/heartwood-esp32) ESP32 signing device.

Bootstrap Heartwood over USB, then leave it online in WiFi-standalone mode and manage it from Sapwood on your phone through Nostr relays. The device can sign unattended only inside exact client method/event-kind policies installed by its authenticated operator.

## Features

- **Masters** -- view provisioned master slots, npubs, and derivation modes
- **Named identities** -- type a name and the signer derives the identity from the master it already holds (nsec-tree child derivation, no secret in the browser); older firmware falls back to phrase/nsec entry. Connect apps to it via the identity picker
- **Key backup** -- write an imported nsec/ncryptsec out as [24 words](docs/key-backup.md) that restore the same npub, here or via the offline CLI
- **Clients** -- remotely create, list, revoke, and update exact client policies
- **Connectivity** -- stage and activate rollback-safe WiFi/relay changes remotely
- **Phone handoff** -- transfer the separate operator credential to a phone with a protected QR flow
- **USB recovery** -- read password-redacted state, preserve credentials during network edits, and physically rotate only the management operator
- **Firmware** -- OTA updates with SHA-256 verification and progress bar
- **Logs** -- real-time ESP-IDF log output from the device
- **Factory Reset** -- erase all keys (requires physical button confirmation)

## How it works

Sapwood supports two transports. USB bootstrap and recovery use the [Web Serial API](https://developer.mozilla.org/en-US/docs/Web/API/Web_Serial_API). Remote management sends authenticated, encrypted management events through Nostr relays to Heartwood's outbound WiFi connection; the device exposes no inbound port and requires no cloud account or management server.

```
Browser (Sapwood)  --Web Serial-->  Heartwood               (local)
Phone (Sapwood)    --Nostr relays--> Heartwood outbound WiFi (remote)
```

The frame protocol is a TypeScript port of [heartwood-common/src/frame.rs](https://github.com/forgesworn/heartwood-esp32), with 19 tests verifying byte-level compatibility with the Rust implementation.

## Security

Master secrets never leave the ESP32. Remote mutations require the separate operator key, a device-issued one-time challenge, and the current client credential fingerprint. Exact policies fail closed: unlisted methods and event kinds cannot be signed automatically. Sapwood keeps multiple operator credentials in an additive local keyring, and a protected phone QR is built only from relays/operator state proven by the exact signer. Seed/PIN changes, trust-root changes, factory reset, provisioning, and OTA remain local USB/physical operations; firmware-only flashing preserves the config partition by default.

## Quick start

Visit [sapwood.forgesworn.dev](https://sapwood.forgesworn.dev/) in Chrome or Edge, plug in Heartwood, and click **Connect USB** for the initial setup. Enable WiFi-standalone mode and use **Move management to phone** to create the protected operator handoff. Afterwards the phone can connect remotely while the device stays in another country.

### Local development

```bash
git clone https://github.com/forgesworn/sapwood.git
cd sapwood
npm install
npm run dev       # dev server at localhost:5173
npm test          # unit and component tests
npm run build     # production build to dist/
```

## Command line

The same console at a shell prompt. `sapwood` speaks the identical frame protocol over [node-serialport](https://serialport.io/): cross-platform on Linux, macOS and Windows, Node 20+, ~30ms startup.

```bash
npm install && npm run build:cli
npm link                               # puts `sapwood` on PATH (or run node dist-cli/sapwood.mjs)

sapwood device                         # firmware, board, identities, connected apps
sapwood identities                     # slots, npubs, personas
sapwood identities remove 3            # remove an identity (typed-name confirmation, device reboots)
sapwood derive blog                    # derive an identity on-device, no secret leaves the signer
sapwood apps                           # connected apps and their permissions
sapwood apps revoke 2 --identity 0     # revoke an app slot
sapwood logs                           # stream the device log
sapwood firmware update heartwood.bin  # OTA: button-approved, signature and SHA-256 verified
```

`--json` on any command gives machine-readable output for scripting. The port is auto-detected when exactly one signer is plugged in (`sapwood ports` lists candidates); `--port` overrides. The security model is unchanged: no secrets on this side of the cable, and destructive operations still need the physical button.

## Stack

- [Svelte 5](https://svelte.dev) (runes mode) -- compiles to vanilla JS, no framework runtime shipped
- [Vite](https://vite.dev) -- build tool
- TypeScript (strict mode)
- [Vitest](https://vitest.dev) -- test framework
- Web Serial API -- Chrome/Edge 89+

## Ecosystem

> For internal architecture details, see [ARCHITECTURE.md](ARCHITECTURE.md).

Sapwood is part of the Heartwood signing device ecosystem:

| Component | Role |
|-----------|------|
| [Heartwood](https://github.com/forgesworn/heartwood-esp32) | ESP32 firmware + bridge + provision CLI |
| **Sapwood** (this repo) | Web management UI |
| [Bark](https://github.com/nicorache/bark) | Browser extension for NIP-46 signing |
| [nsec-tree](https://github.com/nicorache/nsec-tree) | Key derivation library |

Named after the living, active layer of wood between bark and heartwood.

## Browser support

Web Serial API is required. Currently supported in:
- Chrome 89+
- Edge 89+
- Opera 76+

Firefox and Safari do not support Web Serial. BLE connectivity for portable mode is planned.

## Part of the ForgeSworn Toolkit

[ForgeSworn](https://forgesworn.dev) builds open-source cryptographic identity, payments, and coordination tools for Nostr.

| Library | What it does |
|---------|-------------|
| [nsec-tree](https://github.com/forgesworn/nsec-tree) | Deterministic sub-identity derivation |
| [ring-sig](https://github.com/forgesworn/ring-sig) | SAG/LSAG ring signatures on secp256k1 |
| [range-proof](https://github.com/forgesworn/range-proof) | Pedersen commitment range proofs |
| [canary-kit](https://github.com/forgesworn/canary-kit) | Coercion-resistant spoken verification |
| [spoken-token](https://github.com/forgesworn/spoken-token) | Human-speakable verification tokens |
| [toll-booth](https://github.com/forgesworn/toll-booth) | L402 payment middleware |
| [geohash-kit](https://github.com/forgesworn/geohash-kit) | Geohash toolkit with polygon coverage |
| [nostr-attestations](https://github.com/forgesworn/nostr-attestations) | NIP-VA verifiable attestations |
| [dominion](https://github.com/forgesworn/dominion) | Epoch-based encrypted access control |
| [nostr-veil](https://github.com/forgesworn/nostr-veil) | Privacy-preserving Web of Trust |

## Licence

MIT
