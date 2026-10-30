# V4V permissions

For a new pairing, choose **Sign in only**, **V4V listener** or **V4V artist**
in **Connect an app**. For an existing pairing, open the Apps panel, pick the
preset under **Add preset**, review the complete permissions it will have and
confirm. The preset is added to what the app already has; nothing is removed.
**Sign in only** is the smallest one a pairing needs before V4V's sign-in stops
asking for a press. USB changes also need the signer's physical confirmation.
Existing pairings are never expanded simply because Sapwood or V4V updates.

**Sign in only** grants kind 21236 and nothing else. It is the narrowest way
to let a site that signs in with Signet, such as V4V or KithMoot, prove the
account without a press; every other signature still asks.

**V4V listener** covers what a listener asks their signer for:

| Permission | Purpose | Actual scope |
| --- | --- | --- |
| Kind 21236 | Account sign-in proofs | Not restricted to V4V's origin |
| Kind 9734 | Zap requests for tips | Any zap request; the wallet still decides what it pays |
| Kind 1311 | Live stage chat | Any live chat message |
| Kinds 1 and 5 | Playlist sharing and its deletion | Any note or deletion request |
| Kind 30003 | The listener's library set | Any bookmark set |
| Kind 30315 | Listening status, which V4V keeps off by default | Any user status |
| Kind 30078 | The encrypted portable entitlement list | The whole event kind, not only V4V's tags |
| Kind 27201 | Proves ownership of purchases to read the library | V4V only uses it |
| NIP-44 encryption and decryption | Unlocking paid releases and the entitlement list | Not restricted to a particular recipient or application |
| Public-key lookup and event signing | Use the approved identity and kinds | Existing persona approvals still apply |

**V4V artist** adds the kinds that set or move money terms, so pair only a
device you control:

| Permission | Purpose |
| --- | --- |
| Kind 30808 | Publishing a gated release |
| Kind 27117 | Authorising a release's key deposit or re-price |
| Kind 27118 | Releasing a gated key to a public source |
| Kind 27202 | Reading and settling the artist's sales |

Profile, contacts, relay list, NIP-04 and relay authentication are not added by
either profile. Swarm and stage traffic signed with local viewer keys does not
need permissions on the hardware signer, and an Android sign-in through
Cambium or Amber is identity-only: it signs the person in and nothing else.

With Bark, Cambium or My Signet, Heartwood may see the intermediary's pairing.
Its ceiling applies to every downstream app that intermediary permits. Keep
the intermediary's per-origin, native-app and persona approvals in place.
