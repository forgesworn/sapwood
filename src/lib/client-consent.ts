import type { ClientApproval } from './types.js'

/** Keep unknown legacy scope distinct from a known empty consent table. */
export function parseClientApprovals(value: unknown): ClientApproval[] | undefined {
  if (value == null) return undefined
  if (!Array.isArray(value) || value.length > 8) throw new Error('Malformed device consent')
  const clients = new Set<string>()
  return value.map((item: unknown) => {
    if (!item || typeof item !== 'object') throw new Error('Malformed device consent')
    const row = item as Record<string, unknown>
    const client = row.client_pubkey
    if (typeof client !== 'string' || !/^[0-9a-f]{64}$/.test(client) || clients.has(client)) {
      throw new Error('Malformed consent client')
    }
    clients.add(client)
    const keys = (raw: unknown, pattern: RegExp): string[] => {
      if (!Array.isArray(raw) || raw.length > 17 || raw.some(k => typeof k !== 'string' || !pattern.test(k))) {
        throw new Error('Malformed persona consent')
      }
      if (new Set(raw).size !== raw.length) throw new Error('Duplicate persona consent')
      return [...raw] as string[]
    }
    return {
      client_pubkey: client,
      approved_identities: keys(row.approved_identities, /^[0-9a-f]{64}$/),
      legacy_identity_tags: keys(row.legacy_identity_tags, /^[0-9a-f]{16}$/),
    }
  })
}

export function consentScope(value: ClientApproval[] | undefined): string {
  if (value === undefined) return 'legacy'
  return JSON.stringify(value.map(row => [row.client_pubkey,
    [...row.approved_identities].sort(), [...row.legacy_identity_tags].sort(),
  ]).sort((a, b) => String(a[0]).localeCompare(String(b[0]))))
}
