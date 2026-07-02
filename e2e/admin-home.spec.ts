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

  // Create a fresh identity → the naming step, from which the DEVICE (not the
  // browser) generates the seed and shows the phrase on its own screen. We can't
  // drive a real device in E2E, so we assert the surface up to the on-device step.
  await page.getByRole('button', { name: /Create a fresh identity/ }).click()
  await expect(page.getByRole('heading', { name: 'Name your signer' })).toBeVisible()
  await expect(page.getByRole('button', { name: /Create it on my device/ })).toBeVisible()
})

test('the disconnected console offers plain-language connect options', async ({ page }) => {
  await page.goto('/#/')
  await expect(page.getByRole('button', { name: 'Connect by USB cable' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Connect over your network' })).toBeVisible()
  // The bridge (advanced) option is tucked behind a disclosure, not flat in the list.
  await expect(page.getByText('Other ways to connect')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Connect to a bridge' })).toBeHidden()
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
    await expect(page.getByRole('button', { name: 'Identity', exact: true })).toBeVisible()
    const cockpitOverflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    )
    expect(cockpitOverflow).toBeLessThanOrEqual(1)
  })
})
