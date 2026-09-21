# KithMoot permissions

For a new pairing, choose **KithMoot private rooms** in **Connect an app**.
For an existing pairing, open the Apps panel and choose **Add KithMoot rooms**.
Review the complete resulting permissions, then confirm. USB changes also need
the signer's physical confirmation. Existing pairings are never expanded simply
because Sapwood or KithMoot updates.

The profile supports sign-in, device credentials, encrypted room bookmarks and
read positions:

| Permission | Purpose | Actual scope |
| --- | --- | --- |
| Kind 20460 | Device credentials | Includes person-scoped credentials; not limited to one room |
| Kind 21236 | Account sign-in proofs | Not restricted to KithMoot's origin |
| Kind 30078 | Bookmarks, read positions and account settings | The whole event kind, not only KithMoot's tags |
| NIP-44 encryption and decryption | Encrypted account state | Not restricted to a particular recipient or application |
| Public-key lookup and event signing | Use the approved identity and kinds | Existing persona approvals still apply |

Public posting, deletion, profile changes, NIP-04 and relay authentication are
not added by this profile. Optional features needing other permissions require
a separate decision. Room traffic signed with local device keys does not need
additional permissions on the hardware signer.

The existing-pairing action adds these permissions to the pairing's current
permissions. It keeps any broader permissions already granted, including an
unrestricted event-kind list. It preserves the pairing's keys, persona approvals
and automatic/manual choice. A manual pairing continues asking for signatures.
A pairing without signing approval must obtain that approval first.

With Bark, Cambium or My Signet, Heartwood may see the intermediary's pairing.
Its ceiling applies to every downstream app that intermediary permits. Keep
the intermediary's per-origin, native-app and persona approvals in place.

Sapwood checks the current pairing before writing and reads back the result. A
stale review is refused. A failed verification can mean the update applied but
could not be confirmed: refresh and review before trying again. These checks
are not an atomic lock against another manager changing policy concurrently.
USB has no credential compare-and-set; relay updates additionally check the
pairing credential fingerprint.
