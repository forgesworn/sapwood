import { describe, it, expect, vi } from 'vitest'

vi.mock('@noble/curves/ed25519.js', () => ({
  ed25519: {
    verify: vi.fn((signature: Uint8Array) => signature.some((b) => b !== 0)),
  },
}))

import { ed25519 } from '@noble/curves/ed25519.js'
import {
  flashDevice,
  flashAppOnly,
  flashTetheredImage,
  parsePartitionTable,
  planAppOnlyWrite,
  PARTITION_TABLE_OFFSET,
  PARTITION_TABLE_SIZE,
  defaultBackend,
  BOARDS,
  TETHERED_BOARDS,
  type FlasherBackend,
  type FlashSession,
  type FlashRegion,
  type ReportProgress,
} from './flasher'
import { buildConfigBlob } from './flash-config'
import type { NetConfig } from './frame'

const CFG: NetConfig = {
  ssid: 'VM0030073',
  password: 'hunter2',
  relays: ['wss://relay.trotters.cc'],
  mode: 'wifi',
}

const BOARD = BOARDS[0] // heltec-v4, config @ 0x410000
const DUMMY_APP = new Uint8Array([0xde, 0xad, 0xbe, 0xef])
const DUMMY_APP_SHA = '5f78c33274e43fa9de5659265c1d917e25c03722dcb0b8d27db8d5feaa813953'
const ZERO_180K_SHA = 'ec5a689d3fdf19351fc26dadaae55e6968fe42c9d18d760dd35f74981bd20115'
const ONE_BYTE_SHA = '4bf5122f344554c53bde2ebb8cd2b7e3d1600ad631c385a5d7cce23c7785459a'
const SIGNED_MANIFEST = {
  version: 'test',
  boards: Object.fromEntries(
    [...BOARDS, ...TETHERED_BOARDS].map((b) => [
      b.id,
      { app: 'app.bin', sha256: DUMMY_APP_SHA, signature: '11'.repeat(64) },
    ]),
  ),
}

function manifestForSha(boardId: string, sha256: string) {
  return {
    version: 'test',
    boards: { [boardId]: { app: 'app.bin', sha256, signature: '11'.repeat(64) } },
  }
}

type Row = [label: string, type: number, subtype: number, offset: number, size: number]

/** Encode an ESP-IDF binary partition table (erased flash after the rows). */
function table(rows: Row[]): Uint8Array {
  const out = new Uint8Array(PARTITION_TABLE_SIZE).fill(0xff)
  const view = new DataView(out.buffer)
  rows.forEach(([label, type, subtype, offset, size], i) => {
    const o = i * 32
    out.set([0xaa, 0x50, type, subtype], o)
    view.setUint32(o + 4, offset, true)
    view.setUint32(o + 8, size, true)
    out.fill(0, o + 12, o + 32)
    out.set(new TextEncoder().encode(label), o + 12)
  })
  return out
}

// Mirrors heartwood-esp32/firmware/partitions-4mb.csv (T-Display, C6).
const FACTORY_4MB = table([
  ['nvs', 1, 0x02, 0x9000, 0x6000],
  ['phy_init', 1, 0x01, 0xf000, 0x1000],
  ['factory', 0, 0x00, 0x10000, 0x300000],
  ['config', 1, 0x40, 0x310000, 0x4000],
])
// Mirrors firmware/partitions.csv — the fleet V3/V4 A/B layout.
const V4_TWO_SLOT = table([
  ['nvs', 1, 0x02, 0x9000, 0x4000],
  ['otadata', 1, 0x00, 0xd000, 0x2000],
  ['phy_init', 1, 0x01, 0xf000, 0x1000],
  ['ota_0', 0, 0x10, 0x10000, 0x200000],
  ['ota_1', 0, 0x11, 0x210000, 0x200000],
  ['config', 1, 0x40, 0x410000, 0x4000],
])
// The real table read off the one-off legacy V4 (2026-09-13): 5 rows, then the
// ESP-IDF MD5 row (0xEB 0xEB) and erased flash. Not synthesised — this is what
// gen_esp32part produced, flags field and all.
const V4_LEGACY_BIGAPP_REAL = (() => {
  const hex =
    'aa50010200900000006000006e76730000000000000000000000000000000000' +
    'aa50010100f00000001000007068795f696e6974000000000000000000000000' +
    'aa50001000000100000040006f74615f30000000000000000000000000000000' +
    'aa5001400000410000400000636f6e6669670000000000000000000000000000' +
    'aa50010000404100002000006f74616461746100000000000000000000000000' +
    'ebebffffffffffffffffffffffffffff747e37eb8fb17ce12b1a9c719a817d23'
  const out = new Uint8Array(PARTITION_TABLE_SIZE).fill(0xff)
  out.set(Uint8Array.from(hex.match(/../g)!.map((h) => parseInt(h, 16))))
  return out
})()

