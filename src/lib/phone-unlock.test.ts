import { describe, expect, it, vi } from 'vitest'
import { verifyEvent } from 'nostr-tools/pure'
import {
  HANDOFF_KIND, HandOffUndelivered, buildHandOffEvent, checkCode, enrolPhone, inferUnlockMode,
  parseEnrolAnswer, parseEnrolmentCode, parsePhoneList,
} from './phone-unlock.js'

const P = 'a1'.repeat(32)
const R = 'b2'.repeat(16)
const E = 'ab'.repeat(32)
// As Cambium encodes it (URLEncoder: space as +, : and / escaped).
const CODE = `heartwood-unlock:enrol?v=1&p=${P}&r=${R}&label=Pixel+8+Pro`
  + '&relay=wss%3A%2F%2Frelay.example&relay=wss%3A%2F%2Ftwo.example'

describe('parseEnrolmentCode', () => {
  it('reads the code Cambium shows', () => {
    expect(parseEnrolmentCode(CODE)).toEqual({
      enrolPubkey: P, rendezvous: R, label: 'Pixel 8 Pro',
      relays: ['wss://relay.example', 'wss://two.example'],
    })
  })

  it('tolerates whitespace from a paste', () => {
    expect(parseEnrolmentCode(`  ${CODE}\n`)?.label).toBe('Pixel 8 Pro')
  })

  it.each([
    ['another scheme', CODE.replace('heartwood-unlock:', 'nostr:')],
    ['another version', CODE.replace('v=1', 'v=2')],
    ['a short key', CODE.replace(`p=${P}`, `p=${P.slice(2)}`)],
    ['an uppercase key', CODE.replace(`p=${P}`, `p=${P.toUpperCase()}`)],
    ['a short rendezvous', CODE.replace(`r=${R}`, `r=${R.slice(2)}`)],
    ['a repeated key', `${CODE}&p=${P}`],
    ['no relay', CODE.split('&relay=')[0]],
    ['a relay that is not a websocket', CODE.replace('wss%3A%2F%2Ftwo.example', 'https%3A%2F%2Ftwo.example')],
    ['an empty label', CODE.replace('label=Pixel+8+Pro', 'label=+')],
    ['a label over 16 bytes', CODE.replace('label=Pixel+8+Pro', 'label=' + encodeURIComponent('ééééééééé'))],
    ['broken percent encoding', CODE.replace('label=Pixel+8+Pro', 'label=%E0%A4%A')],
  ])('refuses %s', (_, code) => {
    expect(parseEnrolmentCode(code)).toBeNull()
  })
})

describe('checkCode', () => {
  // The vectors Cambium and the bench script are held to (spoken-token 2.1.0).
  it('matches the shared vectors', () => {
    expect(checkCode('ab'.repeat(32))).toBe('9B6 164')
    expect(checkCode('00'.repeat(32))).toBe('EF1 645')
  })

  it('refuses a key that is not 32 bytes of hex', () => {
    expect(() => checkCode('ab')).toThrow()
  })
})

describe('parsePhoneList', () => {
  it('reads ids and labels and fails closed on bad rows', () => {
    expect(parsePhoneList({
      phones: [{ id: 3106288131, label: 'Pixel' }, { id: -1, label: 'x' }, { label: 'no id' }, { id: 7 }],
      max: 16,
      announce_operator: false,
    })).toEqual({
      phones: [{ id: 3106288131, label: 'Pixel' }, { id: 7, label: 'phone' }],
      max: 16,
      announceOperator: false,
    })
  })

  it('refuses an answer without a list', () => {
    expect(() => parsePhoneList({ max: 16 })).toThrow()
  })
})

describe('buildHandOffEvent', () => {
  it('carries the board answer from a fresh key, tagged only with the rendezvous', () => {
    const answer = { id: 42, ephemeralPubkey: E, sealed: 'ciphertext' }
    const a = buildHandOffEvent(answer, R, 1_700_000_000_000)
    const b = buildHandOffEvent(answer, R, 1_700_000_000_000)
    expect(a.kind).toBe(HANDOFF_KIND)
    expect(a.tags).toEqual([['h', R]])
    expect(a.created_at).toBe(1_700_000_000)
    expect(JSON.parse(a.content)).toEqual({ id: 42, ephemeral_pubkey: E, sealed: 'ciphertext' })
    expect(verifyEvent(a)).toBe(true)
    expect(a.pubkey).not.toBe(b.pubkey)
  })
})

describe('parseEnrolAnswer', () => {
  it('refuses an answer with no hand-off key', () => {
    expect(() => parseEnrolAnswer({ id: 1, sealed: 'x' })).toThrow()
  })
})

function fakePool(reachable: string[], accepting: string[]) {
  const order: string[] = []
  const published: unknown[] = []
  return {
    order,
    published,
    ensureRelay: vi.fn(async (url: string) => {
      order.push(`open ${url}`)
      if (!reachable.includes(url)) throw new Error('unreachable')
      return {} as never
    }),
    publish: vi.fn((relays: string[], event: unknown) => {
      published.push(event)
      return relays.map((url) => accepting.includes(url)
        ? Promise.resolve('')
        : Promise.reject(new Error('blocked')))
    }),
  }
}

describe('enrolPhone', () => {
  const code = parseEnrolmentCode(CODE)!
  const answer = { id: 9, ephemeral_pubkey: E, sealed: 'ciphertext' }

  it('opens the relays, asks the board once, then hands off to the relays that answered', async () => {
    const pool = fakePool(['wss://relay.example'], ['wss://relay.example'])
    const enrol = vi.fn(async () => { pool.order.push('enrol'); return answer })
    const result = await enrolPhone(code, { pool, enrol })
    expect(pool.order).toEqual(['open wss://relay.example', 'open wss://two.example', 'enrol'])
    expect(enrol).toHaveBeenCalledOnce()
    expect(enrol).toHaveBeenCalledWith(P, 'Pixel 8 Pro')
    expect(pool.publish.mock.calls[0][0]).toEqual(['wss://relay.example'])
    expect(result).toEqual({ id: 9, checkCode: '9B6 164', accepted: ['wss://relay.example'] })
  })

  it('adds nothing when no relay answers', async () => {
    const pool = fakePool([], [])
    const enrol = vi.fn()
    await expect(enrolPhone(code, { pool, enrol })).rejects.toThrow(/nothing was added/)
    expect(enrol).not.toHaveBeenCalled()
  })

  it('names the record to revoke when the hand-off is refused everywhere', async () => {
    const pool = fakePool(['wss://relay.example'], [])
    const error = await enrolPhone(code, { pool, enrol: async () => answer }).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(HandOffUndelivered)
    expect((error as HandOffUndelivered).id).toBe(9)
  })
})

describe('inferUnlockMode', () => {
  it('reads an enrolled phone as phone unlock, a held vault key as Sapwood, else unknown', () => {
    expect(inferUnlockMode(2, false)).toBe('phone')
    expect(inferUnlockMode(0, true)).toBe('sapwood')
    expect(inferUnlockMode(null, true)).toBe('sapwood')
    expect(inferUnlockMode(0, false)).toBeNull()
    expect(inferUnlockMode(null, false)).toBeNull()
  })

  it('trusts what this session saw the signer accept over a held key', () => {
    expect(inferUnlockMode(2, true, false)).toBe('none')
    expect(inferUnlockMode(0, false, true)).toBe('sapwood')
    expect(inferUnlockMode(1, false, true)).toBe('phone')
  })
})
