// Hardware bench for the C4/C5 firmware (family bunker Phase 4/5): the
// autonomous, button-free half.
//
// What this proves on the real signer, with no hands on the device:
//   1. the upgraded firmware boots, unlocks and serves (regression);
//   2. the bench-manager pairing still drives the persona registry silently;
//   3. a fresh CONNECT_SAFE client slot pairs over the REAL relay and a
//      nip44_encrypt addressed to a dependant-tagged persona auto-approves;
//   4. that policy decision emits the C5 kind-1059 audit wrap to the
//      guardian NP — fetched from the relay, decrypted BY THE DEVICE (the
//      NP persona is its own decryption oracle over the same client slot),
//      and byte-checked against the ratified §2 rumor shape, seal signature
//      included;
//   5. cleanup restores the signer's original slots and registry.
//
// The interactive half (park/notify/resolve round-trips, petition
// coalescing, reboot-with-parked, the child wrap, countdown visuals) needs
// button presses and an operator console — scripted in
// heartwood-esp32/docs/HARDWOOD-TEST-CHECKLIST §11 for a desk session.
//
// Run explicitly, never in CI:
//   npx vitest run --config vitest.hardware.config.ts hardware-escalation.test.ts
//
// Preconditions: bench signer on HEARTWOOD_PORT (wifi-standalone, primary
// relay = HEARTWOOD_BENCH_RELAY) and ~/heartwood-bench/{bridge.secret,
// vault.key,bench-client.key,bench-client.pairing.json}.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { Readable, Writable } from 'node:stream'
import { finalizeEvent, generateSecretKey, getPublicKey, verifyEvent, getEventHash } from 'nostr-tools/pure'
import { getConversationKey, encrypt as nip44encrypt, decrypt as nip44decrypt } from 'nostr-tools/nip44'
import { SimplePool } from 'nostr-tools/pool'
import { hexToBytes } from '@noble/hashes/utils.js'
import { transport } from './src/lib/serial.js'
import { FrameType, buildSessionAuth, buildVaultUnlock, buildConnSlotList } from './src/lib/frame.js'
import {
  device, refreshMasters, getFirmwareVersion,
  serialCreateClient, serialRevokeClient,
  serialDerivePersona, serialRemovePersona,
} from './src/lib/device.svelte.js'
import { npubToHex } from './src/lib/recovery.js'

const PORT = process.env.HEARTWOOD_PORT ?? '/dev/cu.usbmodem3401'
const RELAY = process.env.HEARTWOOD_BENCH_RELAY ?? 'wss://relay.trotters.cc'
const BENCH = `${homedir()}/heartwood-bench`
const readBench = (f: string) => readFileSync(`${BENCH}/${f}`, 'utf8').trim()

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

// --- Port lifecycle (same harness as hardware-recovery.test.ts) -----------

let sp: { close: (cb?: () => void) => void } | null = null

async function attachPort(retryMs = 45_000): Promise<void> {
  const { SerialPort } = await import('serialport')
  const start = Date.now()
  let lastError: unknown = null
  while (Date.now() - start < retryMs) {
    try {
      const port = new SerialPort({ path: PORT, baudRate: 115200 })
      await new Promise<void>((resolve, reject) => { port.on('open', () => resolve()); port.on('error', reject) })
      sp = port
      const t = transport as unknown as Record<string, unknown> & { emit: (e: unknown) => void; readLoop: () => Promise<void> }
      t.port = {
        readable: Readable.toWeb(port as never),
        writable: Writable.toWeb(port as never),
        getInfo: () => ({ usbVendorId: 0x303a, usbProductId: 0x1001 }),
      }
      t.running = true
      ;(t.stream as { reset: () => void }).reset()
      t.writeChain = Promise.resolve()
      t.emit({ kind: 'connected', port: 'bench-harness' })
      void t.readLoop()
      await sleep(500)
      device.bridgeAuthed = false
      return
    } catch (error) {
      lastError = error
      await sleep(2000)
    }
  }
  throw new Error(`could not open ${PORT}: ${lastError}`)
}

async function unlockVault(): Promise<void> {
  const ack = await transport.sendAndReceive(buildSessionAuth(readBench('bridge.secret')), [FrameType.SESSION_ACK], 15_000)
  if (ack.payload[0] !== 0x00) throw new Error('bridge session auth failed')
  const resp = await transport.sendAndReceive(
    buildVaultUnlock(hexToBytes(readBench('vault.key'))),
    [FrameType.ACK, FrameType.NACK],
    180_000,
  )
  console.log(resp.type === FrameType.ACK ? 'vault unlocked' : 'vault already open')
}