interface Harness {
  backend: FlasherBackend
  session: FlashSession
  /** URLs passed to fetchBin, in order. */
  fetched: string[]
  /** regions handed to writeFlash. */
  wrote: () => FlashRegion[] | null
  /** drive esptool's progress callback from inside the fake writeFlash. */
  onWrite: (report: ReportProgress) => void | Promise<void>
  calls: Record<string, number>
}

function makeHarness(opts: {
  hasWebSerial?: boolean
  detectChip?: () => Promise<string>
  writeFlash?: FlashSession['writeFlash']
  /** What reading the partition table returns. Defaults to the 4 MB factory layout. */
  partitionTable?: Uint8Array
  hardReset?: () => Promise<void>
  close?: () => Promise<void>
  onWrite?: (report: ReportProgress) => void | Promise<void>
} = {}): Harness {
  const fetched: string[] = []
  let wrote: FlashRegion[] | null = null
  const calls: Record<string, number> = {
    requestPort: 0, openSession: 0, detectChip: 0, eraseFlash: 0, writeFlash: 0, readFlash: 0, hardReset: 0, close: 0,
  }
  const onWrite = opts.onWrite ?? (() => {})

  const session: FlashSession = {
    detectChip: vi.fn(opts.detectChip ?? (async () => 'ESP32-S3 (QFN56) (revision v0.2)')).mockImplementation(
      opts.detectChip ?? (async () => { calls.detectChip++; return 'ESP32-S3 (QFN56) (revision v0.2)' }),
    ),
    eraseFlash: vi.fn(async () => { calls.eraseFlash++ }),
    writeFlash: opts.writeFlash
      ? vi.fn(opts.writeFlash)
      : vi.fn(async (regions: FlashRegion[], report: ReportProgress) => {
          calls.writeFlash++
          wrote = regions
          await onWrite(report)
        }),
    readFlash: vi.fn(async (address: number, size: number) => {
      calls.readFlash++
      expect([address, size]).toEqual([PARTITION_TABLE_OFFSET, PARTITION_TABLE_SIZE])
      return opts.partitionTable ?? FACTORY_4MB
    }),
    hardReset: vi.fn(opts.hardReset ?? (async () => { calls.hardReset++ })),
    close: vi.fn(opts.close ?? (async () => { calls.close++ })),
  }

  const backend: FlasherBackend = {
    hasWebSerial: () => opts.hasWebSerial ?? true,
    requestPort: vi.fn(async () => { calls.requestPort++; return { fake: 'port' } }),
    fetchBin: vi.fn(async (url: string) => {
      fetched.push(url)
      if (url.endsWith('/app.bin')) return DUMMY_APP
      return new Uint8Array([0xde, 0xad, 0xbe, 0xef])
    }),
    fetchManifest: vi.fn(async () => SIGNED_MANIFEST),
    openSession: vi.fn(async () => { calls.openSession++; return session }),
  }

  return { backend, session, fetched, wrote: () => wrote, onWrite, calls }
}

describe('flashDevice — guards', () => {
  it('throws when Web Serial is unavailable and never touches the device', async () => {
    const h = makeHarness({ hasWebSerial: false })
    await expect(flashDevice(BOARD, CFG, {}, h.backend)).rejects.toThrow(/Web Serial unavailable/)
    expect(h.backend.requestPort).not.toHaveBeenCalled()
    expect(h.backend.openSession).not.toHaveBeenCalled()
    expect(h.backend.fetchBin).not.toHaveBeenCalled()
  })
})

