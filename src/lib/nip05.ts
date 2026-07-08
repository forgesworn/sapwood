// NIP-05 bunker discovery: build the /.well-known/nostr.json document that
// lets a user type name@domain into a client's bunker field instead of pasting
// a bunker:// URI. Clients that support discovery (Primal web among them)
// fetch https://domain/.well-known/nostr.json?name=<name>, read names[name]
// for the signer pubkey and nip46[pubkey] for its relays, then send a NIP-46
// connect with no secret. The signer's stranger path answers it: pubkey and
// connect are auto-approved, every signature asks for the physical button.

/** NIP-05 local part: a-z0-9, dash, underscore, dot. Case-insensitive. */
export function isValidNip05Name(name: string): boolean {
  return /^[a-z0-9\-_.]+$/i.test(name)
}

/** A 64-char lowercase hex pubkey, the only key format nostr.json accepts. */
export function isHexPubkey(hex: string): boolean {
  return /^[0-9a-f]{64}$/.test(hex)
}

/**
 * Build the nostr.json document for one identity. Returns pretty-printed JSON
 * ready to host at /.well-known/nostr.json.
 *
 * Only wss:// relays are included: discovery happens from browser clients, and
 * a ws:// relay in the list would fail their mixed-content rules anyway.
 */
export function buildNostrJson(name: string, pubkeyHex: string, relays: string[]): string {
  if (!isValidNip05Name(name)) throw new Error('Name may only use letters, digits, dash, underscore and dot.')
  if (!isHexPubkey(pubkeyHex)) throw new Error('Identity pubkey must be 64-character hex.')
  const wss = relays.map((r) => r.trim()).filter((r) => r.startsWith('wss://'))
  if (wss.length === 0) throw new Error('The signer needs at least one wss:// relay for discovery.')
  const doc = {
    names: { [name.toLowerCase()]: pubkeyHex },
    nip46: { [pubkeyHex]: wss },
  }
  return JSON.stringify(doc, null, 2)
}

/** The identifier users type into a client. `_` is NIP-05's "just the domain" name. */
export function nip05Identifier(name: string, domain: string): string {
  const d = domain.trim().replace(/^https?:\/\//, '').replace(/\/.*$/, '')
  return name === '_' ? d : `${name.toLowerCase()}@${d}`
}