async function awaitRelayReady(ms = 120_000): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < ms) {
    try {
      const resp = await transport.sendAndReceive(buildConnSlotList(0), [0x43, FrameType.NACK], 4000)
      if (resp.type === 0x43) return
    } catch { /* still booting or joining wifi */ }
    await sleep(2000)
  }
  throw new Error('signer did not reach its relay loop in time')
}

// --- A hand-rolled NIP-46 relay client (deterministic, bounded) -----------

const pool = new SimplePool({ enablePing: false, enableReconnect: true })
const clientSk = generateSecretKey()
const clientPub = getPublicKey(clientSk)
const pending = new Map<string, (msg: { result?: string; error?: string }) => void>()
let rpcSeq = 0

// Raw WebSocket subscriptions: kind 24133 is ephemeral (forward-only), and
// the empirical probe showed the relay forwards to a bare REQ where the
// SimplePool subscription stayed silent. Publishing still goes via the pool
// (relay OKs confirmed every run).
const rawSockets: Array<{ close: () => void }> = []

function rawSub(filter: Record<string, unknown>, onEvent: (ev: never) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(RELAY)
    const subId = `bench-sub-${rawSockets.length}`
    rawSockets.push(ws as never)
    ws.onopen = () => { ws.send(JSON.stringify(['REQ', subId, filter])); resolve() }
    ws.onerror = () => reject(new Error('subscription socket failed'))
    ws.onmessage = (msg: MessageEvent) => {
      try {
        const frame = JSON.parse(String(msg.data))
        if (frame[0] === 'EVENT' && frame[1] === subId) onEvent(frame[2])
        if (frame[0] === 'NOTICE' || frame[0] === 'CLOSED') console.log(`   [sub ${subId}]`, String(msg.data).slice(0, 120))
      } catch { /* not JSON */ }
    }
  })
}

function openResponseSub(): Promise<void> {
  return rawSub({ kinds: [24133], '#p': [clientPub], since: Math.floor(Date.now() / 1000) - 10 }, (ev: { pubkey: string; content: string }) => {
    try {
      const conv = getConversationKey(clientSk, ev.pubkey)
      const msg = JSON.parse(nip44decrypt(ev.content, conv)) as { id?: string; result?: string; error?: string }
      const resolve = msg.id ? pending.get(msg.id) : undefined
      if (resolve) { pending.delete(msg.id!); resolve(msg) }
    } catch { /* someone else's traffic */ }
  })
}

async function rpc(targetHex: string, method: string, params: string[], timeoutMs = 25_000): Promise<string> {
  const id = `bench-${Date.now()}-${rpcSeq++}`
  const conv = getConversationKey(clientSk, targetHex)
  const event = finalizeEvent({
    kind: 24133,
    created_at: Math.floor(Date.now() / 1000),
    tags: [['p', targetHex]],
    content: nip44encrypt(JSON.stringify({ id, method, params }), conv),
  }, clientSk)
  const reply = new Promise<{ result?: string; error?: string }>((resolve, reject) => {
    pending.set(id, resolve)
    setTimeout(() => { pending.delete(id); reject(new Error(`${method} timed out`)) }, timeoutMs)
  })
  const published = await Promise.allSettled(pool.publish([RELAY], event))
  for (const r of published) {
    console.log(`   [rpc] ${method} publish:`, r.status === 'fulfilled' ? `ok (${r.value})` : `refused (${r.reason})`)
  }
  const msg = await reply
  if (msg.error) throw new Error(`${method}: ${msg.error}`)
  return msg.result ?? ''
}

// --- Bench state ----------------------------------------------------------

let masterHex = ''
let npHex = ''
let dep9Hex = ''
let priorPersonaNpubs = new Set<string>()
let childSlotIndex = -1
let childSecret = ''
const wraps: Array<{ id: string; pubkey: string; created_at: number; kind: number; tags: string[][]; content: string; sig: string }> = []

