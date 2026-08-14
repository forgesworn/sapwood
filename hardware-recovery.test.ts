// Hardware bench for Path B family recovery: the words-only half of CP2.
//
// A throwaway guardian is created from FRESH words each run. The host derives
// the whole family from those words (the same maths My Signet runs), publishes
// a real self-encrypted `signet:dependants` roster to the sync relay, then
// provisions the tree onto the signer and walks the EXACT store functions the
// recovery wizard drives: pair → derive natural-person → fetch → device-side
// nip44_decrypt → parse → enrol with npub verification. Every device-derived
// key must equal the host-derived expectation, or the run fails.
//
// Run explicitly, never in CI:
//   npx vitest run --config vitest.hardware.config.ts hardware-recovery.test.ts
//
// Wifi-standalone reboot semantics: a master-set change (PROVISION, and each
// PROVISION_REMOVE in cleanup) makes the signer REBOOT to re-subscribe its
// relay set. The harness rides through each one: reopen the port, re-run the
// vault unlock (slow KDF), then wait for the relay loop to serve USB again.
//
// Preconditions: bench signer on HEARTWOOD_PORT and ~/heartwood-bench/
// {bridge.secret,vault.key,bench-client.key}. Button interactions, announced
// in the output: the manager-pairing ceiling confirm, and one HOLD per
// bench-family removal during cleanup.
import { describe, it, expect, beforeAll } from 'vitest'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { Readable, Writable } from 'node:stream'
import { finalizeEvent } from 'nostr-tools/pure'
import { getConversationKey, encrypt } from 'nostr-tools/nip44'
import { SimplePool } from 'nostr-tools/pool'
import { hexToBytes } from '@noble/hashes/utils.js'
import { transport } from './src/lib/serial.js'
import { FrameType, buildSessionAuth, buildVaultUnlock, buildConnSlotList } from './src/lib/frame.js'
import {
  device, refreshMasters, provisionSecret, removeIdentity,
  serialDerivePersona, serialRemovePersona, serialRenamePersona,
  serialDeviceDecrypt, serialRevokeClient,
} from './src/lib/device.svelte.js'
import { generateMnemonic, deriveFromMnemonic, deriveChild } from './src/lib/provision.js'
import {
  fetchDependantsManifest, parseDependantsManifest, buildEnrolmentPlan,
  npubToHex, runEnrolment, NATURAL_PERSON_NAME,
  type EnrolmentPlan, type EnrolmentResult,
} from './src/lib/recovery.js'

const PORT = process.env.HEARTWOOD_PORT ?? '/dev/cu.usbmodem3401'
const RELAY = process.env.HEARTWOOD_BENCH_RELAY ?? 'wss://relay.trotters.cc'
const BENCH = `${homedir()}/heartwood-bench`
const readHex = (f: string) => readFileSync(`${BENCH}/${f}`, 'utf8').trim()

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function until<T>(fn: () => T | undefined | false, ms = 15000): Promise<T> {
  const start = Date.now()
  while (Date.now() - start < ms) {
    const v = fn()
    if (v) return v as T
    await sleep(200)
  }
  throw new Error('condition not met in time')
}

// --- Port lifecycle (the signer reboots on master-set changes) ------------

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
      device.bridgeAuthed = false // per-boot state on the signer
      return
    } catch (error) {
      lastError = error
      await sleep(2000)
    }
  }
  throw new Error(`could not reopen ${PORT}: ${lastError}`)
}

async function detachPort(): Promise<void> {
  const t = transport as unknown as { running: boolean }
  t.running = false
  await new Promise<void>((resolve) => { sp ? sp.close(() => resolve()) : resolve() })
  sp = null
  await sleep(300)
}

/** SESSION_AUTH + VAULT_UNLOCK, riding the signer's slow unseal KDF. A NACK
 *  means the vault is already open — also fine. */
async function unlockVault(): Promise<void> {
  const ack = await transport.sendAndReceive(buildSessionAuth(readHex('bridge.secret')), [FrameType.SESSION_ACK], 15_000)
  if (ack.payload[0] !== 0x00) throw new Error('bridge session auth failed after reboot')
  const resp = await transport.sendAndReceive(
    buildVaultUnlock(hexToBytes(readHex('vault.key'))),
    [FrameType.ACK, FrameType.NACK],
    180_000,
  )
  console.log(resp.type === FrameType.ACK ? 'vault unlocked' : 'vault already open')
}

/** The relay loop's USB pump is the only phase that serves CONNSLOT frames,
 *  so a CONNSLOT_LIST answer means the signer is fully up (wifi joined). */
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

