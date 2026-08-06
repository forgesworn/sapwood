// Captures the screenshots and screen recordings used by the support pages at
// public/about/guide/ and public/about/cli/. Drives the built app (vite
// preview on :4173) in headless Chromium through the e2e seams
// (__sapwoodE2E/__sapwoodConnect, __sapwoodFlashBackend) — no hardware, real
// UI, demo-only data. Output lands in .guide-shots/ (gitignored); the curated
// set is copied into public/about/guide/img/ by hand.
//
//   npm run build && npm run preview -- --port 4173 --strictPort &
//   node scripts/capture-guide-assets.mjs
import { chromium } from '@playwright/test'
import { nip19, getPublicKey, generateSecretKey } from 'nostr-tools'
import { mnemonicToSeedSync } from '@scure/bip39'
import { HDKey } from '@scure/bip32'
import { schnorr } from '@noble/curves/secp256k1.js'
import { bytesToHex } from '@noble/hashes/utils.js'
import { mkdirSync } from 'node:fs'

const OUT = new URL('../.guide-shots/', import.meta.url).pathname
mkdirSync(OUT, { recursive: true })
const BASE = 'http://localhost:4173'

// --- demo data (throwaway keys, safe to publish) ---------------------------

// A fixed demo operator phrase (BIP-39 test vector, publicly known — never a
// real credential). Seeded into localStorage so the operator panels render a
// phrase-backed key and the phone handoff can prove its operator.
const OPERATOR_MNEMONIC = 'legal winner thank year wave sausage worth useful legal winner thank yellow'
const opSeed = mnemonicToSeedSync(OPERATOR_MNEMONIC)
const opChild = HDKey.fromMasterSeed(opSeed).derive("m/44'/1237'/0'/0/0")
const OPERATOR_PUB = bytesToHex(schnorr.getPublicKey(opChild.privateKey))

const idA = getPublicKey(generateSecretKey())
const idB = getPublicKey(generateSecretKey())
const idC = getPublicKey(generateSecretKey())
const appPub = () => getPublicKey(generateSecretKey())

const MASTERS = [
  { slot: 0, label: 'daybreak', mode: 0, npub: nip19.npubEncode(idA), apps: 3 },
  { slot: 1, label: 'workshop', mode: 0, npub: nip19.npubEncode(idB), apps: 1 },
  // A named identity the signer derived from 'daybreak' itself. A persona
  // carries its OWNING master's slot, so this row repeats slot 0 — the shape
  // most real signers have, and the one that must render correctly. Capturing
  // it keeps the guide honest and keeps this pipeline exercising it.
  { slot: 0, label: 'social', npub: nip19.npubEncode(idC), persona: true },
]

const ALL_METHODS = ['sign_event', 'nip44_encrypt', 'nip44_decrypt', 'nip04_encrypt', 'nip04_decrypt', 'get_public_key']

const SLOTS = [
  {
    slot_index: 0, label: 'gossip', secret: '', current_pubkey: appPub(),
    allowed_methods: ALL_METHODS, allowed_kinds: [],
    auto_approve: true, signing_approved: true,
  },
  {
    slot_index: 1, label: 'coracle', secret: '', current_pubkey: appPub(),
    allowed_methods: ['sign_event', 'nip44_encrypt', 'nip44_decrypt', 'get_public_key'],
    allowed_kinds: [0, 1, 3, 6, 7, 10002],
    auto_approve: true, signing_approved: true, strict_permissions: true,
  },
  {
    slot_index: 2, label: 'amethyst', secret: '', current_pubkey: null,
    allowed_methods: ['sign_event', 'get_public_key'], allowed_kinds: [1, 7],
    auto_approve: false, signing_approved: false, strict_permissions: true,
  },
]

const RELAYS = ['wss://relay.trotters.cc', 'wss://nos.lol', 'wss://relay.damus.io', 'wss://relay.primal.net']

const USB_NET_STATE = {
  version: 1, configured: true, revision: 3, mode: 'wifi', ssid: 'HOMENET',
  relays: RELAYS, password_set: true, op_mgmt: OPERATOR_PUB, recovery_ok: true,
  trial: null,
}

