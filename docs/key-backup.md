# The 24-word key backup

When you add an existing key to a signer (an `nsec1...` or a password-encrypted
`ncryptsec1...`), Sapwood offers to write it out as 24 words. Words are easier
to copy onto paper without error than a bech32 string, and they restore the
same identity, with the same npub, later -- in Sapwood or through the offline
provision CLI.

## What the words are (and are not)

The 24 words are the key itself: its 32 bytes encoded with the BIP-39 wordlist,
the way a wallet encodes entropy. They are **not** a seed phrase. Nothing is
derived from them; decoding gives back the byte-identical key, so the identical
npub.

This is also why the backup is always 24 words and never 12. A Nostr key is
256 bits; a 12-word phrase carries only 128 bits, so it can never hold an
existing key. Only a freshly *created* identity can start from 12 words,
because there the words come first and the key is derived from them.

One caveat follows from the encoding: a standard wallet or NIP-06 tool reading
these 24 words would treat them as a seed phrase and derive a *different* key.
Restore them in Sapwood or the provision CLI, which know the difference and
ask.

## Making a backup

1. Connect the signer over USB. On a signer with no identity yet, choose
   **Restore a key I already have** on Home; on one that already has
   identities, add one from **Identity** in the advanced console.
2. Pick **An nsec** or **An encrypted key** and paste it. For an encrypted key,
   enter its password.
3. On the **Check the address** step, choose **Back up this key as 24 words
   first**.
4. Write the words down on paper, in order, and keep them offline. Then send
   the key to the signer as normal.

Two things worth knowing:

- **Encrypted keys.** The words are the decrypted key. They are not protected
  by the password, which also means they outlive a forgotten one: the words
  alone bring the identity back.
- **If you chose "Derive a fresh key".** The words back up the key you pasted,
  not the derived one. Pick the same option again when restoring and the same
  new address comes back.

The offer appears only while you are importing a key. Once a key is on the
signer it can never be read back out, over any interface. That is the security
model, not a missing feature: if you skipped the backup, the only way to make
one is to re-import the key from wherever it came from.

At the command line, the same conversion is available offline for a key you
already hold: `... | sapwood key backup` reads an `nsec` (or an `ncryptsec` and
its password) on stdin and prints the 24 words. It never touches a device.

## Restoring

Three interchangeable ways, all producing the same npub:

- **Guided flow.** Choose **Restore a key I already have**, then **12 or 24
  words, pasted here**. Paste the words; Sapwood asks **which kind of words
  these are** -- pick **A key backup made here**. Check the address matches,
  then send.
- **Advanced console.** In **Identity**, pick either existing-nsec mode and
  paste the 24 words where the nsec goes.
- **Offline CLI.** In [heartwood-esp32](https://github.com/forgesworn/heartwood-esp32),
  run `heartwood-provision --port <port> provision --mode bunker` and paste the
  words at the key prompt. Use `--mode tree-nsec` if the key was imported with
  "Derive a fresh key".

Key backups are pasted, not typed on the device: the signer's on-screen word
entry is for 12-word recovery phrases only.

If you paste the words and leave them marked as a seed phrase, Sapwood will
derive a different, unfamiliar npub -- the address confirmation step is there
to catch exactly that. Go back and mark them as a key backup.

## Keeping the words safe

The words are the unencrypted key. Anyone who has them controls the identity,
permanently. Write them on paper or metal, keep them offline, and treat them
with the same care as the nsec they encode.

## Technical note

Encoding: `mnemonic = entropyToMnemonic(secret_32_bytes)` per BIP-39, English
wordlist; decoding reverses it and rejects anything other than 24 valid words.
Implementations: `keyToWords`/`wordsToKey` in [`src/lib/restore.ts`](../src/lib/restore.ts)
and `decode_key_input` in heartwood-esp32's `provision/src/main.rs`. A frozen
cross-implementation vector (the scalar-1 key encodes as 23 `abandon`s and
`diesel`) is pinned by tests in both repos, so the two sides cannot drift
apart silently.
