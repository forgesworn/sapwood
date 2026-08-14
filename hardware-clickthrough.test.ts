// Hardware click-through equivalent: drives the EXACT store functions the
// Identity/Device panel buttons call, over the real SerialTransport wired to
// a real signer via node-serialport (only the Web Serial chooser is
// bypassed). Untracked bench artefact — run explicitly, never in CI:
//
//   npx vitest run hardware-clickthrough.test.ts
//
// Preconditions: the bench Heltec V4 on HEARTWOOD_PORT (unlocked; the
// vault-unlock script's SESSION_AUTH also satisfies the 0x10 path for this
// boot), and ~/heartwood-bench/{bridge.secret,bench-client.key,
// bench-client.pairing.json} from the pairing ceremony.
import { describe, it, expect, beforeAll } from 'vitest'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { Readable, Writable } from 'node:stream'
import { getPublicKey } from 'nostr-tools/pure'
import { hexToBytes } from '@noble/hashes/utils.js'
import { nip19 } from 'nostr-tools'
import { transport } from './src/lib/serial.js'
import {
  device, refreshMasters,
  ensureSapwoodPairing, serialDerivePersona, serialRemovePersona, serialRenamePersona,
  getFirmwareVersion,
} from './src/lib/device.svelte.js'
import { storageGauge } from './src/lib/storage-gauge.js'

const PORT = process.env.HEARTWOOD_PORT ?? '/dev/cu.usbmodem3401'
const BENCH = `${homedir()}/heartwood-bench`
const readHex = (f: string) => readFileSync(`${BENCH}/${f}`, 'utf8').trim()

async function until<T>(fn: () => T | undefined | false, ms = 15000): Promise<T> {
  const start = Date.now()
  while (Date.now() - start < ms) {
    const v = fn()
    if (v) return v as T
    await new Promise((r) => setTimeout(r, 200))
  }
  throw new Error('condition not met in time')
}

beforeAll(async () => {
  // Browser-side state the UI would hold: this browser's bridge secret, the
  // manager client key, and the pairing record — so the run needs no device
  // button (the ceremony already happened on this board).
  localStorage.setItem('heartwood.bridgeSecret', readHex('bridge.secret'))
  localStorage.setItem('heartwood_nip46_usb_client_key', readHex('bench-client.key'))

  const { SerialPort } = await import('serialport')
  const sp = new SerialPort({ path: PORT, baudRate: 115200 })
  await new Promise<void>((resolve, reject) => { sp.on('open', () => resolve()); sp.on('error', reject) })
  // Hand the REAL transport a real port: everything above the Web Serial
  // chooser (framing, pacing, request queue, store event wiring) is the
  // production code path.
  const t = transport as unknown as Record<string, unknown> & { emit: (e: unknown) => void; readLoop: () => Promise<void> }
  t.port = {
    readable: Readable.toWeb(sp),
    writable: Writable.toWeb(sp),
    getInfo: () => ({ usbVendorId: 0x303a, usbProductId: 0x1001 }),
  }
  t.running = true
  ;(t.stream as { reset: () => void }).reset()
  t.writeChain = Promise.resolve()
  t.emit({ kind: 'connected', port: 'bench-harness' })
  void t.readLoop()
  await new Promise((r) => setTimeout(r, 500))

  await refreshMasters()
  const masters = await until(() => (device.masters.some((m) => !m.persona) ? device.masters : false))
  const masterRow = masters.find((m) => m.slot === 0 && !m.persona)!
  const masterHex = nip19.decode(masterRow.npub).data as string
  const pairing = JSON.parse(readFileSync(`${BENCH}/bench-client.pairing.json`, 'utf8'))
  localStorage.setItem(
    `heartwood_nip46_usb_pairing:${masterHex}`,
    JSON.stringify({ slotIndex: pairing.slot_index, client: getPublicKey(hexToBytes(readHex('bench-client.key'))) }),
  )
}, 60000)

describe('Identity panel store path on real hardware', () => {
  let npub = ''

  it('pairing is recognised without a new ceremony', async () => {
    const masterHex = await ensureSapwoodPairing()
    expect(masterHex).toMatch(/^[0-9a-f]{64}$/)
  })

  it('creates a persona (Add a persona)', async () => {
    const persona = await serialDerivePersona('family-test')
    expect(persona.purpose).toBe('nostr:persona:family-test')
    expect(persona.personaName).toBe('family-test')
    npub = persona.npub
    await until(() => device.masters.some((m) => m.persona && m.label === 'family-test'))
  })

  it('renames it (Rename…)', async () => {
    await serialRenamePersona(npub, 'Family Test')
    await until(() => device.masters.some((m) => m.persona && m.label === 'Family Test'))
  })

  it('removes it, and the same name re-derives the same key (Remove…)', async () => {
    await serialRemovePersona(npub)
    await until(() => !device.masters.some((m) => m.persona && (m.label === 'Family Test' || m.label === 'family-test')))
    const again = await serialDerivePersona('family-test')
    expect(again.npub).toBe(npub)
    await serialRemovePersona(npub)
    await until(() => !device.masters.some((m) => m.persona && m.label === 'family-test'))
  })

  it('storage gauge reads from live firmware stats (Device panel)', async () => {
    const info = await getFirmwareVersion()
    expect(info?.nvs_used_entries).toBeTypeOf('number')
    expect(info?.max_personas).toBe(32)
    const gauge = storageGauge(info?.nvs_used_entries, info?.nvs_total_entries)
    expect(gauge).not.toBeNull()
    expect(gauge!.state).toBe('ok')
  })
})