const LOG_LINES = [
  'I (184201) heartwood: wifi up: HOMENET, ip 192.168.1.44',
  'I (184390) heartwood: relay: connected wss://relay.trotters.cc',
  'I (198122) heartwood: relay: request from 9f21a3c1 (gossip)',
  'sign_event signed: short text note (1) for gossip - gm from the workshop',
  'I (204577) heartwood: relay: request from b04e77d2 (coracle)',
  'sign_event signed: reaction (7) for coracle',
  'sign_event denied: contact list (3) for amethyst',
  'I (231008) heartwood: policy: kind 3 not allowed for slot 2',
]

// --- helpers ---------------------------------------------------------------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function newPage(browser, { video = false } = {}) {
  const ctx = await browser.newContext({
    viewport: { width: 1280, height: 860 },
    deviceScaleFactor: video ? 1 : 2,
    colorScheme: 'dark',
    ...(video ? { recordVideo: { dir: OUT + 'video/', size: { width: 1280, height: 860 } } } : {}),
  })
  const page = await ctx.newPage()
  await page.addInitScript(([mnemonic, holdErrorsDown]) => {
    window.__sapwoodE2E = true
    localStorage.setItem('heartwood.opMgmt.mnemonic', mnemonic)
    // Panel mounts probe the absent transport and raise the error banner. A
    // still just calls clearError() before the shot; a recording cannot pick
    // its moment, and a probe landing mid-take put "Not connected" under the
    // status bar for a second or two. Hold the clear down for the whole run.
    if (holdErrorsDown) setInterval(() => window.__sapwoodClearError?.(), 100)
  }, [OPERATOR_MNEMONIC, video])
  return { ctx, page }
}

/** Connect the fake signer over "USB" and let probe errors settle, then clear them. */
async function connectUsb(page, { masters = MASTERS, slots = SLOTS, logs = LOG_LINES } = {}) {
  const opts = {
    masters, slots, mode: 'serial', portInfo: 'usbmodem3301',
    operatorPub: OPERATOR_PUB,
    usbNetworkSupport: 'supported', usbNetworkState: USB_NET_STATE,
    logs,
  }
  await page.evaluate((o) => window.__sapwoodConnect(o), opts)
  // Mount-time probes fail against the absent transport and set device.error;
  // re-applying the seam after they settle clears the banner.
  await sleep(900)
  await page.evaluate((o) => window.__sapwoodConnect({ ...o, logs: [] }), opts)
  await sleep(300)
}

/** Panel mounts probe the absent transport and set device.error; dismiss it
 *  just before capturing so the banner never appears in the assets. */
async function clearError(page) {
  await page.evaluate(() => window.__sapwoodClearError?.())
  await sleep(150)
}

async function shot(page, name, locator = null) {
  await clearError(page)
  if (locator) await locator.screenshot({ path: `${OUT}${name}.png` })
  else await page.screenshot({ path: `${OUT}${name}.png` })
  console.log('shot', name)
}

async function fullShot(page, name) {
  await clearError(page)
  await page.screenshot({ path: `${OUT}${name}.png`, fullPage: true })
  console.log('shot', name, '(full)')
}

async function type(page, locator, text) {
  await locator.click()
  await locator.pressSequentially(text, { delay: 45 })
}

const flashBackend = () => {
  window.__sapwoodFlashBackend = {
    hasWebSerial: () => true,
    requestPort: async () => ({}),
    fetchBin: async (url) => {
      const res = await fetch(url, { cache: 'no-store' })
      if (!res.ok) throw new Error(`fetch ${url} failed: ${res.status}`)
      return new Uint8Array(await res.arrayBuffer())
    },
    fetchManifest: async () => {
      const res = await fetch('/firmware/version.json', { cache: 'no-store' })
      if (!res.ok) throw new Error('fetch manifest failed')
      return res.json()
    },
    openSession: async () => ({
      detectChip: async () => 'ESP32-S3',
      eraseFlash: async () => {},
      writeFlash: async (regions, report) => {
        for (let i = 0; i < regions.length; i++) {
          for (let pct = 0; pct <= 100; pct += 5) {
            report(i, pct, 100)
            await new Promise((r) => setTimeout(r, 60))
          }
        }
      },
      hardReset: async () => {},
      close: async () => {},
    }),
  }
  Object.defineProperty(navigator, 'serial', { value: {}, configurable: true })
}

