import { describe, it, expect, vi } from 'vitest'

vi.mock('@noble/curves/ed25519.js', () => ({
  ed25519: {
    verify: vi.fn((signature: Uint8Array) => signature.some((b) => b !== 0)),
  },
}))

import { ed25519 } from '@noble/curves/ed25519.js'
import {
  flashDevice,
  flashTetheredImage,
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
  hardReset?: () => Promise<void>
  close?: () => Promise<void>
  onWrite?: (report: ReportProgress) => void | Promise<void>
} = {}): Harness {
  const fetched: string[] = []
  let wrote: FlashRegion[] | null = null
  const calls: Record<string, number> = {
    requestPort: 0, openSession: 0, detectChip: 0, eraseFlash: 0, writeFlash: 0, hardReset: 0, close: 0,
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

  it('writes 4 regions at the correct offsets with the config blob last', async () => {
    const h = makeHarness()
    await flashDevice(BOARD, CFG, {}, h.backend)
    const regions = h.wrote()!
    expect(regions).toHaveLength(4)
    expect(regions.map((r) => r.address)).toEqual([0x0, 0x8000, 0x10000, BOARD.configOffset])
  })

  it('appends exactly the config blob buildConfigBlob produces for cfg', async () => {
    const h = makeHarness()
    await flashDevice(BOARD, CFG, {}, h.backend)
    const regions = h.wrote()!
    expect([...regions[3].data]).toEqual([...buildConfigBlob(CFG)])
    expect(regions[3].address).toBe(BOARD.configOffset)
  })

  it('puts the classic-ESP32 (T-Display) bootloader at 0x1000, not 0x0', async () => {
    const tdisplay = BOARDS.find((b) => b.id === 'tdisplay')!
    const h = makeHarness()
    await flashDevice(tdisplay, CFG, {}, h.backend)
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
    await flashDevice(BOARD, CFG, { fullErase: true, onProgress: (p, s) => progress.push([p, s]) }, h.backend)
    expect(h.session.eraseFlash).toHaveBeenCalledTimes(1)
    expect(progress).toContainEqual([0, 'erasing flash'])
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
    await flashDevice(BOARD, CFG, { fullErase: true }, h.backend)
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
