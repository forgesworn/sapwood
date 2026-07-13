import { test, expect } from '@playwright/test'
import { getPublicKey } from 'nostr-tools'
import { hexToBytes } from '@noble/hashes/utils.js'
import { disableWebSerial, enableAdminTestSeam } from './helpers.js'

// A wifi master (the npub field accepts hex; the UI abbreviates it for display).
const MASTER = { slot: 0, label: 'master', mode: -1, modeLabel: 'WIFI', npub: 'a'.repeat(64) }

async function fakeConnect(
  page: import('@playwright/test').Page,
  slots: unknown[] = [],
  mode: 'relay' | 'serial' = 'relay',
  operatorPub = '',
) {
  await page.evaluate(
    ({ m, s, transport, operator }) => (window as unknown as { __sapwoodConnect: (o: unknown) => void }).__sapwoodConnect({
      masters: [m],
      slots: s,
      mode: transport,
      operatorPub: operator,
      relays: transport === 'relay' ? ['wss://relay.trotters.cc'] : [],
      // Relay-mode UI is only fully connected after an authenticated get_status
      // reply. Tests that model a relay-only timeout call the seam directly and
      // deliberately omit this proof.
      relayStatus: transport === 'relay'
        ? { master_count: 1, slots: s.length, mode: 'wifi-standalone', relay: 'wss://relay.trotters.cc', capabilities: [] }
        : null,
    }),
    { m: MASTER, s: slots, transport: mode, operator: operatorPub },
  )
}

const heroButton = (page: import('@playwright/test').Page) =>
  page.getByRole('button', { name: /Connect an app/ })
const advancedToggle = (page: import('@playwright/test').Page) =>
  page.getByRole('button', { name: 'Advanced ⚙', exact: true })
const homeToggle = (page: import('@playwright/test').Page) =>
  page.getByRole('button', { name: '← Home', exact: true })

test('lands on the guided Home and reveals the Advanced cockpit', async ({ page }) => {
  await enableAdminTestSeam(page)
  await page.goto('/#/')
  await fakeConnect(page)

  // Guided Home is the default connected surface.
  await expect(page.getByText('Your signer is live')).toBeVisible()
  await expect(heroButton(page)).toBeVisible()

  // Advanced reveals the full console; Home is hidden.
  await advancedToggle(page).click()
  await expect(page.getByRole('button', { name: 'Apps', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Identity', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Device', exact: true })).toBeVisible()
  await expect(heroButton(page)).toBeHidden()

  // Back to Home.
  await homeToggle(page).click()
  await expect(heroButton(page)).toBeVisible()
})

test('connect-an-app flow opens and gates on a name', async ({ page }) => {
  await enableAdminTestSeam(page)
  await page.goto('/#/')
  await fakeConnect(page)

  await heroButton(page).click()
  await expect(page.getByText('What are you connecting?')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Continue' })).toBeDisabled()
  await page.getByPlaceholder('e.g. Damus on my phone').fill('Damus on my phone')
  await expect(page.getByRole('button', { name: 'Continue' })).toBeEnabled()
  await page.getByRole('button', { name: 'Continue' }).click()
  await expect(page.getByRole('button', { name: /Everything/ })).toBeVisible()
  await expect(page.getByRole('button', { name: /Messages only/ })).toBeVisible()
})

test('phone handoff QR is hidden until explicitly revealed', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await enableAdminTestSeam(page)
  await page.goto('/#/')
  const operatorSk = '1'.repeat(64)
  const operatorPub = getPublicKey(hexToBytes(operatorSk))
  await page.evaluate(({ secret }) => {
    localStorage.setItem('heartwood.lastRelays', JSON.stringify(['wss://relay.trotters.cc']))
    localStorage.setItem('heartwood.opMgmt.skHex', secret)
  }, { secret: operatorSk })
  await fakeConnect(page, [], 'relay', operatorPub)

  await expect(page.getByText('Manage from your phone')).toBeVisible()
  await expect(page.locator('.handoff .qr')).toHaveCount(0)
  await expect(page.getByText(/This link carries your operator key/)).toHaveCount(0)

  // Pairing leads with a PIN step — no QR (and no bare-secret warning) yet.
  await page.getByRole('button', { name: 'Pair a device' }).click()
  await expect(page.getByText(/PIN or passphrase/)).toBeVisible()
  await expect(page.locator('.handoff .qr')).toHaveCount(0)

  // A protected QR needs a PIN; the plain fallback shows the operator-key warning.
  await page.getByRole('button', { name: /Show without a PIN/ }).click()
  await expect(page.locator('.handoff .qr')).toBeVisible()
  await expect(page.getByText(/This link carries your operator key/)).toBeVisible()
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  )
  expect(overflow).toBeLessThanOrEqual(1)
})

