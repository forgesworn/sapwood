// The rule a Heartwood applies to a relay address it is asked to hold over
// USB patches and remote changes (heartwood-esp32 common/src/net_config.rs,
// `validate`): wss:// only, at most 255 bytes, a plain ASCII host, port 443 or
// none, no credentials, no path beyond "/", no whitespace or control
// characters. A saved default relay set and anything seeded to a board must
// pass it, or the board is later read back as malformed. Pure, so both
// wizard.ts and device.svelte.ts can use it without importing each other.

function utf8Length(value: string): number {
  return new TextEncoder().encode(value).length
}

/** Why a Heartwood would refuse this relay address, or null when it would take
 *  it. Case matters here exactly as it does on the signer (the scheme is
 *  lower-case). The message is fit to show. */
export function relayAddressProblem(relay: string): string | null {
  if (!relay.startsWith('wss://')) {
    return `Remote relay addresses must start with wss:// (${relay})`
  }
  if (utf8Length(relay) > 255) return 'Remote relay addresses must be no longer than 255 bytes.'
  if ([...relay].some((char) => /\s/.test(char) || char.codePointAt(0)! < 0x20 || char.codePointAt(0) === 0x7f)) {
    return `Remote relay addresses cannot contain whitespace or control characters (${relay})`
  }

  const afterScheme = relay.slice(6)
  const suffixAt = afterScheme.search(/[/?#]/)
  const authority = suffixAt === -1 ? afterScheme : afterScheme.slice(0, suffixAt)
  const suffix = suffixAt === -1 ? '' : afterScheme.slice(suffixAt)
  if (authority.includes('@')) {
    return `Remote relay addresses cannot contain credentials (${relay})`
  }
  const host = authority.split(':')[0] ?? ''
  if (!host
    || !/[A-Za-z0-9]/.test(host)
    || !/^[A-Za-z0-9.-]+$/.test(host)) {
    return `Remote relay addresses require an ASCII hostname using letters, digits, dots, or hyphens (${relay})`
  }
  const port = authority.slice(host.length)
  if (port && port !== ':443') {
    return `Remote relay URL ports must be 443 (${relay})`
  }
  if (suffix && suffix !== '/') {
    return `Remote relay URL paths, queries, and fragments are not supported (${relay})`
  }
  return null
}
