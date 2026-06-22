# Changelog

All notable changes to Sapwood are recorded here. Format loosely follows
[Keep a Changelog](https://keepachangelog.com/); versions are [SemVer](https://semver.org/).

## 0.5.3 — 2026-06-22

### Changed

- **"Press RESET" is now an unmissable step after flashing.** The ESP32-S3's USB
  doesn't reliably auto-reboot after a flash, so the success screen now leads with
  a prominent *"Now press the RESET button on the board"* callout (heading changed
  to *"Your signer is flashed"* — it isn't live until it restarts), and the
  console's finish-setup card says to press RESET if the signer isn't found.
- **Visible version.** The footer now shows the running build (e.g. *Sapwood
  v0.5.3*) so you can confirm a deploy landed and you're not on a cached older tab.

## 0.5.2 — 2026-06-22

### Added

- **One-click Reconnect.** When a USB signer hits an error — e.g. after you press
  RESET to recover a device that didn't reboot after flashing — the error banner
  now offers a **Reconnect** button. One tap re-picks the port and carries on,
  instead of having to Disconnect and reconnect by hand.

### Fixed

- **Gesture-safe reconnect.** Reconnecting now requests the serial port *before*
  tearing down the previous session, so Chrome doesn't reject it for lacking a
  user gesture (and the UI no longer flashes back to the picker mid-reconnect).
  Initial connect is unchanged.

## 0.5.1 — 2026-06-22

Setup reliability: a serial write could lock up the connection and strand you
mid-setup, and the three Advanced provisioning styles weren't explained.

### Fixed

- **"WritableStream is locked" / stuck setup.** Serial writes are now serialised,
  so two overlapping writes (e.g. the masters + slots refresh that both fire on
  connect) no longer collide with *Cannot create writer when WritableStream is
  locked* — the error that stranded setup with no way back in. A stalled write now
  times out and aborts the writer instead of wedging the connection forever, and
  disconnect always resets cleanly so you can reconnect and return to setup.
- **Clearer "device didn't respond" guidance.** When the device doesn't answer —
  most often because it didn't reboot after flashing and is still in the bootloader
  — you now get *"press the RESET button on the board… then reconnect"* instead of
  a cryptic timeout.

### Changed

- **Advanced › Provision explains the three styles.** Each option now says what it
  does and — crucially — whether your signer keeps your existing npub (*Existing
  nsec — sign as-is*) or gets a brand-new derived address (*Recovery phrase* and
  *Existing nsec — derive a new key*). The confirm step calls out which to expect,
  so you can't silently end up on the wrong identity.

## 0.5.0 — 2026-06-21

Back the operator key — your sole authority to manage a WiFi device over
relays — with a written-down recovery phrase, so it is no longer trapped in
one browser.

### Added

- **Operator recovery phrase.** The operator key (`op_mgmt`) is now derived from
  a 12-word BIP-39 phrase (NIP-06 path `m/44'/1237'/0'/0/0`) instead of being an
  opaque random secret stuck in one browser's `localStorage`. Write the words
  down and you can restore the exact same operator key on any device. The flasher
  shows the phrase on the "your signer is live" screen ("write these 12 words
  down"); **Settings › Operator Key** reveals/backs up the phrase and restores
  from one. The phone-handoff QR still carries the *derived* secret (compact,
  same authority) — the phrase is the human backup.

- **Guided post-flash handoff.** A freshly-flashed device no longer dumps you at
  the generic connect picker (whose biggest button — *Set up a new device* — sent
  a just-flashed newcomer back to the flasher). The console now leads with a
  single obvious card: *"✓ Flashed! Now let's finish your signer"* and one button,
  *Connect to my new signer →*, with *Connect a different way* as the escape hatch.
  The flasher's own success screen ends with *Continue setup →* and sets
  expectations ("next we'll name it and make its keys").

### Changed

- **Less jargon on the success screen.** The "your signer is live" screen now
  leads with the recovery phrase to write down; the technical `NOSTR_SECRET_KEY=…`
  (for connecting bray) moves behind an *Advanced* disclosure.
- **Raw-hex operator import demoted to Advanced.** Restoring an operator is now
  phrase-first; pasting a 64-hex secret lives behind an *Advanced* disclosure
  (a raw secret has no phrase, so it's for matching a device flashed elsewhere).
- Operators created before this release (raw-hex, no phrase) keep working
  unchanged — a device already flashed with one is still manageable. Rotating to
  a phrase-backed key mints a new key and needs a re-flash.

### Security

- The device side this pairs with (heartwood-esp32) now **persists its kind-24134
  replay seen-set across reboots** (NVS), closing a window where a management
  command captured off the relay could be replayed after the device restarted.
  The guard keys on the request's inner (encrypted) id, so it cannot be forged or
  altered without the operator secret.

## 0.4.2 — 2026-06-21

Make the *Connect over your network* (WiFi) form readable, and let you point at a
device by `npub1…` **or** a NIP-05 name.

### Added

- **NIP-05 names in WiFi connect.** The device address box now accepts a name like
  `you@example.com` as well as an `npub1…` or hex key. The name is resolved to the
  device's key only when you press **Connect** — never while you type — so no
  passive lookup leaks your IP. If the name advertises its own relays and the relay
  box is empty, those are used.

### Changed

- **Roomier, self-explaining WiFi connect.** The relay form no longer borrows the
  bridge form's cramped fixed-width inputs. It now has full-width, labelled boxes
  with numbered steps and plain-language hints: what your device's address is
  (an `npub1…` or NIP-05 name, *safe to share, like a postal address*) and what a
  relay is (*a shared postbox on the internet — your browser drops off a message
  and the device picks it up*). The known-device picker prefills a real `npub1…`
  instead of raw hex, so the on-screen hint matches what you see.

## 0.4.1 — 2026-06-21

Home polish: one signer panel instead of two, and no jarring browser dialogs.

### Changed

- **One connection panel on Home.** The technical *CONNECTED · WIFI — …* row no
  longer stacks above the *Your signer is live* card. The signer card now owns
  the connection state ("Connected over WiFi/USB cable") and the **Disconnect**
  action; the picker only shows when disconnected or in Advanced. A device with
  no identity yet keeps a slim connection line above the setup flow.
- **In-app disconnect confirmation.** Disconnecting an app now asks inline on the
  card (*Disconnect this app? · Yes, disconnect · Cancel*) instead of a native
  `confirm()` dialog, so the flow stays in Sapwood's own look.

## 0.4.0 — 2026-06-21

Closes the first-run gap: a brand-new device, just flashed, has no identity yet,
and creating one was buried in Advanced with no "generate a fresh key" path. Now
Home walks a newcomer through it, and the connect surface speaks plain English.

### Added

- **Guided first identity** — when a connected device has no identity yet, Home
  leads with a calm setup flow: generate a fresh **recovery phrase**, write it
  down (confirmed before you continue), name the signer, review its public
  address, and write it to the device over USB. A WiFi signer then hands off to
  *Manage over WiFi* automatically. Power users with an existing key still take
  *I already have a recovery phrase or key* through to Advanced › Provision.
- **`generateMnemonic`** in the provision library — the first time Sapwood can
  create a brand-new identity, not just import one (12-word BIP-39, 24 optional).

### Changed

- **Plain-language connect surface.** *Connect USB* → **Connect by USB cable**,
  *Connect WiFi (relay)* → **Connect over your network**, and the bridge option
  moves behind an *Other ways to connect* disclosure (kept, just demoted).
- The disconnected console no longer shows *Set up a new device* twice — the
  prominent button stays; the duplicate header link is gone.

### Tests

- New pure-logic units (`first-identity`, `generateMnemonic`), a component test
  for the whole first-identity flow (generate → confirm → write over a mocked
  USB → WiFi handoff, plus NACK handling), Home coverage for the no-identity
  branch, and E2E for the guided setup surface and the de-jargoned connect
  options. 204 unit + 15 E2E, green.

## 0.3.0 — 2026-06-21

A guided admin to match the guided flasher: once connected you land on a warm
**Home** instead of the bare cockpit, with the full power surface one tap away.

### Added

- **Guided admin Home** — the default connected view. Shows your signer in plain
  language (with a one-tap rename), makes **Connect an app** the obvious next
  step, lists what is connected, and carries the *manage from your phone* QR.
- **Connect an app flow** — name it → choose what it can sign (presets:
  *Everything*, *Posting only*, *Messages only*, or *Let me choose*) → a QR to
  scan straight into the app. Works the same over WiFi (relay) and USB.
- **Advanced toggle** — the full nine-tab cockpit (Masters, Clients, Provision,
  Connectivity, Firmware, Logs, Settings, Danger) is unchanged, now tucked behind
  an *Advanced ⚙* switch and reachable from Home.
- **Disconnect all apps** — a single Danger-zone action to revoke every connected
  app at once (the signer and its keys are untouched).
- **Rename your signer** — a friendly local label, stored only in your browser.

### Changed

- A fresh connection always lands on Home; the disconnected state still leads
  with *Set up a new device*.
- **Plain language on Home** — the technical readout (masters, clients, slots)
  now lives only in Advanced. Home labels the signer's address ("safe to share")
  and describes the management key in everyday terms, so it reads for a newcomer
  while Advanced keeps the full vocabulary and every tool.

### Tests

- New pure-logic units (`client-presets`, `connect-flow`, device-label helpers),
  component tests for the connect-an-app flow and Home, and an E2E seam that
  exercises the connected Home, the Advanced cockpit, and mobile no-overflow —
  all without a relay or hardware. 181 unit + 13 E2E, green.

## 0.2.1 — 2026-06-21

### Fixed

- **Serial port "in use" lock.** A flash or USB connect left the Web Serial port
  open — and the ESP32-S3's native USB re-enumerates when esptool resets the
  chip, orphaning the handle — so the next attempt failed with "port in use"
  until the device was physically unplugged. Sapwood now closes any open granted
  port before opening a new one (after the port picker, so the click's user
  gesture is preserved), on both the flasher and the admin USB connect.

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
