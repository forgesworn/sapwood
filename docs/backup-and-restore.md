# Backup and restore

> **Untested alpha:** the typed Recovery Words v1 paths on this page pass the
> automated suites but have not completed the physical Heartwood write-down,
> wipe, and restore matrix. Use test keys only and retain an independent backup.

A Heartwood signer keeps its secrets on the device, where no interface can read
them back out. That is the security model, not a gap. It also means backups have
to be made at the right moment, and there is more than one thing worth backing
up. This page is the map. Typed recovery words have their [own page](key-backup.md)
for the detail.

There are up to **three** separate secrets in play, each backed up and restored a
different way:

| Secret | What it is | Back it up by | Restore it by | Without it |
|--------|-----------|---------------|---------------|------------|
| **Identity key** (created on the device) | 19 or 31 typed words shown when you create an identity | writing down the complete sequence shown on the device | typing 19/31 words back on the device, or pasting them in the guided restore | that identity, and its npub, cannot be recreated |
| **Identity key** (imported) | 31 typed [recovery words](key-backup.md) for an `nsec`/`ncryptsec` you brought in | choosing **Make typed recovery words first** while importing | pasting or typing the complete words; their embedded type restores the same derivation | if you skipped it, re-import the key from wherever it came from |
| **Operator key** | this browser's authority to manage the signer over WiFi | writing down its 12-word recovery phrase (Home nudge, or Identity › Operator key) | pasting the phrase into Identity › Operator key › **Restore key** | you cannot manage the signer remotely until you rotate the operator over USB |

Two more things round it out, covered below: **derived (named) identities**, which
need no secret of their own ([section 3](#3-derived-named-identities)), and your
**app pairings**, which can be backed up to an encrypted file
([section 4](#4-connected-apps-app-pairings)).

## 1. The identity key

This is the secret the signer signs with. How you back it up depends on where the
key came from.

### Created on the device

When you choose **Create a fresh identity**, the device generates its own seed and
shows **19 typed words** for a 128-bit payload, or **31 typed words** for a
256-bit payload, on its own screen. The words never appear in the browser.
Write the complete sequence down in order and keep it offline. They are
the only backup of that identity.

To restore: connect over USB, choose **Restore a key I already have**, then
**Type the words on the device**, choose 19 or 31 typed words, and enter them on
the device itself (most private, the words never touch the browser). You can
also paste them; their derivation is selected automatically. A typed mnemonic
backup that requires a separate BIP-39 passphrase must use the paste or offline
CLI path, because the signer buttons cannot enter an arbitrary passphrase.

### Imported into the device

When you bring in an existing key (an `nsec1…`, or a password-encrypted
`ncryptsec1…`), Sapwood offers to write it out as **31 typed words** that embed
whether the exact npub or an nsec-tree-derived identity must return. It has a
dedicated page: **[Typed recovery words for an imported key](key-backup.md)**.

The offer only appears while you are importing. Once a key is on the signer it can
never be read back out, so if you skip the backup the only way to make one later is
to re-import the key from its original source.

You can also make this backup offline, from a key you already hold, without a
device: pipe it into the command line console, `... | sapwood key backup`. It runs
the same encoding and never opens the signer.

## 2. The operator key

The operator key is separate from, and lower-stakes than, the identity key. It is
**this browser's authority to manage the signer over WiFi**: it never signs your
events and it is not the master seed. A signer learns which operator to trust when
it is flashed, and accepts remote management only from that key.

Losing it does not lose your identity or your funds. It loses your ability to
manage the signer *remotely*: you would have to plug in over USB and rotate the
operator (Identity › Operator key › **Set this browser as operator**, which
preserves the saved WiFi and relays).

Back it up: on **Home**, the "Back up your operator key" card shows the phrase once;
or any time under **Identity › Operator key**, where **Reveal** shows its 12-word
recovery phrase. Write the words down and you can recreate the exact same operator
key in any browser.

Restore it: **Identity › Operator key**, paste the phrase into the **Restore key**
field. After restoring, disconnect and reconnect over WiFi. This is also the fix for
"Sapwood reaches the relay but the signer never answers": that symptom usually
means this browser holds a different operator key than the one the signer was
flashed with.

At the command line, `sapwood operator new` mints an operator key (phrase, pubkey
and secret) and `sapwood operator restore` recovers it from the phrase. Both are
offline. This suits a headless bridge host: the pubkey goes into the signer at flash
time, and the secret into the bridge daemon as `NOSTR_SECRET_KEY`.

> Operators created before recovery phrases existed are a raw 64-hex secret with no
> phrase. They keep working, but there is nothing to write down; back up the 64-hex
> secret instead, or **Regenerate** to a phrase-backed key (which needs a re-flash to
> take effect on the signer).

## 3. Derived (named) identities

A named identity is **derived from a master the signer already holds**: you type a
name, and the signer derives the nsec-tree child on-device (no secret in the
browser). Because it is deterministic, it needs no backup of its own: it is fully
recreated from **the master's backup plus the name**.

So the only thing to record is the **name** (and that it was derived from that
master). Keep it written down alongside the master's recovery phrase; both are
needed to recreate the identity. Restore the master, derive the same name, and the
same npub returns.

## 4. Connected apps (app pairings)

Each app you connect gets its own **connection slot** on the signer: a random
per-app secret plus its signing policy (allowed methods, kinds, auto-approve).
These live only in the device's storage, so a factory reset or a reflash wipes
them and every app has to pair again. Unlike the keys above, the pairings **can**
be backed up and restored.

Back it up: **Device › Backup and restore › Export a backup** (USB only). You set a
passphrase; the signer asks you to confirm on its button, then Sapwood downloads an
**encrypted** file (Argon2id + XChaCha20-Poly1305). The file holds the app secrets
and the bridge secret, so it is only ever written encrypted; keep the file and its
passphrase together, and safe. Losing the passphrase makes the file unrecoverable.

Restore it: re-provision your identities first (a backup only restores pairings for
identities the signer already holds), then **Device › Backup and restore › Restore a
backup**. Pick the file, enter the passphrase, and Sapwood previews which identities
match before you confirm the restore on the signer's button.

At the command line: `sapwood backup export` writes the encrypted file, and
`sapwood backup import <file>` restores it. Both are button-confirmed on the device.

## What is not backed up

- **Bearer notes.** Deliberately excluded: a bearer note restored onto two signers
  is two claims on the same money — the second spend double-spends the first. Notes
  live only on the signer that holds them; withdraw or transfer them before a
  factory reset.
- **Device settings.** The boot PIN is local device state and is not part of any
  backup. (The bridge secret *is* included in the app-pairing backup above.)
- **Anything, after the fact.** Key secrets cannot be read back off the signer over
  any interface. Every key backup above is made at creation or import time. Plan for
  it then. (App-pairing backup is the exception: it can be taken any time over USB.)

## Quick reference: where each control lives

| You want to… | Go to |
|--------------|-------|
| See the 19/31 typed words for a **created** identity | the device's own screen, at creation |
| Make typed words for a key you are importing | the "Check the address" step, while importing |
| See or copy the **operator** recovery phrase | Home backup card, or Identity › Operator key › Reveal |
| Back up **connected apps** | Device › Backup and restore › Export a backup |
| **Restore an identity** | Home › Restore a key I already have |
| **Restore the operator key** | Identity › Operator key › Restore key |
| **Restore connected apps** | Device › Backup and restore › Restore a backup |
| Recreate a **named** identity | Identity › add identity, same master, same name |
