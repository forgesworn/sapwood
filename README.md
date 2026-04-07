# Sapwood

**Shape your signer** -- browser-based management UI for the [Heartwood](https://github.com/forgesworn/heartwood-esp32) ESP32 signing device.

Connect your Heartwood via USB, open [sapwood.dev](https://forgesworn.github.io/sapwood/) in Chrome, and manage your signing device from the browser. No server, no install, no dependencies.

## Features

- **Masters** -- view provisioned master slots, npubs, and derivation modes
- **Clients** -- list, revoke, and update TOFU-approved client policies
- **Firmware** -- OTA updates with SHA-256 verification and progress bar
- **Logs** -- real-time ESP-IDF log output from the device
- **Factory Reset** -- erase all keys (requires physical button confirmation)

## How it works

Sapwood connects directly to the ESP32 via the [Web Serial API](https://developer.mozilla.org/en-US/docs/Web/API/Web_Serial_API) (Chrome/Edge 89+). It speaks the Heartwood frame protocol over USB -- the same protocol used by the provision CLI and bridge. No server component, no bridge required.

```
Browser (Sapwood)  --Web Serial-->  ESP32 USB-Serial-JTAG
```

The frame protocol is a TypeScript port of [heartwood-common/src/frame.rs](https://github.com/forgesworn/heartwood-esp32), with 19 tests verifying byte-level compatibility with the Rust implementation.

## Security

Secrets never leave the ESP32. The serial protocol only carries public keys, policy metadata, unsigned events, and signatures. All destructive operations (factory reset, OTA, provisioning) require physical button confirmation on the device. A compromised web UI cannot extract keys or perform destructive actions without someone pressing the button.

## Quick start

Visit [forgesworn.github.io/sapwood](https://forgesworn.github.io/sapwood/) in Chrome or Edge, plug in your Heartwood, and click **Connect USB**.

### Local development

```bash
git clone https://github.com/forgesworn/sapwood.git
cd sapwood
npm install
npm run dev       # dev server at localhost:5173
npm test          # 19 frame protocol tests
npm run build     # production build to dist/
```

## Stack

- [Svelte 5](https://svelte.dev) (runes mode) -- compiles to vanilla JS, 21KB gzipped total
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
