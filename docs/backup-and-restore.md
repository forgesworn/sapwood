# Backup and restore

A Heartwood signer keeps its secrets on the device, where no interface can read
them back out. That is the security model, not a gap. It also means backups have
to be made at the right moment, and there is more than one thing worth backing
up. This page is the map. The 24-word key backup has its [own page](key-backup.md)
for the detail.

There are up to **three** separate secrets in play, each backed up and restored a
different way:

| Secret | What it is | Back it up by | Restore it by | Without it |
|--------|-----------|---------------|---------------|------------|
| **Identity key** (created on the device) | the 12-word phrase the device shows when you create an identity | writing down the 12 words shown on the device's own screen | typing the 12 words back on the device, or pasting them in the guided restore | that identity, and its npub, cannot be recreated |
| **Identity key** (imported) | a 24-word [key backup](key-backup.md) of an `nsec`/`ncryptsec` you brought in | choosing **Back up this key as 24 words** while importing | pasting the 24 words (marked as a key backup), or the original `nsec`/`ncryptsec` | if you skipped it, re-import the key from wherever it came from |
| **Operator key** | this browser's authority to manage the signer over WiFi | writing down its 12-word recovery phrase (Home nudge, or Identity › Operator key) | pasting the phrase into Identity › Operator key › **Restore key** | you cannot manage the signer remotely until you rotate the operator over USB |

A fourth case, **derived (named) identities**, needs no secret of its own: see
[below](#3-derived-named-identities).

## 1. The identity key

This is the secret the signer signs with. How you back it up depends on where the
key came from.

### Created on the device

When you choose **Create a fresh identity**, the device generates its own seed and
shows a **12-word recovery phrase on its own screen**. The phrase never appears in
the browser. Write those 12 words down, in order, and keep them offline. They are
the only backup of that identity.

To restore: connect over USB, choose **Restore a key I already have**, then
**Type the words on the device**, and re-enter the 12 words on the device itself
(most private, the words never touch the browser). You can also paste them in the
guided flow, left marked as a recovery phrase.

### Imported into the device

When you bring in an existing key (an `nsec1…`, or a password-encrypted
`ncryptsec1…`), Sapwood offers to write it out as **24 words** that restore the
identical npub. This is the one to reach for when the key started life somewhere
else. It has a dedicated page: **[The 24-word key backup](key-backup.md)** covers
what the words are, how they differ from a seed phrase, and all three ways to
restore them.

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

## What is not backed up

- **Connected apps.** Per-app connection slots and their signing policies live only
  on the device. A factory reset or a reflash wipes them, and each app must connect
  again. Backing them up is not yet available in Sapwood; keep a note of which apps
  you had connected.
- **Device settings.** The boot PIN and bridge secret are local device state, not
  part of any key backup.
- **Anything, after the fact.** Secrets cannot be read back off the signer over any
  interface. Every backup above is made at creation or import time. Plan for it then.

## Quick reference: where each control lives

| You want to… | Go to |
|--------------|-------|
| See the 12 words for a **created** identity | the device's own screen, at creation |
| Make a **24-word backup** of a key you are importing | the "Check the address" step, while importing |
| See or copy the **operator** recovery phrase | Home backup card, or Identity › Operator key › Reveal |
| **Restore an identity** | Home › Restore a key I already have |
| **Restore the operator key** | Identity › Operator key › Restore key |
| Recreate a **named** identity | Identity › add identity, same master, same name |