/** Full reboot ride: the signer just restarted itself. */
async function rideReboot(): Promise<void> {
  await detachPort()
  await sleep(4000)
  await attachPort()
  await unlockVault()
  await awaitRelayReady()
  await refreshMasters()
  await until(() => device.masters.length > 0)
}

// --- The throwaway family, derived host-side from fresh words -------------

const mnemonic = generateMnemonic()
let rootSecret!: Uint8Array
let rootNpub = ''
let npSecret!: Uint8Array
let npHex = ''
const expected = new Map<string, string>() // derivation name -> hex pubkey

function expectChild(name: string): string {
  const child = deriveChild(rootSecret, `nostr:persona:${name}`)
  const hex = npubToHex(child.npub)
  expected.set(name, hex)
  child.secret.fill(0)
  return hex
}

let benchSlot = -1
let plan: EnrolmentPlan | null = null
let enrolment: EnrolmentResult | null = null

beforeAll(async () => {
  const root = await deriveFromMnemonic(mnemonic, '')
  rootSecret = root.secret
  rootNpub = root.npub
  const np = deriveChild(rootSecret, `nostr:persona:${NATURAL_PERSON_NAME}`)
  npSecret = np.secret
  npHex = npubToHex(np.npub)

  localStorage.setItem('heartwood.bridgeSecret', readHex('bridge.secret'))
  localStorage.setItem('heartwood_nip46_usb_client_key', readHex('bench-client.key'))

  await attachPort()
  await unlockVault()
  await awaitRelayReady()
  await refreshMasters()
  await until(() => device.masters.length > 0)
}, 300_000)