describe('flashDevice — region layout', () => {
  it('fetches bootloader, partition table and app from the board asset path', async () => {
    const h = makeHarness()
    await flashDevice(BOARD, CFG, {}, h.backend)
    expect(h.fetched).toEqual([
      `${BOARD.assets}/bootloader.bin`,
      `${BOARD.assets}/partition-table.bin`,
      `${BOARD.assets}/app.bin`,
    ])
  })

  it('preserves the config partition by default during a firmware re-flash', async () => {
    const h = makeHarness()
    await flashDevice(BOARD, CFG, {}, h.backend)
    const regions = h.wrote()!
    expect(regions).toHaveLength(3)
    expect(regions.map((r) => r.address)).toEqual([0x0, 0x8000, 0x10000])
    expect(regions.some((r) => r.address === BOARD.configOffset)).toBe(false)
  })

  it('writes config only when setup/reconfigure explicitly opts in', async () => {
    const h = makeHarness()
    await flashDevice(BOARD, CFG, { writeConfig: true }, h.backend)
    const regions = h.wrote()!
    expect(regions).toHaveLength(4)
    expect([...regions[3].data]).toEqual([...buildConfigBlob(CFG)])
    expect(regions[3].address).toBe(BOARD.configOffset)
  })

  it('puts the classic-ESP32 (T-Display) bootloader at 0x1000, not 0x0', async () => {
    const tdisplay = BOARDS.find((b) => b.id === 'tdisplay')!
    const h = makeHarness()
    await flashDevice(tdisplay, CFG, { writeConfig: true }, h.backend)
    const regions = h.wrote()!
    // classic ESP32 loads the bootloader from 0x1000; config sits in the 4 MB layout.
    expect(regions.map((r) => r.address)).toEqual([0x1000, 0x8000, 0x10000, tdisplay.configOffset])
    expect(tdisplay.configOffset).toBe(0x310000)
  })
})

describe('flashDevice — full erase', () => {
  it('erases the whole flash and emits an erasing stage when fullErase is set', async () => {
    const h = makeHarness()
    const progress: Array<[number, string]> = []
    await flashDevice(BOARD, CFG, { fullErase: true, writeConfig: true, onProgress: (p, s) => progress.push([p, s]) }, h.backend)
    expect(h.session.eraseFlash).toHaveBeenCalledTimes(1)
    expect(progress).toContainEqual([0, 'erasing flash'])
  })

  it('refuses a full erase without replacement config before touching the device', async () => {
    const h = makeHarness()
    await expect(flashDevice(BOARD, CFG, { fullErase: true }, h.backend)).rejects.toThrow(/full erase destroys device configuration/i)
    expect(h.backend.requestPort).not.toHaveBeenCalled()
    expect(h.session.eraseFlash).not.toHaveBeenCalled()
  })

  it('does not erase when fullErase is false', async () => {
    const h = makeHarness()
    await flashDevice(BOARD, CFG, { fullErase: false }, h.backend)
    expect(h.session.eraseFlash).not.toHaveBeenCalled()
  })

  it('erases before writing (clean slate, then flash)', async () => {
    const order: string[] = []
    const h = makeHarness({ writeFlash: async () => { order.push('write') } })
    ;(h.session.eraseFlash as ReturnType<typeof vi.fn>).mockImplementation(async () => { order.push('erase') })
    await flashDevice(BOARD, CFG, { fullErase: true, writeConfig: true }, h.backend)
    expect(order).toEqual(['erase', 'write'])
  })
})

