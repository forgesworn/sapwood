# Changelog

All notable changes to Sapwood are recorded here. Format loosely follows
[Keep a Changelog](https://keepachangelog.com/); versions are [SemVer](https://semver.org/).

## 0.8.6 — 2026-06-22

Bundled firmware v0.9.0 — on-device personas now derive under the canonical
`nostr:persona:<name>` namespace (PROTOCOL v1.1 §3.1), so a persona derived on
the signer matches the same persona in signet, the nsec-tree library, and the
nsec-tree CLI. The previous `persona/<name>` derivation is gone; raw
`heartwood_derive` (arbitrary purpose) is unchanged.

## 0.8.5 — 2026-06-22

Bundled firmware v0.8.1 — a much friendlier on-device restore.

### Changed

- **Bundled firmware → v0.8.1.** On-device recovery-phrase restore is reworked:
  two gestures (**tap** = next choice, **hold** = pick — DELETE is a choice in the
  ring), and a **review-and-edit** pass over all 12 words so a wrong word can be
  found and fixed in place instead of backspacing through everything. Update an
  existing signer to it from the Update-firmware screen.
- **`sync:firmware` pins bootloaders.** It now writes a board's bootloader /
  partition table only when absent (a `--force` flag overwrites), so a routine
  app refresh never swaps a flash-proven bootloader for a byte-different CI
  rebuild. This release updates only the app images + `version.json`.

## 0.8.4 — 2026-06-22

Fresh-flash a Heltec V3 from the browser.

### Added

- **V3 can now be flashed fresh, not just OTA'd.** The release publishes each
  board's bootloader and the shared partition table alongside the app, and
  `sync:firmware` lays all three out under `public/firmware/<board>`. The V3
  bootloader, app and partition table are a coherent CI-built set (the partition
  table is byte-identical to V4's proven one). Select "Heltec WiFi LoRa 32 V3"
  in Flash and go. *(Best confirmed on V3 hardware — it has not been flash-tested
  on a physical V3 here.)*

### Changed

- **`sync:firmware` now places `bootloader.bin` + `partition-table.bin`** per
  board (verifying every SHA-256), not just `app.bin`.
- **V4 is untouched.** Its proven bootloader is kept as-is — the CI toolchain
  produces a byte-different (benign) bootloader, and there was no reason to make
  you re-test a working signer.

## 0.8.3 — 2026-06-22

Multi-board firmware — V3 alongside V4.

### Added

- **Bundled V3 firmware (v0.8.0).** The release now builds every board, and
  `sync:firmware` pulls each board's image, so a Heltec V3 signer can be updated
  over USB just like a V4. (Fresh-flashing a V3 from the browser still needs its
  bootloader/partition images — a separate follow-up; V3 OTA works today.)

### Changed

- **`sync:firmware` is board-agnostic** — it reads the per-board manifest and
  places each image under `public/firmware/<board>`, verifying every SHA-256.

## 0.8.2 — 2026-06-22

Version-aware firmware updates, and firmware that no longer drifts.

### Added

- **One-click "update to vY".** The update screen now shows the version your
  signer is running versus the version bundled here, and updates in one click —
  no `.bin` hunting. (Hand-picking a file is still available under "Advanced".)
- **`npm run sync:firmware`.** Pulls the published firmware (`app.bin` +
  `version.json`) from a heartwood-esp32 release into `public/firmware`,
  verifying the SHA-256. This replaces hand-copied binaries, so flashing and OTA
  always ship the current build.

### Changed

- **Bundled firmware refreshed to v0.8.0** — so a freshly flashed signer now
  includes on-device seed restore.

## 0.8.1 — 2026-06-22

Firmware-update polish, clearer keys, and accessibility.

### Changed

- **Firmware update is now owner-grade.** Plain-language status and errors (no raw
  state names or hex codes), design-system styling, and — crucially — clear
  guidance for updating an already-deployed **WiFi signer**: it walks you through
  putting the device in USB mode ("Hold PRG = USB" at boot) instead of offering an
  upload button that can't work over the relay. The transfer logic moved to a
  unit-tested `lib/ota.ts`.
- **"Two phrases" confusion fixed.** The flash screen now spells out that your
  **operator phrase** is different from your signer's own **recovery phrase** (which
  appears on the device's screen), and suggests labelling them so they aren't mixed up.

### Fixed

- **Accessibility:** removed the `autofocus` attribute (now a focus action) and the
  invalid nested `<button>` in the signing-permissions header. `svelte-check` is now
  clean — **0 errors, 0 warnings**.

## 0.8.0 — 2026-06-22

Restore an existing identity — entirely on the device.

### Added

- **Restore from your 12 words.** The setup flow now offers restoring an existing
  recovery phrase alongside creating a fresh one. The phrase is entered **on the
  device's own screen** with its button — single-tap to change the highlighted
  letter, double-tap to choose it (the word fills in once it's certain), hold to
  delete. Nothing is typed into or sent from the browser; the device validates
  the BIP-39 checksum, shows the resulting account for you to confirm, and only
  then stores it. The browser just triggers the flow and learns the public npub.
  Requires firmware with `RESTORE_IDENTITY` (0x58).

### Changed

- The first-identity intro now leads with two clear doors — **Create a fresh
  identity** and **Restore from my 12 words** — with the raw-key (nsec/bunker)
  path moved to a quieter "Advanced" link.

## 0.7.2 — 2026-06-22

Foundation hardening — fixes a crash and stops broken code shipping.

### Fixed

- **Advanced › Clients no longer crashes** when fetching a connection's bunker
  URI. A half-finished helper referenced undefined variables, throwing a
  `ReferenceError` at runtime (the production build didn't catch it). Removed the
  dead code; the inline per-client "URI" reveal was already the real path.

### Changed

- **`svelte-check` now runs in CI**, so TypeScript errors can no longer ship to
  production (this class of bug previously slipped through because only the
  bundler — which ignores undeclared globals — ran). Cleared the 13 pre-existing
  type errors across the codebase.

## 0.7.1 — 2026-06-22

### Fixed

- **You can now copy the bunker connection link.** After "Connect an app", the
  result showed only a QR code and a copy button — the link itself wasn't
  on-screen, and if the browser blocked the one-click copy (insecure context /
  permissions) there was no way to get it. The bunker link is now shown as
  **selectable text** (tap to select the whole thing) and the copy button has a
  fallback, so you can always paste it into another app. Same fix applied to the
  relay Clients view's copy buttons.

## 0.7.0 — 2026-06-22

Manage a WiFi signer over the USB cable — no more hold-PRG dance.

### Added

- **A WiFi signer now answers over USB as well as over its relay.** Previously a
  provisioned WiFi signer booted into a relay-only loop that ignored the cable,
  so plugging it in led to "this signer runs over WiFi" (or, before that, a
  dead-end). The bundled firmware now also polls USB from inside the relay loop,
  so when you plug it in you can see and manage it over the cable — list its
  identity, and create / list / update / revoke / get-URI for client
  connections — concurrently with WiFi/relay. Requires the firmware shipped with
  this release.

### Notes

- Master-changing operations (add / remove / generate an identity), OTA and
  network-config changes stay USB-only — the device replies asking you to hold
  PRG at boot for those, because they'd disturb the live relay subscription.
- USB management in WiFi mode is a touch less snappy (~1s per step) since the
  device interleaves it with serving the relay.

## 0.6.5 — 2026-06-22

Feedback while a new identity is being created, and a familiar save gesture.

### Changed

- **The device now shows "Working — creating your keys…" the moment you start
  generating**, instead of sitting on the previous screen for the few seconds
  the entropy draw, key stretch and derivation take. The browser's naming step
  says the same and points you at the device's screen. Requires the bundled
  firmware.
- **Saving the recovery phrase uses the same 0–100% hold bar as signing.** After
  you've stepped through the 12 words, holding the button fills a progress bar to
  100% to save (a short tap re-shows the words to re-check) — matching the
  approval gesture used elsewhere on the device.

## 0.6.4 — 2026-06-22

Hardens the randomness behind on-device key generation.

### Security

- **The recovery seed now comes from a guaranteed hardware entropy source.**
  The device generates the master seed before its Wi-Fi radio starts, and the
  ESP32's RNG is only a *true* random source while a hardware entropy source is
  live. The bundled firmware now switches on the chip's analogue-noise source
  for the seed (and the USB connection-slot secret) draws, so the 12 words are
  backed by real hardware entropy — all on-device, nothing supplied by or
  visible to this computer. No user action and no "wiggle the mouse" step is
  needed. Requires the firmware shipped with this release.

## 0.6.3 — 2026-06-22

Readable recovery phrase, smoother flash progress, and a way to set up the
next device.

### Changed

- **The recovery phrase is now shown one big word at a time.** All 12 words
  crammed onto the device's little screen were too small to read. The bundled
  firmware now displays them **one large, numbered word at a time** ("WORD 3 OF
  12") — tap the device button to step through, write each down, then hold the
  button to save (a tap on the final screen re-shows them so you can re-check).
  The guided "write it down" step now explains this. Requires the firmware
  shipped with this release.
- **Flash progress no longer leaps to 50% instantly.** Progress is now weighted
  by bytes, so the tiny bootloader and partition table barely move the bar and
  the ~1.8 MB firmware fills it smoothly, instead of jumping 0 → 50% before the
  real work starts.

### Added

- **"Set up another device"** links on the post-flash "finish your signer" card
  and the "your signer has an identity" screen, so you can flash the next one
  without hunting for the way back.

## 0.6.2 — 2026-06-22

Stops a provisioned WiFi signer, plugged into USB, from offering a dead-end
"create an identity" flow.

### Fixed

- **A signer that already has an identity is no longer asked to make another
  over the cable.** A provisioned WiFi signer boots straight into its relay loop
  and never listens on USB, so the browser's `PROVISION_LIST` got no reply — and
  Sapwood mistook "no reply" for "no identity", offered to create one, and that
  request then timed out ("no response from device"). On USB connect Sapwood now
  **probes** the device: a fresh or USB-mode signer answers (list or NACK) and
  proceeds as before; a silent one is recognised as a WiFi signer.

### Added

- **"This signer runs over WiFi" guidance.** When a silent (WiFi) signer is on
  the cable, Home now explains it's already set up and offers a one-click
  **Manage over WiFi** for devices you've used before — plus a tucked-away
  "set it up over the cable again" note covering the hold-PRG / RESET escape
  hatch, for re-provisioning or wiping.

## 0.6.1 — 2026-06-22

Fixes the on-device recovery phrase never appearing on screen.

### Fixed

- **The 12-word phrase now stays on the device's screen until you confirm.**
  In 0.6.0 the device drew the recovery phrase and then immediately redrew its
  idle/boot screen (and a WiFi signer rebooted ~1s later), so the words flashed
  and vanished — "no words actually got shown on the device". The firmware now
  holds the phrase on the OLED and waits for a deliberate **2-second button
  hold** before continuing, so you have as long as you need to write it down.
  Requires the bundled firmware shipped with this release.

### Changed

- The "Write down the words" step now tells you to **press and hold the button
  on the signer until its screen says "Saved"** (then a WiFi signer reboots and
  joins your network), matching the new firmware behaviour.

## 0.6.0 — 2026-06-22

The master recovery phrase is now generated and shown **only on the device** —
never in the browser.

### Changed

- **Your signer creates its own recovery phrase, on its own screen.** "Create a
  fresh identity" no longer generates the 12 words in the browser. Sapwood asks
  the device to generate (a new GENERATE_IDENTITY command carrying no secret);
  the device draws its own entropy, derives the master, and shows the 12-word
  phrase on its **OLED** for you to write down. The phrase never touches this
  computer — only the public npub comes back. The guided flow is now: name it →
  the device generates + displays the phrase → confirm you've written down the
  words shown **on the device** → done.
- **Firmware ships with the app.** The flasher's firmware binaries are no longer
  gitignored/hand-pushed — they're committed and deployed with the site, so the
  live flasher always serves the matching firmware.

### Note

- Importing an existing recovery phrase or nsec is unchanged (Advanced ›
  Provision) — that key legitimately originates outside the device.

## 0.5.4 — 2026-06-22

### Changed

- **Readable on desktop.** The admin was a narrow 860 px column of small, dim
  text. Now: a wider **1100 px** layout, a larger **18 px** base so the whole UI
  scales up, and **brighter** secondary/tertiary text (the muted grey actually
  failed contrast on the near-black background). The mobile layout is unchanged —
  full-width cards, no overflow.

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
