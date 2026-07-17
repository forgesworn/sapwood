// Command logic against a scripted fake transport — no hardware, no serialport.

import { describe, expect, it } from 'vitest'
import { FrameType, parseFrame } from '../src/lib/frame.js'
import type { Frame, FrameTypeValue } from '../src/lib/frame.js'
import type { ConnectSlot, MasterInfo } from '../src/lib/types.js'
import {
  CommandError,
  cmdApps,
  cmdAppsRevoke,
  cmdDerive,
  cmdDevice,
  cmdIdentities,
} from './commands.js'
import type { CommandTransport } from './commands.js'

const enc = new TextEncoder()
const O = { timeoutMs: 1_000 }

function jsonFrame(type: FrameTypeValue, value: unknown): Frame {
  return { type, payload: enc.encode(JSON.stringify(value)) }
}

function nack(reason = ''): Frame {
  return { type: FrameType.NACK, payload: enc.encode(reason) }
}

/** Replies per request frame type; records every request it saw. */
function fakeTransport(replies: Partial<Record<number, Frame | Frame[]>>): CommandTransport & { seen: Frame[] } {
  const seen: Frame[] = []
  return {
    seen,
    async sendAndReceive(frameBytes) {
      const frame = parseFrame(frameBytes)
      seen.push(frame)
      const scripted = replies[frame.type]
      if (scripted === undefined) throw new Error(`unscripted frame 0x${frame.type.toString(16)}`)
      if (Array.isArray(scripted)) {
        const next = scripted.shift()
        if (!next) throw new Error(`script for 0x${frame.type.toString(16)} ran dry`)
        return next
      }
      return scripted
    },
  }
}

const MASTERS: MasterInfo[] = [
  { slot: 0, label: 'forge', npub: 'npub1forgeforgeforgeforgex7d0', apps: 3 },
  { slot: 1, label: 'market', npub: 'npub1marketmarketmarketmp2q4', apps: 2 },
  { slot: 0, label: 'blog', npub: 'npub1blogblogblogblogblogdef0', persona: true },
]

describe('cmdDevice', () => {
  it('reports firmware, identities and app totals', async () => {
    const t = fakeTransport({
      [FrameType.FIRMWARE_INFO]: jsonFrame(FrameType.FIRMWARE_INFO_RESPONSE, {
        version: '0.13.7', board: 'heltec-v4', uptime_s: 8_040, last_reset: 'software restart',
      }),
      [FrameType.PROVISION_LIST]: jsonFrame(FrameType.PROVISION_LIST_RESPONSE, MASTERS),
    })
    const r = await cmdDevice(t, O)
    expect(r.lines[0]).toBe('✓ HEARTWOOD v0.13.7 · heltec-v4')
    expect(r.lines[1]).toBe('  uptime 2h 14m · last reset software restart')
    expect(r.lines[2]).toBe('  identities 2 (+1 persona) · connected apps 5')
    expect(r.data).toMatchObject({ identities: 2, personas: 1, apps: 5 })
  })

  it('degrades when the firmware predates the version query', async () => {
    const t = fakeTransport({
      [FrameType.FIRMWARE_INFO]: nack(),
      [FrameType.PROVISION_LIST]: jsonFrame(FrameType.PROVISION_LIST_RESPONSE, MASTERS),
    })
    const r = await cmdDevice(t, O)
    expect(r.lines[0]).toContain('predates the version query')
  })

  it('counts apps via the slot list when the masters carry no counts', async () => {
    const bare = MASTERS.map(({ apps: _apps, ...m }) => m)
    const slots: ConnectSlot[] = [
      { slot_index: 0, label: 'gossip', secret: '', current_pubkey: 'ab', allowed_methods: ['sign_event'], allowed_kinds: [1], auto_approve: true, signing_approved: true },
    ]
    const t = fakeTransport({
      [FrameType.FIRMWARE_INFO]: nack(),
      [FrameType.PROVISION_LIST]: jsonFrame(FrameType.PROVISION_LIST_RESPONSE, bare),
      [FrameType.CONNSLOT_LIST]: jsonFrame(FrameType.CONNSLOT_LIST_RESP, slots),
    })
    const r = await cmdDevice(t, O)
    expect(r.lines.at(-1)).toContain('connected apps 2')
  })
})

describe('cmdIdentities', () => {
  it('tables masters and names the persona owner', async () => {
    const t = fakeTransport({
      [FrameType.PROVISION_LIST]: jsonFrame(FrameType.PROVISION_LIST_RESPONSE, MASTERS),
    })
    const r = await cmdIdentities(t, O)
    expect(r.lines[0]).toMatch(/^SLOT {2}NAME/)
    expect(r.lines[1]).toContain('forge')
    expect(r.lines[1]).toContain('npub1forg…x7d0')
    expect(r.lines[3]).toContain('persona of forge')
    expect(r.data).toEqual(MASTERS)
  })

  it('states plainly when no identities exist', async () => {
    const t = fakeTransport({
      [FrameType.PROVISION_LIST]: jsonFrame(FrameType.PROVISION_LIST_RESPONSE, []),
    })
    const r = await cmdIdentities(t, O)
    expect(r.lines[0]).toContain('no identities')
  })
})

