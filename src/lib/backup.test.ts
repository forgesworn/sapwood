// Backup engine + encrypted envelope. The device round-trip runs against a fake
// transport; the crypto is exercised by round-trip and tamper tests. KDF params
// are kept light here so Argon2id stays fast; real backups use the heavier
// DEFAULT_KDF_PARAMS, which the envelope records and decrypt reads back.

import { describe, expect, it } from 'vitest'
import { FrameType, parseFrame } from './frame.js'
import type { ConnectSlot } from './types.js'
import {
  BackupError,
  decryptBackup,
  encryptBackup,
  exportBackup,
  importBackup,
  inventoryReportFor,
  matchBackup,
  msatToSats,
  parseBackupEnvelope,
  parseBackupPayload,
  type BackupPayload,
  type BackupTransport,
} from './backup.js'

const enc = new TextEncoder()
// Light but within the anti-DoS bounds parseBackupEnvelope enforces, so a
// serialised envelope re-parses. Real backups use the heavier DEFAULT_KDF_PARAMS.
const LIGHT = { m_cost: 1_024, t_cost: 1, p_cost: 1 }

function slot(index: number, label: string): ConnectSlot {
  return {
    slot_index: index,
    label,
    secret: 'ab'.repeat(32),
    current_pubkey: 'cc'.repeat(32),
    allowed_methods: ['sign_event'],
    allowed_kinds: [1, 7],
    auto_approve: true,
    signing_approved: true,
  }
}

const PAYLOAD: BackupPayload = {
  created_at: 0,
  device_id: 'dd'.repeat(32),
  bridge_secret: 'ee'.repeat(32),
  note_inventory: [{
    id: 'a1b2c3d4',
    commitment: '11'.repeat(32),
    state: 'confirmed',
    amount_msat: 21_000,
    host: 'mint.example/w',
    key_index: null,
    created_at: 100,
    updated_at: 100,
  }],
  masters: [
    { slot: 0, label: 'Personal', mode: 1, pubkey: 'aa'.repeat(32), connection_slots: [slot(0, 'Bark'), slot(1, 'nostrudel')] },
    { slot: 1, label: 'Work', mode: 2, pubkey: 'bb'.repeat(32), connection_slots: [slot(0, 'Amethyst')] },
  ],
}

/** A fake transport that replies with a scripted frame and records requests. */
function fakeTransport(reply: { type: number; payload: Uint8Array }): BackupTransport & { seen: ReturnType<typeof parseFrame>[] } {
  const seen: ReturnType<typeof parseFrame>[] = []
  return {
    seen,
    async sendAndReceive(frame) {
      seen.push(parseFrame(frame))
      return reply
    },
  }
}

describe('exportBackup', () => {
  it('sends BACKUP_EXPORT_REQUEST and parses the returned payload', async () => {
    const t = fakeTransport({ type: FrameType.BACKUP_EXPORT_RESPONSE, payload: enc.encode(JSON.stringify(PAYLOAD)) })
    const payload = await exportBackup(t)
    expect(t.seen[0]!.type).toBe(FrameType.BACKUP_EXPORT_REQUEST)
    expect(payload.masters).toHaveLength(2)
    expect(payload.masters[0]!.connection_slots).toHaveLength(2)
    expect(payload.bridge_secret).toBe('ee'.repeat(32))
    expect(payload.note_inventory).toHaveLength(1)
    expect(payload.note_inventory![0]!.commitment).toBe('11'.repeat(32))
  })

  it('throws when the signer NACKs (button not pressed)', async () => {
    const t = fakeTransport({ type: FrameType.NACK, payload: new Uint8Array(0) })
    await expect(exportBackup(t)).rejects.toBeInstanceOf(BackupError)
  })

  it('throws on malformed payload JSON', async () => {
    const t = fakeTransport({ type: FrameType.BACKUP_EXPORT_RESPONSE, payload: enc.encode('{ not json') })
    await expect(exportBackup(t)).rejects.toThrow(/not valid JSON/)
  })
})