test('a device with no identity yet leads with guided setup', async ({ page }) => {
  await enableAdminTestSeam(page)
  await page.goto('/#/')
  // Connected over USB but not provisioned — the just-flashed first-run state.
  await page.evaluate(() =>
    (window as unknown as { __sapwoodConnect: (o: unknown) => void }).__sapwoodConnect({ masters: [], slots: [], mode: 'serial' }),
  )

  await expect(page.getByText("Let's give your signer its identity")).toBeVisible()
  // The connect-an-app hero is hidden until there is an identity to connect to.
  await expect(heroButton(page)).toBeHidden()

  // Create a fresh key → the naming step, from which the DEVICE (not the
  // browser) generates the seed and shows the phrase on its own screen. We can't
  // drive a real device in E2E, so we assert the surface up to the on-device step.
  await page.getByRole('button', { name: /Create a fresh key/ }).click()
  await expect(page.getByRole('heading', { name: 'Name your signer' })).toBeVisible()
  await expect(page.getByRole('button', { name: /Create it on my device/ })).toBeVisible()
})

test('a device with no identity yet can restore an existing key on Home', async ({ page }) => {
  await enableAdminTestSeam(page)
  await page.goto('/#/')
  await page.evaluate(() =>
    (window as unknown as { __sapwoodConnect: (o: unknown) => void }).__sapwoodConnect({ masters: [], slots: [], mode: 'serial' }),
  )

  // Restore stays on the guided rail: a source picker, no drop into Advanced.
  await page.getByRole('button', { name: /Restore a key I already have/ }).click()
  await expect(page.getByRole('heading', { name: /Restore a key you already have/ })).toBeVisible()
  // The nsec door leads to the paste step with the derive-target choice.
  await page.getByText(/An nsec/).click()
  await expect(page.getByPlaceholder('nsec1...')).toBeVisible()
  await expect(page.getByText(/Keep this key's address/)).toBeVisible()
})

test('relay timeout gives an operator-key recovery path', async ({ page }) => {
  await enableAdminTestSeam(page)
  await page.goto('/#/')
  await page.evaluate(() =>
    (window as unknown as { __sapwoodConnect: (o: unknown) => void }).__sapwoodConnect({
      masters: [],
      slots: [],
      mode: 'relay',
      portInfo: 'npub1cc…cc · 4 relays',
      operatorPub: '1'.repeat(64),
      error: 'timeout waiting for device (get_status)',
    }),
  )

  await expect(page.getByRole('heading', { name: "Connected to the relay, but your signer isn't answering" })).toBeVisible()
  await expect(page.getByText('Most important check: operator key')).toBeVisible()
  await expect(page.getByText(/11111111…11111111/)).toBeVisible()

  await page.getByRole('button', { name: 'Restore operator key' }).click()
  await expect(page.getByRole('button', { name: 'Identity', exact: true })).toHaveClass(/active/)
  await expect(page.getByRole('heading', { name: 'Operator key' })).toBeVisible()
  await expect(page.getByPlaceholder(/matching 12\/24-word operator recovery phrase/)).toBeVisible()
})

test('the disconnected console offers plain-language connect options', async ({ page }) => {
  await page.goto('/#/')
  await expect(page.getByRole('button', { name: 'Connect by USB cable' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Connect by signer address' })).toBeVisible()
  // The bridge (advanced) option is tucked behind a disclosure, not flat in the list.
  await expect(page.getByText('Other ways to connect')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Connect to local bridge' })).toBeHidden()
})

test('without Web Serial, signer-address connect is the primary path', async ({ page }) => {
  await disableWebSerial(page)
  await page.goto('/#/')
  await expect(page.getByRole('button', { name: /Connect by signer address/ }).first()).toBeVisible()
  await expect(page.getByRole('button', { name: /Set up a new device/ })).toHaveCount(0)
  await expect(page.getByText(/USB setup and USB management need Chrome or Edge on a computer/)).toBeVisible()
})

test.describe('mobile', () => {
  test.use({ viewport: { width: 390, height: 844 } })

  test('shows a remote-only disconnected surface without USB or local-bridge noise', async ({ page }) => {
    await disableWebSerial(page)
    await page.goto('/#/')

    await expect(page.getByRole('button', { name: /Connect remotely/ })).toBeVisible()
    await expect(page.getByText(/Wi-Fi or cellular/)).toBeVisible()
    await expect(page.getByText(/USB setup|USB management/)).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Setup instructions' })).toHaveCount(0)
    await expect(page.getByText('Other ways to connect')).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Connect to local bridge' })).toHaveCount(0)
  })

  test('no horizontal overflow on the connected Home or cockpit at 390px', async ({ page }) => {
    await enableAdminTestSeam(page)
    await page.goto('/#/')
    await fakeConnect(page, [
      {
        slot_index: 1,
        label: 'Damus on my phone',
        current_pubkey: 'd'.repeat(64),
        authorized_pubkeys: ['d'.repeat(64)],
        signing_approved: true,
        strict_permissions: true,
        allowed_methods: ['get_public_key', 'sign_event'],
        allowed_kinds: [1],
        auto_approve: true,
      },
    ])
    await expect(page.getByText('Your signer is live')).toBeVisible()

    const homeOverflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    )
    expect(homeOverflow).toBeLessThanOrEqual(1)

    await advancedToggle(page).click()
    await expect(page.getByRole('button', { name: 'Identity', exact: true })).toBeVisible()
    await expect(page.getByRole('heading', { name: 'Apps', exact: true })).toBeVisible()
    await expect(page.getByText('Damus on my phone', { exact: true })).toBeVisible()
    await expect(page.getByText('CAN SIGN', { exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: 'AUTO', exact: true })).toBeVisible()
    await expect(page.getByText(/1 auto-signed, \d+ denied/)).toBeVisible()
    const cockpitOverflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    )
    expect(cockpitOverflow).toBeLessThanOrEqual(1)
  })

  test('Device keeps network controls and the unattended-PIN warning usable at 390px', async ({ page }) => {
    await enableAdminTestSeam(page)
    await page.goto('/#/')
    await fakeConnect(page, [], 'serial')
    await advancedToggle(page).click()
    await page.getByRole('button', { name: 'Device', exact: true }).click()

    await expect(page.getByRole('heading', { name: 'Network', exact: true })).toBeVisible()
    await expect(page.getByLabel('WiFi SSID')).toBeVisible()
    await expect(page.getByLabel('WiFi password')).toBeVisible()
    await expect(page.getByRole('button', { name: 'Save to device', exact: true })).toBeVisible()
    await expect(page.getByRole('heading', { name: 'Boot PIN', exact: true })).toBeVisible()
    const unattendedWarning = page.getByText(/For an unattended signer in another location, leave the boot PIN clear/)
    await expect(unattendedWarning).toBeVisible()
    await expect(unattendedWarning).toContainText('automatic signing and remote management cannot resume')

    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    )
    expect(overflow).toBeLessThanOrEqual(1)
  })

  test('a reloaded phone exposes the password-free A+B recovery route', async ({ page }) => {
    const pubHex = 'e'.repeat(64)
    await page.addInitScript(({ pub }) => {
      localStorage.setItem('heartwood.knownDevices', JSON.stringify([{
        pubHex: pub,
        relays: ['wss://old.example'],
        label: 'remote signer',
        lastSeen: '2026-07-12T00:00:00.000Z',
      }]))
      localStorage.setItem('heartwood.pendingNetworkHandoffs.v1', JSON.stringify({
        [pub]: {
          version: 1,
          devicePubHex: pub,
          transactionId: '01'.repeat(16),
          revision: 9,
          oldRelays: ['wss://old.example'],
          candidateRelays: ['wss://candidate.example'],
        },
      }))
    }, { pub: pubHex })
    await page.goto('/#/')
    await page.getByRole('button', { name: 'Connect another signer', exact: true }).click()

    await expect(page.getByLabel(/The relays it uses/)).toHaveValue('wss://candidate.example, wss://old.example')
    const journal = await page.evaluate(() => localStorage.getItem('heartwood.pendingNetworkHandoffs.v1') ?? '')
    expect(journal).not.toMatch(/password|ssid/i)
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    )
    expect(overflow).toBeLessThanOrEqual(1)
  })
})
