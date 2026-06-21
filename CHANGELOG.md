# Changelog

All notable changes to Sapwood are recorded here. Format loosely follows
[Keep a Changelog](https://keepachangelog.com/); versions are [SemVer](https://semver.org/).

## 0.2.0 — 2026-06-21

A near-complete rework toward a "world-class" setup experience: a focused flasher,
a mobile-first admin console, privacy by default, and its own deployment.

### Added

- **Guided flasher** at `#/flash` — a focused, desktop Web Serial flow (welcome →
  board → Wi-Fi → review → flash → "your signer is live"), separate from the admin
  console. Relays and full-erase tucked under *Advanced*.
- **Mobile-first admin** — responsive shell with a bottom-docked tab bar (44px+
  touch targets); zero horizontal overflow at phone widths. The disconnected state
  leads with a prominent **Set up a new device** action.
- **Manage from your phone** — once a device is set up, the admin shows a QR that
  encodes the operator key, device address, and relays; scanning it on a phone
  auto-connects, with nothing to type.
- **Own domain** — served at [sapwood.forgesworn.dev](https://sapwood.forgesworn.dev/)
  (Caddy on the Hetzner box, auto-TLS) alongside GitHub Pages.
- **Tests + CI** — an injectable flasher backend with a full regression net
  (unit + Playwright E2E), gating every PR.

### Changed

- Plain-language copy throughout the connect flow (e.g. "your device's address"
  instead of raw "npub").
- Self-hosted JetBrains Mono — **no more third-party font request** (was leaking
  the visitor's IP to Google Fonts).

### Security

- Build-time **Content-Security-Policy** locking resource loads to our own origin;
  a test fails the build if any third-party request is reintroduced.
- The flasher and admin make no analytics/telemetry calls and store nothing about
  the user. The phone-handoff secret rides only in the URL fragment (never sent to
  a server) and is stripped from the URL on import.

### Fixed

- Flasher: request the serial port before fetching firmware, so Chrome no longer
  rejects it with "Must be handling a user gesture".
- Admin: don't mistake a static host's SPA fallback for a bridge API and choke
  parsing HTML as JSON.

## 0.1.0

Initial web management UI for the Heartwood ESP32 signing device (Web Serial +
bridge HTTP): view masters, manage TOFU clients, OTA firmware, logs, factory reset.
