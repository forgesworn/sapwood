import { describe, it, expect } from 'vitest'
import { parseClientApprovals, consentScope } from './client-consent.js'
const a = 'aa'.repeat(32), b = 'bb'.repeat(32), id = 'cc'.repeat(32)
const row = (client = a) => ({ client_pubkey: client, approved_identities: [id], legacy_identity_tags: ['dd'.repeat(8)] })
describe('client consent wire data', () => {
  it('distinguishes old firmware from a known empty table', () => {
    expect(parseClientApprovals(undefined)).toBeUndefined()
    expect(parseClientApprovals(null)).toBeUndefined()
    expect(parseClientApprovals([])).toEqual([])
    expect(consentScope(undefined)).not.toBe(consentScope([]))
  })
  it('rejects malformed and duplicate clients or identities', () => {
    for (const raw of [{}, [row(), row()], [{ ...row(), client_pubkey: 'bad' }],
      [{ ...row(), approved_identities: [id, id] }], [{ ...row(), legacy_identity_tags: [id] }]]) {
      expect(() => parseClientApprovals(raw)).toThrow()
    }
  })
  it('preserves per-client scope, while ignoring presentation order', () => {
    const parsed = parseClientApprovals([row(), row(b)])!
    expect(parsed).toEqual([row(), row(b)])
    expect(consentScope(parsed)).toBe(consentScope([...parsed].reverse()))
    expect(consentScope(parsed)).not.toBe(consentScope([{ ...row(), approved_identities: [] }, row(b)]))
  })
})