describe('matchBackup', () => {
  it('keeps only masters the device still holds, case-insensitively', () => {
    const { matched, report } = matchBackup(PAYLOAD, [{ pubkeyHex: 'AA'.repeat(32), label: 'Personal' }])
    expect(matched.map((m) => m.label)).toEqual(['Personal'])
    expect(report).toEqual([
      { pubkey: 'aa'.repeat(32), label: 'Personal', slots: 2, matched: true },
      { pubkey: 'bb'.repeat(32), label: 'Work', slots: 1, matched: false },
    ])
  })
})

describe('importBackup', () => {
  it('sends only matched masters and reports the restored slot count', async () => {
    const t = fakeTransport({ type: FrameType.BACKUP_IMPORT_RESPONSE, payload: new Uint8Array([0x01]) })
    const result = await importBackup(t, PAYLOAD, [{ pubkeyHex: 'aa'.repeat(32), label: 'Personal' }])
    const sent = JSON.parse(new TextDecoder().decode(t.seen[0]!.payload)) as BackupPayload
    expect(t.seen[0]!.type).toBe(FrameType.BACKUP_IMPORT_REQUEST)
    expect(sent.masters.map((m) => m.label)).toEqual(['Personal']) // Work filtered out
    expect(result.restored).toBe(2)
    expect(result.masters.find((m) => m.label === 'Work')!.matched).toBe(false)
  })

  it('refuses to send when no master matches', async () => {
    const t = fakeTransport({ type: FrameType.BACKUP_IMPORT_RESPONSE, payload: new Uint8Array([0x01]) })
    await expect(importBackup(t, PAYLOAD, [{ pubkeyHex: '99'.repeat(32), label: 'Other' }]))
      .rejects.toThrow(/None of the backup/)
    expect(t.seen).toHaveLength(0)
  })

  it('throws when the device reports failure (0x00)', async () => {
    const t = fakeTransport({ type: FrameType.BACKUP_IMPORT_RESPONSE, payload: new Uint8Array([0x00]) })
    await expect(importBackup(t, PAYLOAD, [{ pubkeyHex: 'aa'.repeat(32), label: 'Personal' }]))
      .rejects.toThrow(/did not restore/)
  })
})

describe('encrypted envelope', () => {
  it('round-trips a payload through encrypt/decrypt', () => {
    const envelope = encryptBackup(PAYLOAD, 'correct horse battery staple', LIGHT)
    expect(envelope.version).toBe(1)
    expect(envelope.kdf).toBe('argon2id')
    expect(envelope.kdf_params).toEqual(LIGHT)
    const back = decryptBackup(envelope, 'correct horse battery staple')
    expect(back).toEqual(PAYLOAD)
  })

  it('never puts the secret in the envelope in the clear', () => {
    const envelope = encryptBackup(PAYLOAD, 'pw', LIGHT)
    expect(JSON.stringify(envelope)).not.toContain('ee'.repeat(32))
    expect(JSON.stringify(envelope)).not.toContain('ab'.repeat(32))
  })

  it('fails to decrypt with the wrong passphrase', () => {
    const envelope = encryptBackup(PAYLOAD, 'right', LIGHT)
    expect(() => decryptBackup(envelope, 'wrong')).toThrow(/Wrong passphrase/)
  })

  it('detects tampering (Poly1305 tag)', () => {
    const envelope = encryptBackup(PAYLOAD, 'pw', LIGHT)
    const bytes = atob(envelope.ciphertext).split('')
    bytes[0] = String.fromCharCode(bytes[0]!.charCodeAt(0) ^ 0xff)
    const tampered = { ...envelope, ciphertext: btoa(bytes.join('')) }
    expect(() => decryptBackup(tampered, 'pw')).toThrow(BackupError)
  })

  it('parses a serialised envelope and rejects junk', () => {
    const envelope = encryptBackup(PAYLOAD, 'pw', LIGHT)
    const parsed = parseBackupEnvelope(JSON.stringify(envelope))
    expect(decryptBackup(parsed, 'pw')).toEqual(PAYLOAD)
    expect(() => parseBackupEnvelope('not json')).toThrow(BackupError)
    expect(() => parseBackupEnvelope(JSON.stringify({ ...envelope, version: 2 }))).toThrow(/version/)
  })

  it('rejects an out-of-range KDF cost (anti-DoS)', () => {
    const envelope = encryptBackup(PAYLOAD, 'pw', LIGHT)
    const evil = JSON.stringify({ ...envelope, kdf_params: { m_cost: 9_999_999, t_cost: 3, p_cost: 1 } })
    expect(() => parseBackupEnvelope(evil)).toThrow(/m_cost/)
  })
})