beforeAll(async () => {
  localStorage.setItem('heartwood.bridgeSecret', readBench('bridge.secret'))
  localStorage.setItem('heartwood_nip46_usb_client_key', readBench('bench-client.key'))

  await attachPort()
  device.mode = 'serial'
  // Tail the signer's own log stream into the bench output — the only view
  // into policy decisions, emission attempts and publish errors on-chip.
  transport.on((event) => {
    if ((event as { kind?: string }).kind === 'log') {
      const line = (event as { line?: string }).line ?? ''
      if (/relay|escalat|audit|park|wrap|persona|connect|nip44|slot/i.test(line)) {
        console.log(`   [device] ${line}`)
      }
    }
  })
  await unlockVault()
  await awaitRelayReady()
  await refreshMasters()
  const master = device.masters.find((m) => !m.persona && m.slot === 0)
  if (!master) throw new Error('no master in slot 0')
  masterHex = npubToHex(master.npub)
  device.selectedSlot = 0
  // The CP1 bench pairing (slot 6, bench-client.key) drives the registry
  // without buttons; the derive path never touches the manager ceiling.
  localStorage.setItem(`heartwood_nip46_usb_pairing:${masterHex}`, readBench('bench-client.pairing.json'))
  // Pre-clean residue from an earlier failed run: this bench owns exactly
  // these registry names, and the device carried none before its first run.
  for (const stale of device.masters.filter((m) => m.persona && m.slot === 0
    && (['natural-person', 'dependant-9-np'].includes(m.label ?? '')
      // Residue observed from the first bench runs (label unknown).
      || m.npub === 'npub19sl7zjykadw8daye7fh6us3ykzerum6e0csp4zuzxwjkvhrpmn2sq6f7ag'))) {
    console.log(`pre-clean: removing stale bench persona ${stale.label}`)
    await serialRemovePersona(stale.npub)
  }
  await refreshMasters()
  priorPersonaNpubs = new Set(
    device.masters.filter((m) => m.persona && m.slot === 0).map((m) => m.npub),
  )
  if (priorPersonaNpubs.size) console.log(`pre-existing personas kept: ${priorPersonaNpubs.size}`)
  openResponseSub()
}, 300_000)

afterAll(() => {
  for (const ws of rawSockets) { try { ws.close() } catch { /* already closed */ } }
  pool.destroy()
})

