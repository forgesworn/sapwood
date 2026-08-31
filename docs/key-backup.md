# Typed recovery words for an imported key

> **Untested alpha:** this format passes automated and cross-language tests,
> but the complete paper backup and Heartwood hardware restore ceremony has not
> run. Use a test key and keep an independent backup.

When you add an existing `nsec1...` or password-encrypted `ncryptsec1...`,
Sapwood can write it as **31 ForgeSworn recovery words**. The first seven words
identify the format, version, and exact recovery meaning. The remaining 24
words carry the key bytes using the BIP-39 English wordlist.

The complete 31-word sequence is deliberately not valid BIP-39. That prevents
a generic wallet from accepting it as a seed and silently deriving a different
identity.

## What is embedded

Typed recovery words carry:

- whether the nsec restores the **exact identity** or is the source for the
  frozen **nsec-tree v1** derivation;
- a public-key fingerprint, checked before the recovered key is accepted;
- a recovery checksum covering the type, flags, fingerprint, and secret
  payload; and
- the unencrypted 32-byte nsec payload.

Anyone with the words controls the identity. The fingerprint and checksum are
error detection, not encryption or authentication.

For an `ncryptsec`, the words contain the decrypted key. They do not need its
password later. If you selected **derive a fresh key**, that choice is embedded
too: restoring the words applies the same derivation and returns the same new
npub automatically.

## Making a backup

1. Start **Restore a key I already have** on Home, or add an identity from the
   advanced **Identity** screen.
2. Paste the `nsec` or `ncryptsec` and, for an encrypted key, enter its password.
3. Choose whether this signer keeps the exact npub or derives an nsec-tree root.
4. On **Check the address**, choose **Make typed recovery words first**.
5. Write all 31 words down in order and keep them offline.

The offer appears only while the key is available for import. A key already on
the signer cannot be read back out over any interface. If you skipped the
backup, re-import it from the original source.

The offline CLI performs the same exact-key conversion without opening a
device. Pipe or paste the secret through stdin; do not put an nsec directly on
the command line because argv and shell history can persist it. For
`ncryptsec`, the CLI accepts the password as the second stdin line or prompts
for it privately.

## Restoring

Paste the **complete sequence** anywhere Sapwood asks for recovery words. Its
embedded type selects exact-key, nsec-tree-nsec, or mnemonic-tree handling; the
address confirmation remains the final human check.

With current Heartwood firmware you can instead choose **Type the words on the
device** and select **31 words — typed ForgeSworn recovery**. This keeps the
secret off the browser and cable. The offline `heartwood-provision` CLI also
recognises the typed sequence and ignores a conflicting legacy `--mode`
selection.

## Historical 24-word backups

Sapwood versions before ForgeSworn Recovery Words v1 emitted only the 24-word
BIP-39 payload. Those words remain recoverable, but they carry no type,
derivation version, or fingerprint. Restore them through the UI's explicit
**legacy 24-word** path and state whether they were an exact key or an
nsec-tree source.

Never guess from word count or validity: a historical 24-word key backup is
also a valid BIP-39 mnemonic and produces a different key if treated as a seed.
The legacy distinction must come from the record made with the old backup.

## Technical format

The canonical specification and frozen vectors live in
[`nsec-tree/RECOVERY.md`](https://github.com/forgesworn/nsec-tree/blob/main/RECOVERY.md).
Sapwood, nsec-tree, and Heartwood pin the same mnemonic, raw scalar-one, and
tree scalar-one vectors in TypeScript and Rust tests.

For Shamir splitting, compact the complete typed sequence with nsec-tree's
`recoveryWordsToBytes()` and use `@forgesworn/shamir-words`
`splitSecretToWordsV3()` / `reconstructWordsV3()` with `payloadKind:
'forgesworn-recovery-words-v1'`. Its original-secret fingerprint rejects shares
mixed across separate split operations. Historical Shamir v2 shares are still
decoded explicitly as opaque; their meaning is never inferred.