describe('flashDevice — progress mapping (byte-weighted)', () => {
  // Give the regions realistic relative sizes so the test pins byte-weighting,
  // not region-count weighting: app.bin must dwarf bootloader + partition table.
  function sizedFetch(h: Harness) {
    ;(h.backend.fetchBin as ReturnType<typeof vi.fn>).mockImplementation(async (url: string) => {
      const n = url.endsWith('app.bin') ? 180_000
        : url.endsWith('bootloader.bin') ? 2_000
        : 300 // partition-table.bin
      return new Uint8Array(n)
    })
    ;(h.backend.fetchManifest as ReturnType<typeof vi.fn>).mockResolvedValue(manifestForSha(BOARD.id, ZERO_180K_SHA))
  }

  it('keeps the bar low after the tiny bootloader + partition table finish', async () => {
    const progress: Array<[number, string]> = []
    const h = makeHarness({
      onWrite: (report) => {
        report(0, 2_000, 2_000) // bootloader done
        report(1, 300, 300)     // partition table done
      },
    })
    sizedFetch(h)
    await flashDevice(BOARD, CFG, { onProgress: (p, s) => progress.push([p, s]) }, h.backend)
    // ~2.3KB of ~182KB ≈ 1-2% — nowhere near the old 50% jump.
    const afterTable = progress.find(([, s]) => s === 'partition table')![0]
    expect(afterTable).toBeLessThan(5)
  })

  it('makes app.bin dominate: halfway through it is roughly halfway overall', async () => {
    const progress: Array<[number, string]> = []
    const h = makeHarness({ onWrite: (report) => report(2, 90_000, 180_000) }) // app half
    sizedFetch(h)
    await flashDevice(BOARD, CFG, { onProgress: (p, s) => progress.push([p, s]) }, h.backend)
    const atAppHalf = progress.find(([, s]) => s === 'firmware')![0]
    expect(atAppHalf).toBeGreaterThanOrEqual(48)
    expect(atAppHalf).toBeLessThanOrEqual(52)
  })

  it('guards against a zero total (avoids NaN)', async () => {
    const progress: Array<[number, string]> = []
    const h = makeHarness({ onWrite: (report) => report(2, 0, 0) })
    sizedFetch(h)
    await flashDevice(BOARD, CFG, { onProgress: (p, s) => progress.push([p, s]) }, h.backend)
    expect(progress.every(([p]) => Number.isFinite(p))).toBe(true)
  })

  it('emits a final 100% done after writing', async () => {
    const progress: Array<[number, string]> = []
    const h = makeHarness()
    await flashDevice(BOARD, CFG, { onProgress: (p, s) => progress.push([p, s]) }, h.backend)
    expect(progress.at(-1)).toEqual([100, 'done'])
  })
})

describe('flashDevice — reset is best-effort', () => {
  it('completes and reports done even if hard reset fails (S3 native USB)', async () => {
    const logs: string[] = []
    const progress: Array<[number, string]> = []
    const h = makeHarness({ hardReset: async () => { throw new Error('no DTR/RTS') } })
    await expect(
      flashDevice(BOARD, CFG, { onLog: (l) => logs.push(l), onProgress: (p, s) => progress.push([p, s]) }, h.backend),
    ).resolves.toBeUndefined()
    expect(logs.some((l) => /Auto-reset failed/.test(l))).toBe(true)
    expect(logs.some((l) => /no DTR\/RTS/.test(l))).toBe(true)
    expect(progress.at(-1)).toEqual([100, 'done'])
    expect(h.session.close).toHaveBeenCalledTimes(1)
  })
})

describe('flashDevice — ordering and chip detection', () => {
  it('requests the port, opens the session, then detects the chip before writing', async () => {
    const order: string[] = []
    const h = makeHarness({ writeFlash: async () => { order.push('write') } })
    ;(h.backend.requestPort as ReturnType<typeof vi.fn>).mockImplementation(async () => { order.push('port'); return {} })
    ;(h.backend.openSession as ReturnType<typeof vi.fn>).mockImplementation(async () => { order.push('open'); return h.session })
    ;(h.session.detectChip as ReturnType<typeof vi.fn>).mockImplementation(async () => { order.push('detect'); return 'ESP32-S3' })
    await flashDevice(BOARD, CFG, {}, h.backend)
    expect(order).toEqual(['port', 'open', 'detect', 'write'])
  })

  it('requests the serial port before fetching firmware (preserves the user gesture)', async () => {
    const order: string[] = []
    const h = makeHarness()
    ;(h.backend.requestPort as ReturnType<typeof vi.fn>).mockImplementation(async () => { order.push('port'); return {} })
    ;(h.backend.fetchBin as ReturnType<typeof vi.fn>).mockImplementation(async () => { order.push('fetch'); return new Uint8Array([1]) })
    ;(h.backend.fetchManifest as ReturnType<typeof vi.fn>).mockResolvedValue(manifestForSha(BOARD.id, ONE_BYTE_SHA))
    await flashDevice(BOARD, CFG, {}, h.backend)
    expect(order[0]).toBe('port')
    expect(order.indexOf('port')).toBeLessThan(order.indexOf('fetch'))
  })

  it('logs the detected chip description', async () => {
    const logs: string[] = []
    const h = makeHarness({ detectChip: async () => 'ESP32-S3 (QFN56)' })
    await flashDevice(BOARD, CFG, { onLog: (l) => logs.push(l) }, h.backend)
    expect(logs.some((l) => l.includes('Connected: ESP32-S3 (QFN56)'))).toBe(true)
  })
})