describe('parseBackupPayload', () => {
  it('rejects a payload missing required fields', () => {
    expect(() => parseBackupPayload(enc.encode(JSON.stringify({ masters: [] })))).toThrow(/expected fields/)
  })

  it('preserves the identity-scope fields (ids, wb) of a slot untouched', () => {
    const scoped: ConnectSlot = { ...slot(2, 'identity-scoped app'), ids: 'aaaaaaaaaaaaaaaabbbbbbbbbbbbbbbb', wb: true }
    const withScope: BackupPayload = {
      ...PAYLOAD,
      masters: [{ ...PAYLOAD.masters[0]!, connection_slots: [scoped] }],
    }

    const parsed = parseBackupPayload(enc.encode(JSON.stringify(withScope)))
    expect(parsed.masters[0]!.connection_slots[0]!.ids).toBe('aaaaaaaaaaaaaaaabbbbbbbbbbbbbbbb')
    expect(parsed.masters[0]!.connection_slots[0]!.wb).toBe(true)

    const envelope = encryptBackup(parsed, 'pw', LIGHT)
    const back = decryptBackup(envelope, 'pw')
    expect(back).toEqual(withScope)
  })

  it('accepts unknown future top-level fields without rejecting the payload', () => {
    const withExtra = { ...PAYLOAD, some_future_field: { anything: true } }
    const parsed = parseBackupPayload(enc.encode(JSON.stringify(withExtra)))
    expect(parsed.masters).toHaveLength(2)
    expect(parsed.bridge_secret).toBe('ee'.repeat(32))
  })
})