describe('cmdDerive', () => {
  it('derives under the named parent and reports the npub', async () => {
    const t = fakeTransport({
      [FrameType.PROVISION_LIST]: jsonFrame(FrameType.PROVISION_LIST_RESPONSE, MASTERS),
      [FrameType.DERIVE_IDENTITY]: jsonFrame(FrameType.DERIVE_IDENTITY_RESPONSE, {
        slot: 0, label: 'writer', npub: 'npub1writerwriterwriterwq9k2', existing: false,
      }),
    })
    const r = await cmdDerive(t, 'writer', 0, O)
    expect(r.lines[0]).toBe("✓ derived 'writer' under 'forge'")
    expect(r.lines[1]).toContain('npub1writer')
  })

  it('says so when the identity already existed', async () => {
    const t = fakeTransport({
      [FrameType.PROVISION_LIST]: jsonFrame(FrameType.PROVISION_LIST_RESPONSE, MASTERS),
      [FrameType.DERIVE_IDENTITY]: jsonFrame(FrameType.DERIVE_IDENTITY_RESPONSE, {
        slot: 1, label: 'writer', npub: 'npub1writerwriterwriterwq9k2', existing: true,
      }),
    })
    const r = await cmdDerive(t, 'writer', 1, O)
    expect(r.lines[0]).toBe("✓ 'writer' already exists under 'market'")
  })

  it('requires --parent when several masters exist', async () => {
    const t = fakeTransport({
      [FrameType.PROVISION_LIST]: jsonFrame(FrameType.PROVISION_LIST_RESPONSE, MASTERS),
    })
    await expect(cmdDerive(t, 'writer', undefined, O)).rejects.toThrow(/--parent <slot>/)
  })

  it('surfaces the firmware NACK reason', async () => {
    const t = fakeTransport({
      [FrameType.PROVISION_LIST]: jsonFrame(FrameType.PROVISION_LIST_RESPONSE, [MASTERS[0]!]),
      [FrameType.DERIVE_IDENTITY]: nack('slots full'),
    })
    await expect(cmdDerive(t, 'writer', undefined, O)).rejects.toThrow('slots full')
  })
})

describe('cmdApps', () => {
  const gossip: ConnectSlot = {
    slot_index: 0, label: 'gossip', secret: '', current_pubkey: 'abcd',
    allowed_methods: ['sign_event', 'get_public_key'], allowed_kinds: [1, 7],
    auto_approve: true, signing_approved: true,
  }

  it('lists apps across every identity', async () => {
    const t = fakeTransport({
      [FrameType.PROVISION_LIST]: jsonFrame(FrameType.PROVISION_LIST_RESPONSE, MASTERS),
      [FrameType.CONNSLOT_LIST]: [
        jsonFrame(FrameType.CONNSLOT_LIST_RESP, [gossip]),
        jsonFrame(FrameType.CONNSLOT_LIST_RESP, []),
      ],
    })
    const r = await cmdApps(t, undefined, O)
    expect(r.lines[0]).toMatch(/^IDENTITY/)
    expect(r.lines[1]).toContain('gossip')
    expect(r.lines[1]).toContain('1,7')
    expect(t.seen.filter((f) => f.type === FrameType.CONNSLOT_LIST)).toHaveLength(2)
  })

  it('reports an empty console honestly', async () => {
    const t = fakeTransport({
      [FrameType.PROVISION_LIST]: jsonFrame(FrameType.PROVISION_LIST_RESPONSE, [MASTERS[0]!]),
      [FrameType.CONNSLOT_LIST]: jsonFrame(FrameType.CONNSLOT_LIST_RESP, []),
    })
    const r = await cmdApps(t, undefined, O)
    expect(r.lines).toEqual(['No connected apps.'])
  })

  it('rejects an unknown identity slot', async () => {
    const t = fakeTransport({
      [FrameType.PROVISION_LIST]: jsonFrame(FrameType.PROVISION_LIST_RESPONSE, MASTERS),
    })
    await expect(cmdApps(t, 9, O)).rejects.toThrow(CommandError)
  })
})

describe('cmdAppsRevoke', () => {
  it('revokes and names the identity', async () => {
    const t = fakeTransport({
      [FrameType.PROVISION_LIST]: jsonFrame(FrameType.PROVISION_LIST_RESPONSE, [MASTERS[1]!]),
      [FrameType.CONNSLOT_REVOKE]: { type: FrameType.CONNSLOT_REVOKE_RESP, payload: new Uint8Array(0) },
    })
    const r = await cmdAppsRevoke(t, 2, undefined, O)
    expect(r.lines[0]).toBe("✓ revoked app slot 2 on 'market'")
    const revoke = t.seen.find((f) => f.type === FrameType.CONNSLOT_REVOKE)!
    expect(revoke.payload[0]).toBe(1) // master slot in byte 0
  })

  it('surfaces a refusal', async () => {
    const t = fakeTransport({
      [FrameType.PROVISION_LIST]: jsonFrame(FrameType.PROVISION_LIST_RESPONSE, [MASTERS[0]!]),
      [FrameType.CONNSLOT_REVOKE]: nack('no such slot'),
    })
    await expect(cmdAppsRevoke(t, 7, undefined, O)).rejects.toThrow('no such slot')
  })
})
