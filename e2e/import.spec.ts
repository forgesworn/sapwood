import { test, expect } from '@playwright/test'
import { encrypt as nip49Encrypt } from 'nostr-tools/nip49'
import { hexToBytes } from '@noble/hashes/utils.js'
import { disableWebSerial } from './helpers.js'

// The phone side of "connect your phone": opening the deep-linked QR URL loads
// the operator key and strips the secret from the address bar.
test('loads an operator key from a deep link and cleans the URL', async ({ page }) => {
  const opHex = '1'.repeat(64) // a valid 32-byte secp256k1 scalar

  await page.goto(`/#/import?op=${opHex}`)

  await expect(page.getByText(/Operator key loaded/i)).toBeVisible()
  // The secret must not linger in the URL.
  expect(page.url()).not.toContain(opHex)
  expect(page.url()).not.toContain('import')
  // Dismissible.
  await page.getByRole('button', { name: 'Dismiss' }).click()
  await expect(page.getByText(/Operator key loaded/i)).toHaveCount(0)
})

test('protected phone handoff shows a dedicated remote connection state', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await disableWebSerial(page)
  const opHex = '2'.repeat(64)
  const deviceHex = 'f'.repeat(64)
  const pin = 'river-otter-27'
  const eop = nip49Encrypt(hexToBytes(opHex), pin)
  const params = new URLSearchParams({
    eop,
    dev: deviceHex,
    relays: 'wss://relay.invalid',
  })

  await page.goto(`/#/import?${params.toString()}`)
  await page.getByPlaceholder('PIN or passphrase').fill(pin)
  await page.getByRole('button', { name: 'Unlock' }).click()

  const state = page.getByTestId('handoff-connect-state')
  await expect(state).toBeVisible()
  await expect(state).toContainText(/over the internet/i)
  await expect(state).toContainText(/mobile data/i)
  await expect(page.getByText(/USB setup|USB management/)).toHaveCount(0)
  await expect(page.getByText('Other ways to connect')).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Connect to local bridge' })).toHaveCount(0)
})