describe('note inventory leniency', () => {
  it('parses old backups with no inventory exactly as before', () => {
    const { note_inventory: _inventory, ...historical } = PAYLOAD
    const parsed = parseBackupPayload(enc.encode(JSON.stringify(historical)))
    expect(parsed).toEqual(historical)
    expect(parsed.note_inventory).toBeUndefined()
    expect(inventoryReportFor(parsed)).toEqual({ entries: 0, dropped: 0, unreadable: 0, ignored: false })
  })

  it('round-trips a valid inventory', () => {
    const parsed = parseBackupPayload(enc.encode(JSON.stringify(PAYLOAD)))
    expect(parsed.note_inventory).toEqual(PAYLOAD.note_inventory)
    expect(inventoryReportFor(parsed)).toEqual({ entries: 1, dropped: 0, unreadable: 0, ignored: false })
  })

  it('drops one malformed entry and still restores the rest of the payload', () => {
    const withBadEntry = {
      ...PAYLOAD,
      note_inventory: [
        PAYLOAD.note_inventory![0]!,
        { ...PAYLOAD.note_inventory![0]!, id: 'not-hex-id' },
      ],
    }
    const parsed = parseBackupPayload(enc.encode(JSON.stringify(withBadEntry)))
    expect(parsed.note_inventory).toEqual([PAYLOAD.note_inventory![0]])
    expect(parsed.masters).toHaveLength(2)
    expect(inventoryReportFor(parsed)).toEqual({ entries: 1, dropped: 1, unreadable: 0, ignored: false })
  })

  it('ignores a wrong-typed note_inventory and still restores the payload', () => {
    const withWrongType = { ...PAYLOAD, note_inventory: 'not-an-array' }
    const parsed = parseBackupPayload(enc.encode(JSON.stringify(withWrongType)))
    expect(parsed.note_inventory).toBeUndefined()
    expect(parsed.masters).toHaveLength(2)
    expect(inventoryReportFor(parsed)).toEqual({ entries: 0, dropped: 0, unreadable: 0, ignored: true })
  })

  it('ignores an oversized note_inventory (17+ entries) and still restores the payload', () => {
    const oversized = Array.from({ length: 17 }, (_, i) => ({
      ...PAYLOAD.note_inventory![0]!,
      id: i.toString(16).padStart(8, '0'),
    }))
    const withOversize = { ...PAYLOAD, note_inventory: oversized }
    const parsed = parseBackupPayload(enc.encode(JSON.stringify(withOversize)))
    expect(parsed.note_inventory).toBeUndefined()
    expect(parsed.masters).toHaveLength(2)
    expect(inventoryReportFor(parsed)).toEqual({ entries: 0, dropped: 0, unreadable: 0, ignored: true })
  })

  it('ignores garbage entries (nulls, non-objects) and still restores the payload', () => {
    const garbage = { ...PAYLOAD, note_inventory: [null, 42, 'nope', { random: 'shape' }] }
    const parsed = parseBackupPayload(enc.encode(JSON.stringify(garbage)))
    expect(parsed.note_inventory).toEqual([])
    expect(parsed.masters).toHaveLength(2)
    expect(inventoryReportFor(parsed)).toEqual({ entries: 0, dropped: 4, unreadable: 0, ignored: false })
  })

  it('drops entries using the old secret_hash name rather than accepting them', () => {
    const oldName = {
      ...PAYLOAD,
      note_inventory: [{
        id: 'a1b2c3d4',
        secret_hash: '11'.repeat(32),
        state: 'confirmed',
        amount_msat: 21_000,
        host: 'mint.example/w',
        key_index: null,
        created_at: 100,
        updated_at: 100,
      }],
    }
    const parsed = parseBackupPayload(enc.encode(JSON.stringify(oldName)))
    expect(parsed.note_inventory).toEqual([])
    expect(inventoryReportFor(parsed)).toEqual({ entries: 0, dropped: 1, unreadable: 0, ignored: false })
  })

  it('reports unreadable > 0 with an empty array as incomplete, not as empty', () => {
    const incomplete = { ...PAYLOAD, note_inventory: [], note_inventory_unreadable: 3 }
    const parsed = parseBackupPayload(enc.encode(JSON.stringify(incomplete)))
    expect(parsed.note_inventory).toEqual([])
    expect(parsed.note_inventory_unreadable).toBe(3)
    const report = inventoryReportFor(parsed)
    expect(report.unreadable).toBe(3)
    expect(report.entries).toBe(0)
  })

  it('omits note_inventory_unreadable when zero or absent', () => {
    const parsed = parseBackupPayload(enc.encode(JSON.stringify(PAYLOAD)))
    expect(parsed.note_inventory_unreadable).toBeUndefined()
  })
})

describe('msatToSats', () => {
  it('converts with integer maths, flooring a partial sat', () => {
    expect(msatToSats(21_000)).toBe(21)
    expect(msatToSats(21_999)).toBe(21)
    expect(msatToSats(0)).toBe(0)
  })
})

describe('import strips the note inventory', () => {
  it('sends a payload without note_inventory or note_inventory_unreadable, leaving masters and slots untouched', async () => {
    const t = fakeTransport({ type: FrameType.BACKUP_IMPORT_RESPONSE, payload: new Uint8Array([0x01]) })
    const withInventory: BackupPayload = { ...PAYLOAD, note_inventory_unreadable: 2 }
    await importBackup(t, withInventory, [
      { pubkeyHex: 'aa'.repeat(32), label: 'Personal' },
      { pubkeyHex: 'bb'.repeat(32), label: 'Work' },
    ])
    const sent = JSON.parse(new TextDecoder().decode(t.seen[0]!.payload)) as BackupPayload
    expect(sent.note_inventory).toBeUndefined()
    expect(sent.note_inventory_unreadable).toBeUndefined()
    expect(sent.masters).toEqual(PAYLOAD.masters)
    expect(sent.bridge_secret).toBe(PAYLOAD.bridge_secret)
    expect(sent.device_id).toBe(PAYLOAD.device_id)
  })
})