describe('flashDevice — cleanup', () => {
  it('closes the session on success', async () => {
    const h = makeHarness()
    await flashDevice(BOARD, CFG, {}, h.backend)
    expect(h.session.close).toHaveBeenCalledTimes(1)
  })

  it('closes the session and propagates the error when writeFlash fails', async () => {
    const h = makeHarness({ writeFlash: async () => { throw new Error('flash write timed out') } })
    await expect(flashDevice(BOARD, CFG, {}, h.backend)).rejects.toThrow(/flash write timed out/)
    expect(h.session.close).toHaveBeenCalledTimes(1)
  })

  it('does not mask a successful flash if close() throws', async () => {
    const h = makeHarness({ close: async () => { throw new Error('port already gone') } })
    await expect(flashDevice(BOARD, CFG, {}, h.backend)).resolves.toBeUndefined()
  })
})

describe('flashDevice — firmware integrity (guards a stale/cached app.bin)', () => {
  async function sha256hex(bytes: Uint8Array): Promise<string> {
    const buf = new ArrayBuffer(bytes.byteLength)
    new Uint8Array(buf).set(bytes)
    const d = await crypto.subtle.digest('SHA-256', buf)
    return Array.from(new Uint8Array(d), (b) => b.toString(16).padStart(2, '0')).join('')
  }

  it('rejects — before opening the device — when the app SHA does not match the manifest', async () => {
    const h = makeHarness()
    ;(h.backend.fetchManifest as ReturnType<typeof vi.fn>).mockResolvedValue({
      version: 'x',
      boards: { [BOARD.id]: { app: 'app.bin', sha256: 'f'.repeat(64) } },
    })
    await expect(flashDevice(BOARD, CFG, {}, h.backend)).rejects.toThrow(/integrity check failed/i)
    // A stale download must never reach the flash.
    expect(h.backend.openSession).not.toHaveBeenCalled()
    expect(h.session.writeFlash).not.toHaveBeenCalled()
  })

  it('flashes when the app SHA and release signature match the manifest', async () => {
    const h = makeHarness()
    await expect(flashDevice(BOARD, CFG, {}, h.backend)).resolves.toBeUndefined()
    expect(h.session.writeFlash).toHaveBeenCalledTimes(1)
  })

  it('rejects — before opening the device — when the release signature does not match', async () => {
    const h = makeHarness()
    ;(h.backend.fetchManifest as ReturnType<typeof vi.fn>).mockResolvedValue({
      version: 'x',
      boards: {
        [BOARD.id]: {
          app: 'app.bin',
          sha256: await sha256hex(DUMMY_APP),
          signature: '00'.repeat(64),
        },
      },
    })
    await expect(flashDevice(BOARD, CFG, {}, h.backend)).rejects.toThrow(/release signature failed/i)
    expect(h.backend.openSession).not.toHaveBeenCalled()
    expect(h.session.writeFlash).not.toHaveBeenCalled()
  })

  it('rejects when the manifest omits the selected board', async () => {
    const h = makeHarness()
    ;(h.backend.fetchManifest as ReturnType<typeof vi.fn>).mockResolvedValue({ version: 'x', boards: {} })
    await expect(flashDevice(BOARD, CFG, {}, h.backend)).rejects.toThrow(/no SHA-256/i)
    expect(h.backend.openSession).not.toHaveBeenCalled()
  })

  it('rejects when the manifest fetch fails', async () => {
    const h = makeHarness()
    ;(h.backend.fetchManifest as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('offline'))
    await expect(flashDevice(BOARD, CFG, {}, h.backend)).rejects.toThrow(/manifest unavailable.*offline/i)
    expect(h.backend.openSession).not.toHaveBeenCalled()
  })

  it('accepts the C6 image signed with the firmware board id esp32c6', async () => {
    const c6 = BOARDS.find((b) => b.id === 'c6')!
    const h = makeHarness()
    const verify = vi.mocked(ed25519.verify)
    verify.mockClear()
    await expect(flashDevice(c6, CFG, {}, h.backend)).resolves.toBeUndefined()
    expect(h.session.writeFlash).toHaveBeenCalledTimes(1)
    const msg = verify.mock.calls.at(-1)?.[1] as Uint8Array
    expect(new TextDecoder().decode(msg)).toContain('heartwood-ota-v1\0esp32c6\0')
  })
})

