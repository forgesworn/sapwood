import { describe, it, expect, vi } from 'vitest'
import {
  flashDevice,
  BOARDS,
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
    fetchBin: vi.fn(async (url: string) => { fetched.push(url); return new Uint8Array([0xde, 0xad, 0xbe, 0xef]) }),
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

describe('flashDevice — progress mapping', () => {
  it('maps (fileIndex, written, total) to an overall percentage across all regions', async () => {
    const progress: Array<[number, string]> = []
    const h = makeHarness({
      onWrite: (report) => {
        report(0, 100, 100) // bootloader done       -> (0+1)/4 = 25%
        report(1, 0, 100)   // partition table start -> (1+0)/4 = 25%
        report(2, 50, 100)  // firmware half         -> (2+0.5)/4 = 63%
        report(3, 100, 100) // config done           -> (3+1)/4 = 100%
      },
    })
    await flashDevice(BOARD, CFG, { onProgress: (p, s) => progress.push([p, s]) }, h.backend)
    expect(progress).toContainEqual([25, 'bootloader'])
    expect(progress).toContainEqual([25, 'partition table'])
    expect(progress).toContainEqual([63, 'firmware'])
    expect(progress).toContainEqual([100, 'config'])
  })

  it('guards against a zero total (avoids NaN)', async () => {
    const progress: Array<[number, string]> = []
    const h = makeHarness({ onWrite: (report) => report(2, 0, 0) }) // (2+0)/4 = 50%
    await flashDevice(BOARD, CFG, { onProgress: (p, s) => progress.push([p, s]) }, h.backend)
    expect(progress).toContainEqual([50, 'firmware'])
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
