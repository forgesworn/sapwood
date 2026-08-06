import { test, expect } from '@playwright/test'
import { enableAdminTestSeam } from './helpers.js'

// A master plus a derived persona: the persona carries its OWNING master's slot,
// so both rows report slot 0. Keying an each block by slot threw
// `each_key_duplicate`, which unmounted the entire Identity panel: a blank page
// under Advanced > Identity for any signer with a derived identity.
const MASTERS = [
  { slot: 0, label: 'master', mode: -1, modeLabel: 'WIFI', npub: 'a'.repeat(64), addressed: true },
  { slot: 0, label: 'work', npub: 'b'.repeat(64), persona: true },
]

// The same nsec provisioned into two slots: distinct rows, identical npub.
const SAME_KEY_TWICE = [
  { slot: 0, label: 'first', mode: 0, npub: 'a'.repeat(64) },
  { slot: 1, label: 'second', mode: 0, npub: 'a'.repeat(64) },
]

async function openIdentity(page: import('@playwright/test').Page, masters: unknown[]) {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))

  await enableAdminTestSeam(page)
  // A signer reached over WiFi has remembered relays, so the NIP-05 card renders
  // its identity selector instead of the "no known relays" note.
  await page.addInitScript(() => {
    localStorage.setItem('heartwood.lastRelays', JSON.stringify(['wss://relay.example']))
  })
  await page.goto('/#/')
  await page.evaluate((ms) => (window as unknown as { __sapwoodConnect: (o: unknown) => void }).__sapwoodConnect({
    masters: ms,
    slots: [],
    mode: 'relay',
    operatorPub: 'c'.repeat(64),
    relays: ['wss://relay.example'],
    relayStatus: {
      master_count: 1, slots: 0, mode: 'wifi-standalone',
      relay: 'wss://relay.example', capabilities: [],
    },
  }), masters)

  await page.getByRole('button', { name: 'Advanced ⚙', exact: true }).click()
  await page.getByRole('button', { name: 'Identity', exact: true }).click()
  return errors
}

test('renders the Identity panel for a signer holding a derived identity', async ({ page }) => {
  const errors = await openIdentity(page, MASTERS)

  await expect(page.getByRole('heading', { name: 'Identities on this signer' })).toBeVisible()
  await expect(page.getByText('SLOT 0', { exact: true })).toBeVisible()
  await expect(page.getByText('FROM SLOT 0', { exact: true })).toBeVisible()

  // The NIP-05 card is the one that iterated the full list, personas included.
  await page.getByText('Short address (NIP-05)').click()
  const picker = page.locator('.nip05-body select')
  await expect(picker.getByRole('option')).toHaveText(['master', 'work'])

  expect(errors).toEqual([])
})

test('renders the Identity panel when one key fills two slots', async ({ page }) => {
  const errors = await openIdentity(page, SAME_KEY_TWICE)

  await expect(page.getByText('SLOT 0', { exact: true })).toBeVisible()
  await expect(page.getByText('SLOT 1', { exact: true })).toBeVisible()
  expect(errors).toEqual([])
})
