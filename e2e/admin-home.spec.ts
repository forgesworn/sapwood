import { test, expect } from '@playwright/test'
import { enableAdminTestSeam } from './helpers.js'

// A wifi master (the npub field accepts hex; the UI abbreviates it for display).
const MASTER = { slot: 0, label: 'master', mode: -1, modeLabel: 'WIFI', npub: 'a'.repeat(64) }

async function fakeConnect(page: import('@playwright/test').Page, slots: unknown[] = []) {
  await page.evaluate(
    ({ m, s }) => (window as unknown as { __sapwoodConnect: (o: unknown) => void }).__sapwoodConnect({ masters: [m], slots: s }),
    { m: MASTER, s: slots },
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

  // Advanced reveals the full cockpit; Home is hidden.
  await advancedToggle(page).click()
  await expect(page.getByRole('button', { name: 'Masters' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Clients' })).toBeVisible()
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

test.describe('mobile', () => {
  test.use({ viewport: { width: 390, height: 844 } })

  test('no horizontal overflow on the connected Home or cockpit at 390px', async ({ page }) => {
    await enableAdminTestSeam(page)
    await page.goto('/#/')
    await fakeConnect(page, [
      { slot_index: 1, label: 'Damus on my phone', current_pubkey: 'd'.repeat(64), signing_approved: true, allowed_kinds: [], auto_approve: false },
    ])
    await expect(page.getByText('Your signer is live')).toBeVisible()

    const homeOverflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    )
    expect(homeOverflow).toBeLessThanOrEqual(1)

    await advancedToggle(page).click()
    await expect(page.getByRole('button', { name: 'Masters' })).toBeVisible()
    const cockpitOverflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    )
    expect(cockpitOverflow).toBeLessThanOrEqual(1)
  })
})
