# Goal

Set 2026-07-04. Tracked across `sapwood` and `heartwood-esp32`.

## 1. Sapwood vs. other device flashers

Compare Sapwood's flashing/setup flow against other hardware signer and
hardware wallet flashers (e.g. Trezor Suite, Ledger Live, ColdCard, SeedSigner,
Krux, Jade, Foundation Passport, and similar guided web/desktop flashers).

Questions to answer:

- Are there features those flashers have that Sapwood is missing?
- Are there UI/UX changes that would make Sapwood's flow as simple and
  friendly to follow as the best of that field, for a non-technical user
  going through it for the first time?

## 2. Heartwood key restore UX (LilyGo firmware)

Heartwood firmware work is currently focused on the LilyGo board. That board
gives us two usable physical buttons (a main button plus a separate reset
button), where earlier Heltec-based work only had one.

Design the simplest possible restore-key interaction using this button
budget:

- Use click / double-click / long-press as the input vocabulary, mapped to
  distinct restore-related actions.
- Be careful with timing thresholds (double-click window, long-press
  duration) so the device doesn't misread deliberate input as noise, or
  noise as deliberate input.
- The device display must always make it obvious, in the moment, what the
  user needs to press and why, so nobody has to guess or consult a manual
  mid-restore.

## Deliverable

A concrete comparison (Sapwood vs. field) with a prioritised gap list, plus a
button-interaction design for restore (mapping, timings, on-screen prompts)
that's ready to implement in the LilyGo firmware.

## 3. Restore journey — guided existing-key restore + clearer signing prompts

Set 2026-07-05. Tracked across `sapwood` and `heartwood-esp32`. Delivers on the
friendliness half of goals 1 and 2 above.

Going through it revealed the restore-from-nsec journey drops the owner off the
guided rail into the advanced console, with no sequencing (add an identity
before an app), a rawer connect flow, a profile-card push that silently fails in
the post-provision reboot window (so the signer shows no kind-0 avatar until a
manual reconnect), and firmware sign prompts that show truncated event JSON and a
countdown but never say what to press (so an unheld prompt reads as an
unexplained red DENIED). This goal brings existing-key restore onto the guided
rail and makes the on-device prompts self-explanatory.

### Sapwood

- [x] `src/lib/restore.ts` (+ tests): nsec / ncryptsec (NIP-49 via
      `nostr-tools/nip49`) / phrase validation and decode, mirroring signet-lite's
      `engine/nsec.ts`. Reuses `provision.ts` crypto; no duplication.
- [x] Rework `FirstIdentity.svelte` into a sequenced guided restore: Create fresh
      vs Restore; source = 12/24 words (type-on-device [default, most private] or
      paste here), an nsec, or an encrypted key (ncryptsec) + password;
      nsec/ncryptsec then choose keep-my-npub (bunker) or new-npub (tree-nsec).
      Confirm-npub step, then send over USB (`provisionSecret`).
- [x] Carry the pasted-secret security note on the paste paths; keep the
      untouched-secret promise on the create + on-device-entry paths.
- [x] Profile logo: reset `autoSyncIdentityMeta`'s per-npub attempt cap on a fresh
      connect (`resetIdMetaSync`), so a reconnect — and the WiFi handoff — retries
      the identity-card push instead of staying given-up; the done screen says the
      picture syncs automatically. (No fragile mid-flow "syncing" screen: firmware
      confirms the flow hands off to the signer card after provision either way.)
- [x] Advanced fall-through: with no identity, `openAdvanced` lands the console on
      Identity with "Add an identity" open; Apps shows a no-identity notice that
      points there; the intro's old raw-key link is now the guided restore, with a
      plain "Open the advanced console" escape hatch.

### heartwood-esp32 (firmware)

- [x] `firmware/src/oled.rs`: `show_sign_request` (the live prompt) and
      `show_master_sign_request` (dead code, updated for parity) gain an explicit
      "Hold the button to sign" line; the master screen now reads `SIGN AS {label}?`.
      The signing timeout reads "Not signed" (was "Timed out"); DANGER stays on the
      early-release `DENIED` only. Needs an on-device `cargo build` + flash to
      confirm the reflowed layout on the 64px panel (no IDF in this environment).

### Acceptance

- Restore from nsec / ncryptsec / a pasted phrase completes without ever leaving
  Home.
- The signer shows its kind-0 avatar after a first restore, no manual reconnect.
- On-device sign prompts state what to press; an unheld prompt does not read as an
  error.
- `npm test` + `npm run build` green; firmware `cargo build` green.

### Shipped (2026-07-05)

- **heartwood-esp32 v0.10.4** tagged; release CI built every board, ed25519-signed
  each image with the CI seed, and published the release. The reflowed sign screen
  was visually verified host-side via `ui-preview` (SIGN AS {label}? + the explicit
  "Hold the button to sign" line clears the countdown bar on 128x64 and the portrait
  panels). Only a physical flash-and-tap remains as a nicety, not a gate.
- **sapwood**: `npm run sync:firmware v0.10.4` pulled the signed images in; committed
  as `chore: sync signed firmware v0.10.4`. CI (check + unit + e2e) green after
  fixing a stale guided-setup e2e locator; both deploys (GitHub Pages + Hetzner)
  succeeded. `sapwood.forgesworn.dev` and the Pages mirror now serve v0.10.4.