describe('defaultBackend — fetches fresh (no browser cache)', () => {
  it('fetchBin requests firmware with cache: no-store', async () => {
    const fetchSpy = vi.fn(async () => ({ ok: true, arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer }))
    vi.stubGlobal('fetch', fetchSpy)
    try {
      await defaultBackend.fetchBin('/firmware/v4/app.bin')
      expect(fetchSpy).toHaveBeenCalledWith('/firmware/v4/app.bin', { cache: 'no-store' })
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('fetchManifest requests version.json with cache: no-store', async () => {
    const fetchSpy = vi.fn(async () => ({ ok: true, json: async () => ({ version: '9.9.9', boards: {} }) }))
    vi.stubGlobal('fetch', fetchSpy)
    try {
      const m = await defaultBackend.fetchManifest()
      expect(fetchSpy).toHaveBeenCalledWith('/firmware/version.json', { cache: 'no-store' })
      expect(m.version).toBe('9.9.9')
    } finally {
      vi.unstubAllGlobals()
    }
  })
})

describe('flashAppOnly — quick USB update for non-OTA boards', () => {
  const tdisplay = BOARDS.find((b) => b.id === 'tdisplay')!

  it('writes only the app region at 0x10000 — no erase, no config, no bootloader', async () => {
    const h = makeHarness()
    await flashAppOnly(tdisplay, {}, h.backend)
    const regions = h.wrote()!
    expect(regions.map((r) => r.address)).toEqual([0x10000])
    expect(regions[0].data).toEqual(DUMMY_APP)
    expect(h.fetched).toEqual(['/firmware/tdisplay/app.bin'])
    expect(h.calls.eraseFlash).toBe(0)
    expect(h.calls.hardReset).toBe(1)
    expect(h.calls.close).toBe(1)
  })

  it('refuses a tampered image before opening the esptool session', async () => {
    const h = makeHarness()
    ;(h.backend.fetchManifest as ReturnType<typeof vi.fn>)
      .mockResolvedValue(manifestForSha('tdisplay', ONE_BYTE_SHA))
    await expect(flashAppOnly(tdisplay, {}, h.backend)).rejects.toThrow(/integrity check failed/i)
    expect(h.calls.openSession).toBe(0)
  })

  it('requires Web Serial', async () => {
    const h = makeHarness({ hasWebSerial: false })
    await expect(flashAppOnly(tdisplay, {}, h.backend)).rejects.toThrow(/Web Serial unavailable/)
  })

  const v4 = BOARDS.find((b) => b.id === 'heltec-v4')!

  it('updates a V4 on the single-slot legacy table in place — the board OTA can never install on', async () => {
    const h = makeHarness({ partitionTable: V4_LEGACY_BIGAPP_REAL })
    await flashAppOnly(v4, {}, h.backend)
    expect(h.wrote()!.map((r) => r.address)).toEqual([0x10000])
    expect(h.calls.eraseFlash).toBe(0)
    expect(h.calls.hardReset).toBe(1)
  })

  it('reads the partition table before writing anything', async () => {
    const order: string[] = []
    const h = makeHarness({ partitionTable: V4_LEGACY_BIGAPP_REAL, writeFlash: async () => { order.push('write') } })
    ;(h.session.readFlash as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      order.push('read-table')
      return V4_LEGACY_BIGAPP_REAL
    })
    await flashAppOnly(v4, {}, h.backend)
    expect(order).toEqual(['read-table', 'write'])
  })

  it('refuses a two-slot V4, writes nothing, and boots the board back', async () => {
    const h = makeHarness({ partitionTable: V4_TWO_SLOT })
    await expect(flashAppOnly(v4, {}, h.backend)).rejects.toThrow(/two firmware slots/)
    expect(h.calls.writeFlash).toBe(0)
    expect(h.calls.eraseFlash).toBe(0)
    // detectChip left it in download mode: it must be reset, not left looking dead.
    expect(h.calls.hardReset).toBe(1)
    expect(h.calls.close).toBe(1)
  })

  it('refuses when the table cannot be read', async () => {
    const h = makeHarness({ partitionTable: new Uint8Array(PARTITION_TABLE_SIZE).fill(0xff) })
    await expect(flashAppOnly(v4, {}, h.backend)).rejects.toThrow(/partition table/)
    expect(h.calls.writeFlash).toBe(0)
    expect(h.calls.hardReset).toBe(1)
  })
})

describe('parsePartitionTable', () => {
  it('decodes the real legacy V4 table and stops at the MD5 row', () => {
    expect(parsePartitionTable(V4_LEGACY_BIGAPP_REAL)).toEqual([
      { type: 1, subtype: 0x02, offset: 0x9000, size: 0x6000, label: 'nvs' },
      { type: 1, subtype: 0x01, offset: 0xf000, size: 0x1000, label: 'phy_init' },
      { type: 0, subtype: 0x10, offset: 0x10000, size: 0x400000, label: 'ota_0' },
      { type: 1, subtype: 0x40, offset: 0x410000, size: 0x4000, label: 'config' },
      { type: 1, subtype: 0x00, offset: 0x414000, size: 0x2000, label: 'otadata' },
    ])
  })

  it('reads erased flash as no table at all', () => {
    expect(parsePartitionTable(new Uint8Array(PARTITION_TABLE_SIZE).fill(0xff))).toEqual([])
  })
})

describe('planAppOnlyWrite', () => {
  const beta8 = 2_078_928 // app-heltec-v4.bin, v0.18.0-beta.8

  it('allows the one-slot layouts', () => {
    expect(planAppOnlyWrite(parsePartitionTable(FACTORY_4MB), beta8).ok).toBe(true)
    expect(planAppOnlyWrite(parsePartitionTable(V4_LEGACY_BIGAPP_REAL), beta8).ok).toBe(true)
  })

  it('refuses the A/B layout and says to use OTA', () => {
    const plan = planAppOnlyWrite(parsePartitionTable(V4_TWO_SLOT), beta8)
    expect(plan.ok).toBe(false)
    expect(!plan.ok && plan.reason).toMatch(/two firmware slots.*over the air/)
  })

  it('refuses an image larger than the slot', () => {
    const plan = planAppOnlyWrite(parsePartitionTable(FACTORY_4MB), 0x300001)
    expect(!plan.ok && plan.reason).toMatch(/doesn't fit/)
  })

  it('refuses a slot that does not start at 0x10000', () => {
    const t = table([['nvs', 1, 0x02, 0x9000, 0x6000], ['factory', 0, 0x00, 0x20000, 0x300000]])
    expect(planAppOnlyWrite(parsePartitionTable(t), 1000).ok).toBe(false)
  })

  it('refuses a write that would reach a data partition', () => {
    // A (malformed) table whose data partition sits inside the app range.
    const t = table([
      ['nvs', 1, 0x02, 0x9000, 0x6000],
      ['factory', 0, 0x00, 0x10000, 0x300000],
      ['config', 1, 0x40, 0x20000, 0x4000],
    ])
    const plan = planAppOnlyWrite(parsePartitionTable(t), 0x20000)
    expect(!plan.ok && plan.reason).toMatch(/overlap the "config" partition/)
  })

  it('never lets the write reach NVS on any shipped V4 layout', () => {
    for (const t of [V4_LEGACY_BIGAPP_REAL, FACTORY_4MB]) {
      const entries = parsePartitionTable(t)
      const nvs = entries.find((e) => e.label === 'nvs')!
      expect(nvs.offset + nvs.size).toBeLessThanOrEqual(0x10000)
    }
  })
})

describe('flashTetheredImage — esp8266 single image', () => {
  const ESP8266 = TETHERED_BOARDS[0]

  it('fetches only app.bin from the board asset path', async () => {
    const h = makeHarness()
    await flashTetheredImage(ESP8266, {}, h.backend)
    expect(h.fetched).toEqual([`${ESP8266.assets}/app.bin`])
  })

  it('writes a single region at 0x0 (no partition table, no config blob)', async () => {
    const h = makeHarness()
    await flashTetheredImage(ESP8266, {}, h.backend)
    const regions = h.wrote()!
    expect(regions).toHaveLength(1)
    expect(regions[0].address).toBe(0x0)
  })

  it('closes the session on success', async () => {
    const h = makeHarness()
    await flashTetheredImage(ESP8266, {}, h.backend)
    expect(h.session.close).toHaveBeenCalledTimes(1)
  })

  it('completes and reports done even if hard reset fails (best-effort)', async () => {
    const h = makeHarness({ hardReset: async () => { throw new Error('no reset') } })
    const progress: Array<[number, string]> = []
    await expect(
      flashTetheredImage(ESP8266, { onProgress: (p, s) => progress.push([p, s]) }, h.backend),
    ).resolves.toBeUndefined()
    expect(progress.at(-1)).toEqual([100, 'done'])
  })
})