describe('C4/C5 firmware on real hardware — the button-free half', () => {
  it('is running the upgraded firmware', async () => {
    const info = await getFirmwareVersion()
    expect(info).not.toBeNull()
    console.log(`firmware ${info!.version} on ${info!.board ?? 'unknown board'}`)
    expect(info!.version).toBe('0.17.0')
  }, 30_000)

  it('bench manager still drives the persona registry (regression)', async () => {
    const np = await serialDerivePersona('natural-person')
    npHex = npubToHex(np.npub)
    const dep = await serialDerivePersona('dependant-9-np')
    dep9Hex = npubToHex(dep.npub)
    console.log(`guardian NP ${npHex.slice(0, 12)}…, bench dependant ${dep9Hex.slice(0, 12)}…`)
    expect(npHex).toMatch(/^[0-9a-f]{64}$/)
    expect(dep9Hex).toMatch(/^[0-9a-f]{64}$/)
    expect(npHex).not.toBe(dep9Hex)
  }, 120_000)

  it('pairs a child-app slot over the relay and signs silently as the dependant', async () => {
    const created = await serialCreateClient('bench-child')
    childSlotIndex = created.slot_index
    childSecret = created.secret
    console.log(`bench-child slot ${childSlotIndex} created (CONNECT_SAFE, auto-approve)`)

    // Watch the guardian NP's gift-wrap inbox BEFORE the trigger. Wrap
    // timestamps are jittered up to two days into the past (NIP-59), so the
    // filter window opens that far back.
    await rawSub({ kinds: [1059], '#p': [npHex], since: Math.floor(Date.now() / 1000) - 173_000 },
      (ev) => { wraps.push(ev as never) })
    await sleep(1000)

    // Bind the client to the slot (connect with secret — no button), then
    // the trigger: a nip44_encrypt addressed to the dependant persona. The
    // slot lists it auto-approved, so the decision is silent — exactly the
    // policy-decided outcome the C5 rail exists to record.
    // Heartwood echoes the validated secret back (NIP-46 possession proof).
    // One retry: the first ask can race the signer's post-derive re-REQ.
    let ack: string
    try {
      ack = await rpc(dep9Hex, 'connect', [dep9Hex, childSecret], 30_000)
    } catch (error) {
      console.log(`connect attempt 1: ${error instanceof Error ? error.message : error}; retrying`)
      await sleep(5000)
      ack = await rpc(dep9Hex, 'connect', [dep9Hex, childSecret], 30_000)
    }
    expect(ack).toBe(childSecret)
    const ciphertext = await rpc(dep9Hex, 'nip44_encrypt', [clientPub, 'bench probe — metadata only, never content'])
    expect(ciphertext.length).toBeGreaterThan(50)
    console.log('nip44_encrypt as the dependant auto-approved over the relay')
  }, 120_000)

  it('emits the C5 audit wrap, device-decrypted and matching the ratified shape', async () => {
    const start = Date.now()
    let record: { wrap: (typeof wraps)[number]; rumor: Record<string, unknown> } | null = null
    while (!record && Date.now() - start < 60_000) {
      for (const wrap of wraps.splice(0)) {
        try {
          // The device is the only holder of the NP key: it decrypts its own
          // rail. Wrap layer first (peer = the ephemeral wrap author)…
          const sealJson = await rpc(npHex, 'nip44_decrypt', [wrap.pubkey, wrap.content])
          const seal = JSON.parse(sealJson)
          if (seal.kind !== 13) continue
          // …then the seal (guardian NP self-conversation).
          const rumorJson = await rpc(npHex, 'nip44_decrypt', [seal.pubkey, seal.content])
          const rumor = JSON.parse(rumorJson)
          const dTag: string = rumor.tags?.find((t: string[]) => t[0] === 'd')?.[1] ?? ''
          const pTag: string = rumor.tags?.find((t: string[]) => t[0] === 'p')?.[1] ?? ''
          // Earlier runs' wraps for the same bench dependant persist on the
          // relay; this run's record is the one naming THIS client.
          if (rumor.kind === 31000 && dTag.startsWith(`${dep9Hex}:`) && pTag === clientPub) {
            // Consumer forgery gate: the seal must be SIGNED by the guardian
            // NP, and verify. So must the wrap under its ephemeral key.
            expect(seal.pubkey).toBe(npHex)
            expect(verifyEvent(seal)).toBe(true)
            expect(verifyEvent(wrap as never)).toBe(true)
            record = { wrap, rumor }
            break
          }
        } catch { /* another family's wrap, or not ours yet */ }
      }
      if (!record) await sleep(2000)
    }
    expect(record, 'no audit wrap arrived for the bench dependant').not.toBeNull()
    const { wrap, rumor } = record!

    // Wrap layer: ephemeral author, exactly one p tag, NO expiration —
    // audit is the permanent record.
    expect(wrap.kind).toBe(1059)
    expect(wrap.pubkey).not.toBe(npHex)
    expect(wrap.tags).toEqual([['p', npHex]])

    // Rumor: the §2 shape the app's Activity page reads, byte-checked.
    expect(rumor.pubkey).toBe(npHex)
    expect(rumor.content).toBe('')
    expect(rumor.sig).toBeUndefined()
    expect(rumor.id).toBe(getEventHash(rumor as never))
    const tags = rumor.tags as string[][]
    expect(tags[0]).toEqual(['t', 'audit'])
    const ms = Number(tags[1][1].slice(65))
    expect(Math.floor(ms / 1000)).toBe(rumor.created_at)
    expect(tags.find((t) => t[0] === 'method')?.[1]).toBe('nip44_encrypt')
    expect(tags.find((t) => t[0] === 'outcome')?.[1]).toBe('auto-approved')
    expect(tags.find((t) => t[0] === 'p')?.[1]).toBe(clientPub)
    expect(tags.find((t) => t[0] === 'k')).toBeUndefined()
    expect(tags.find((t) => t[0] === 'expiration')).toBeUndefined()
    // Request-derived stamp: the trigger was seconds ago, not clockless junk.
    expect(Math.abs(rumor.created_at as number - Math.floor(Date.now() / 1000))).toBeLessThan(300)
    // NIP-59 jitter: seal and wrap stamps sit at or before the rumor's, never after.
    const seal = JSON.parse(await rpc(npHex, 'nip44_decrypt', [wrap.pubkey, wrap.content]))
    expect(seal.created_at).toBeLessThanOrEqual(rumor.created_at as number)
    expect(wrap.created_at).toBeLessThanOrEqual(rumor.created_at as number)
    console.log(`C5 rumor verified on-device: d=${tags[1][1].slice(0, 20)}… outcome=auto-approved`)
  }, 180_000)

  it('cleanup restores the signer', async () => {
    if (childSlotIndex >= 0) await serialRevokeClient(childSlotIndex)
    // Removals can surface a cached identity into the registry on the same
    // pass, so sweep until the list is stable rather than trusting one walk.
    for (let pass = 1; pass <= 4; pass++) {
      await refreshMasters()
      const extras = device.masters.filter(
        (m) => m.persona && m.slot === 0 && !priorPersonaNpubs.has(m.npub),
      )
      if (!extras.length) break
      console.log(`cleanup pass ${pass}: ${extras.map((m) => `${m.label ?? '?'}=${npubToHex(m.npub).slice(0, 8)}`).join(', ')}`)
      for (const persona of extras) {
        try {
          await serialRemovePersona(persona.npub)
          console.log(`removed bench persona ${persona.label ?? persona.npub.slice(0, 12)}`)
        } catch (error) {
          // "no such persona" = a stale listing row; the re-list next pass
          // is the arbiter of what actually remains.
          console.log(`remove ${persona.label ?? '?'}: ${error instanceof Error ? error.message : error}`)
        }
      }
    }
    await refreshMasters()
    const now = new Set(device.masters.filter((m) => m.persona && m.slot === 0).map((m) => m.npub))
    expect([...now].sort()).toEqual([...priorPersonaNpubs].sort())
    console.log('signer back on its original slots and registry')
  }, 300_000)
})