// --- scenes ----------------------------------------------------------------

const browser = await chromium.launch()

// Scene 1: landing + connected Home + advanced console stills.
{
  const { ctx, page } = await newPage(browser)
  await page.goto(`${BASE}/#/`)
  await sleep(600)
  await shot(page, 'landing')

  await connectUsb(page)
  await fullShot(page, 'home')
  await shot(page, 'home-signer-card', page.locator('.card', { hasText: 'YOUR SIGNER IS LIVE' }).first())
  await shot(page, 'home-backup-nudge', page.locator('.card', { hasText: 'Back up your operator key' }).first())

  // Connected app card with the Signing permissions expanded.
  const coracle = page.locator('.card', { hasText: 'coracle' }).first()
  await coracle.getByText('SIGNING', { exact: false }).first().click()
  await sleep(400)
  await shot(page, 'home-app-permissions', coracle)

  // Phone handoff, armed: pair -> PIN -> QR.
  const handoff = page.locator('section', { hasText: 'Manage from your phone' }).first()
  await handoff.scrollIntoViewIfNeeded()
  await shot(page, 'handoff-ready', handoff)
  await handoff.getByRole('button', { name: 'Pair a device' }).click()
  await sleep(300)
  await shot(page, 'handoff-pin', handoff)
  await type(page, handoff.locator('input'), 'toadstool-lantern')
  await handoff.getByRole('button', { name: 'Protect and show QR' }).click()
  await page.waitForTimeout(2500)
  await shot(page, 'handoff-qr', handoff)

  // Connect-an-app flow stills.
  await page.getByRole('button', { name: /Connect an app/ }).click()
  await sleep(300)
  const flow = page.locator('section.flow').first()
  await shot(page, 'connect-name', flow)
  await type(page, flow.locator('input[type="text"]').first(), 'Damus on my phone')
  await flow.getByRole('button', { name: 'Continue' }).click()
  await sleep(300)
  const perms = page.locator('section.flow').first()
  await shot(page, 'connect-permissions', perms)

  // Advanced console stills.
  await page.getByRole('button', { name: 'Advanced ⚙', exact: true }).click()
  await sleep(400)
  await fullShot(page, 'advanced-apps')
  await page.getByRole('button', { name: 'Identity', exact: true }).click()
  await sleep(600)
  await fullShot(page, 'advanced-identity')
  await shot(page, 'operator-key', page.locator('section, .card').filter({ hasText: 'Operator key' }).last())
  await page.getByRole('button', { name: 'Device', exact: true }).click()
  await sleep(600)
  await fullShot(page, 'advanced-device')
  await shot(page, 'danger-zone', page.locator('.card, section').filter({ hasText: 'Danger zone' }).last())
  await page.getByRole('button', { name: 'Logs', exact: true }).click()
  await sleep(400)
  await fullShot(page, 'advanced-logs')
  await ctx.close()
}

// Scene 2: first-identity flow (USB, no identities yet).
{
  const { ctx, page } = await newPage(browser)
  await page.goto(`${BASE}/#/`)
  await sleep(400)
  await connectUsb(page, { masters: [], slots: [], logs: [] })
  await sleep(400)
  await fullShot(page, 'first-identity')
  await page.getByText('Restore a key I already have', { exact: false }).click()
  await sleep(300)
  await fullShot(page, 'restore-sources')
  await ctx.close()
}

