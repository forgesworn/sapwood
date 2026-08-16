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

/**
 * Re-address a bunker URI to a different endpoint pubkey. The connection slot
 * itself is endpoint-agnostic — the firmware routes each request by its `#p`
 * tag — but apps pin their signer identity from the URI's authority part, so a
 * persona pairing needs the persona's pubkey THERE (D2). Throws on anything
 * that is not a canonical bunker URI or a 64-hex endpoint, so a mangled link
 * can never be handed out.
 */
export function bunkerUriWithEndpoint(uri: string, endpointHex: string): string {
  if (!/^[0-9a-f]{64}$/.test(endpointHex)) {
    throw new Error('endpoint must be 64 lowercase hex characters')
  }
  const m = /^bunker:\/\/[0-9a-fA-F]{64}(\?.*)?$/.exec(uri)
  if (!m) throw new Error('not a bunker:// URI')
  return `bunker://${endpointHex}${m[1] ?? ''}`
}