describe('Path B words-only recovery on real hardware', () => {
  it('publishes the roster to the relay, self-encrypted to the natural person', async () => {
    const dep = (index: number, name: string, personaName: string) => ({
      id: expectChild(`dependant-${index}-np`),
      guardianPubkey: npHex,
      displayName: name,
      derivationPath: `dependant-${index}`,
      autonomyStage: 'request-approve',
      primaryKeypair: 'natural-person',
      createdAt: Math.floor(Date.now() / 1000),
      np: { publicKey: expected.get(`dependant-${index}-np`)!, displayName: name },
      persona: { publicKey: expectChild(`dependant-${index}-persona`), displayName: personaName },
    })
    const alice = {
      ...dep(0, 'Alice', 'starling'),
      extras: [{
        derivationName: 'dependant-0-persona-1',
        publicKey: expectChild('dependant-0-persona-1'),
        displayName: 'Gamer',
      }],
    }
    const bob = dep(1, 'Bob', 'wren')
    const viewOnly = {
      id: 'f'.repeat(64),
      guardianPubkey: npHex,
      displayName: 'Watched cousin',
      derivationPath: 'imported-view-bench',
      autonomyStage: 'full-control',
      primaryKeypair: 'natural-person',
      createdAt: Math.floor(Date.now() / 1000),
      np: { publicKey: 'f'.repeat(64), displayName: 'Cousin' },
      persona: { publicKey: '', displayName: '' },
      viewOnly: true,
    }
    const payload = JSON.stringify({ v: 1, dependants: [alice, bob, viewOnly] })
    const ciphertext = encrypt(payload, getConversationKey(npSecret, npHex))
    const event = finalizeEvent({
      kind: 30078,
      created_at: Math.floor(Date.now() / 1000),
      tags: [['d', 'signet:dependants']],
      content: ciphertext,
    }, npSecret)
    const pool = new SimplePool({ enablePing: false, enableReconnect: true })
    try {
      const results = await Promise.allSettled(pool.publish([RELAY], event))
      for (const r of results) {
        console.log('relay publish:', r.status === 'fulfilled' ? `ok (${r.value})` : `refused (${r.reason})`)
      }
    } finally {
      pool.destroy()
    }
    // The publish call alone can false-succeed on a dead socket; the roster is
    // only "published" when it can be fetched back.
    let confirmed = await fetchDependantsManifest([RELAY], npHex)
    for (let attempt = 0; !confirmed && attempt < 4; attempt++) {
      await sleep(2000)
      confirmed = await fetchDependantsManifest([RELAY], npHex)
    }
    expect(confirmed, 'roster not readable back from the relay').not.toBeNull()
    console.log(`roster published for ${npHex.slice(0, 12)}… on ${RELAY}`)
  }, 60_000)

  it('provisions the guardian tree from fresh words, riding the reboot', async () => {
    await provisionSecret(new Uint8Array(rootSecret), 'bench-family', 'tree-mnemonic')
    console.log('provision acknowledged; the signer reboots to re-subscribe — riding it out')
    await rideReboot()
    const row = await until(() => device.masters.find((m) => !m.persona && m.npub === rootNpub))
    benchSlot = row.slot
    device.selectedSlot = benchSlot
    console.log(`bench-family provisioned in slot ${benchSlot}`)
  }, 300_000)

  it('derives the natural person on the signer, matching the words', async () => {
    // A missed button window costs one attempt, not the run: the pairing
    // helper revokes its half-created slot on failure, so a retry starts a
    // clean ceremony with a fresh approval window on the signer.
    let persona: Awaited<ReturnType<typeof serialDerivePersona>> | null = null
    for (let attempt = 1; attempt <= 3 && !persona; attempt++) {
      console.log(`\n>>> BUTTON (attempt ${attempt}/3): approve the "Sapwood manager" pairing on the signer when its screen asks.\n`)
      await sleep(3000)
      try {
        persona = await serialDerivePersona(NATURAL_PERSON_NAME)
      } catch (error) {
        console.log(`pairing attempt ${attempt} failed: ${error instanceof Error ? error.message : String(error)}`)
        if (attempt === 3) throw error
        await sleep(5000)
      }
    }
    expect(npubToHex(persona!.npub)).toBe(npHex)
    console.log('natural person parity confirmed: device matches the words')
  }, 300_000)

  it('fetches the roster and the signer decrypts it', async () => {
    const manifest = await fetchDependantsManifest([RELAY], npHex)
    expect(manifest).not.toBeNull()
    const plaintext = await serialDeviceDecrypt(npHex, npHex, manifest!.content)
    const parsed = parseDependantsManifest(plaintext)
    expect(parsed.dependants).toHaveLength(3)
    plan = buildEnrolmentPlan(parsed)
    expect(plan.entries.map((entry) => entry.derivationName)).toEqual([
      'persona', 'professional',
      'dependant-0-np', 'dependant-0-persona', 'dependant-0-persona-1',
      'dependant-1-np', 'dependant-1-persona',
    ])
    expect(plan.skipped).toHaveLength(1)
    console.log('signer decrypted the roster; plan has 7 entries, 1 view-only skip')
  }, 60_000)

  it('enrols the family, every derived key matching the roster', async () => {
    enrolment = await runEnrolment(plan!.entries, {
      derive: (name) => serialDerivePersona(name),
      rename: (npub, label) => serialRenamePersona(npub, label),
    }, (row) => console.log(`  ${row.outcome === 'verified' ? '✓' : '✗'} ${row.derivationName} (${row.displayName})`))
    expect(enrolment.complete).toBe(true)
    // Every expectation came from the words on the host; every derivation
    // happened on the chip. All must agree.
    for (const row of enrolment.rows.filter((r) => r.expectedPubkey)) {
      expect(npubToHex(row.npub!)).toBe(expected.get(row.derivationName))
    }
    await refreshMasters()
    await until(() => {
      const labels = device.masters.filter((m) => m.persona && m.slot === benchSlot).map((m) => m.label)
      return labels.includes('Alice') && labels.includes('Gamer')
    })
  }, 300_000)

  it('cleans up: personas, pairing, and every bench-family tree removed', async () => {
    for (const row of [...(enrolment?.rows ?? [])].reverse()) {
      if (row.npub) await serialRemovePersona(row.npub)
    }
    const npRow = device.masters.find((m) => m.persona && m.slot === benchSlot && npubToHex(m.npub) === npHex)
    if (npRow) await serialRemovePersona(npRow.npub)
    const pairing = localStorage.getItem(`heartwood_nip46_usb_pairing:${npubToHex(rootNpub)}`)
    if (pairing) {
      const { slotIndex } = JSON.parse(pairing) as { slotIndex: number }
      await serialRevokeClient(slotIndex)
    }
    await refreshMasters()
    expect(device.masters.some((m) => m.persona && m.slot === benchSlot)).toBe(false)
    // Remove every bench-family master (this run's, plus any orphan from an
    // earlier failed run). Each removal reboots the signer; ride each one.
    for (;;) {
      const stale = device.masters.find((m) => !m.persona && m.label === 'bench-family')
      if (!stale) break
      console.log(`\n>>> BUTTON: HOLD the signer button to confirm removing bench-family (slot ${stale.slot}).\n`)
      await removeIdentity(stale.slot)
      await rideReboot()
    }
    expect(device.masters.some((m) => m.label === 'bench-family')).toBe(false)
    console.log('cleanup complete; the signer is back on its original master set')
  }, 900_000)
})