// Scene 3: flasher wizard stills.
{
  const { ctx, page } = await newPage(browser)
  await page.addInitScript(flashBackend)
  await page.goto(`${BASE}/#/flash`)
  await sleep(600)
  await shot(page, 'flash-welcome')
  await page.getByRole('button', { name: 'Start' }).click()
  await sleep(300)
  await shot(page, 'flash-board')
  await page.getByText('Heltec WiFi LoRa 32 V4', { exact: false }).first().click()
  await page.getByRole('button', { name: 'Next' }).click()
  await sleep(300)
  const ssid = page.getByLabel(/Wi-Fi name/i).or(page.locator('input').first())
  await type(page, ssid.first(), 'HOMENET')
  const pw = page.getByLabel(/Wi-Fi password/i).or(page.locator('input[type="password"]').first())
  await pw.first().fill('correct-horse-battery')
  await shot(page, 'flash-network')
  await page.getByRole('button', { name: 'Next' }).click()
  await sleep(300)
  await shot(page, 'flash-review')
  await page.getByRole('button', { name: /Flash/ }).click()
  await sleep(1500)
  await shot(page, 'flash-progress')
  await page.waitForSelector('text=Your signer is flashed', { timeout: 30000 })
  await sleep(300)
  await fullShot(page, 'flash-done')
  await ctx.close()
}

// Scene 4: recordings for the animated figures.
async function record(name, fn) {
  const { ctx, page } = await newPage(browser, { video: true })
  await fn(page)
  const video = page.video()
  await ctx.close()
  const path = await video.path()
  console.log('video', name, path)
  return { name, path }
}

const videos = []

videos.push(await record('connect-app', async (page) => {
  await page.goto(`${BASE}/#/`)
  await sleep(400)
  await connectUsb(page)
  await clearError(page)
  await sleep(700)
  await page.getByRole('button', { name: /Connect an app/ }).click()
  await sleep(900)
  const flow = page.locator('section.flow').first()
  await type(page, flow.locator('input[type="text"]').first(), 'Damus on my phone')
  await sleep(700)
  await flow.getByRole('button', { name: 'Continue' }).click()
  await sleep(1200)
  const perms = page.locator('section.flow').first()
  await perms.getByText('Posting only', { exact: false }).click()
  await sleep(1400)
}))

videos.push(await record('advanced-tour', async (page) => {
  await page.goto(`${BASE}/#/`)
  await sleep(400)
  await connectUsb(page)
  await sleep(600)
  await page.getByRole('button', { name: 'Advanced ⚙', exact: true }).click()
  await sleep(400)
  await clearError(page)
  await sleep(1100)
  for (const section of ['Identity', 'Device', 'Logs', 'Apps']) {
    await page.getByRole('button', { name: section, exact: true }).click()
    await sleep(500)
    await clearError(page)
    await sleep(1100)
  }
}))

videos.push(await record('handoff', async (page) => {
  await page.goto(`${BASE}/#/`)
  await sleep(400)
  await connectUsb(page)
  await sleep(600)
  const handoff = page.locator('section', { hasText: 'Manage from your phone' }).first()
  await clearError(page)
  await handoff.scrollIntoViewIfNeeded()
  await sleep(800)
  await handoff.getByRole('button', { name: 'Pair a device' }).click()
  await sleep(900)
  await type(page, handoff.locator('input'), 'toadstool-lantern')
  await sleep(500)
  await handoff.getByRole('button', { name: 'Protect and show QR' }).click()
  await page.waitForTimeout(3000)
}))

videos.push(await record('flash-flow', async (page) => {
  await page.addInitScript(flashBackend)
  await page.goto(`${BASE}/#/flash`)
  await sleep(900)
  await page.getByRole('button', { name: 'Start' }).click()
  await sleep(1100)
  await page.getByText('Heltec WiFi LoRa 32 V4', { exact: false }).first().click()
  await sleep(700)
  await page.getByRole('button', { name: 'Next' }).click()
  await sleep(900)
  const ssid = page.getByLabel(/Wi-Fi name/i).or(page.locator('input').first())
  await type(page, ssid.first(), 'HOMENET')
  const pw = page.getByLabel(/Wi-Fi password/i).or(page.locator('input[type="password"]').first())
  await pw.first().fill('correct-horse-battery')
  await sleep(600)
  await page.getByRole('button', { name: 'Next' }).click()
  await sleep(1000)
  await page.getByRole('button', { name: /Flash/ }).click()
  await page.waitForSelector('text=Your signer is flashed', { timeout: 30000 })
  await sleep(1500)
}))

console.log(JSON.stringify(videos.map((v) => v.name), null, 2))
await browser.close()
console.log('done ->', OUT)
