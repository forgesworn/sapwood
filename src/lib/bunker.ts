// Helpers for bunker:// links — the signer-issued NIP-46 connection URI.
// Format: bunker://<remote-signer-pubkey-hex>?relay=<wss>&...&secret=<hex>

/**
 * A bunker link is only reachable by a remote app if it names at least one
 * relay. A hardened (USB-only, radio off) signer has no relays, so the link it
 * emits is bare (`bunker://<pubkey>?secret=...`) and no remote client — Primal,
 * say — can connect to it: the client reports "no relays specified for this
 * bunker". Use this to warn before handing such a link out as if it worked.
 */
export function bunkerHasRelay(uri: string): boolean {
  return /[?&]relay=/.test(uri)
}
