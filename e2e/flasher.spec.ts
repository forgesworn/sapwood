import { test, expect } from '@playwright/test'
import { installFakeFlasher, disableWebSerial } from './helpers'

test('walks the whole wizard and flashes end-to-end', async ({ page }) => {
  await installFakeFlasher(page)
  await page.goto('/#/flash')

  await expect(page.getByRole('heading', { name: 'Set up your Heartwood' })).toBeVisible()
  await page.getByRole('button', { name: 'Start' }).click()

  await expect(page.getByRole('heading', { name: 'Which device do you have?' })).toBeVisible()
  await page.getByRole('button', { name: /Heltec WiFi LoRa 32 V4/ }).click()
  await page.getByRole('button', { name: 'Next' }).click()

  await expect(page.getByRole('heading', { name: 'How will it connect?' })).toBeVisible()
  const inputs = page.locator('.field input')
  await inputs.nth(0).fill('home-wifi')
  await inputs.nth(1).fill('hunter2hunter2')
  await page.getByRole('button', { name: 'Next' }).click()

  await expect(page.getByRole('heading', { name: 'Ready to flash' })).toBeVisible()
  await page.getByRole('button', { name: 'Flash', exact: true }).click()

  await expect(page.getByRole('heading', { name: 'Your signer is flashed' })).toBeVisible()
  // The 12-word recovery phrase is the prominent thing to write down…
  await expect(page.getByText('Write down these 12 words')).toBeVisible()
  // …and the technical secret is tucked behind Advanced, not in a newcomer's face.
  const secret = page.getByText(/NOSTR_SECRET_KEY=[0-9a-f]{64}/)
  await expect(secret).toBeHidden()
  await page.getByText('Advanced — connect bray to this signer').click()
  await expect(secret).toBeVisible()

  // Handoff: continuing leads straight into "finish your new signer", never the
  // generic picker that tells a just-flashed user to "Set up a new device".
  await page.getByRole('button', { name: 'Continue setup →' }).click()
  await expect(page.getByRole('button', { name: /Connect to my new signer/ })).toBeVisible()
})

test('blocks Next until the wifi name is entered', async ({ page }) => {
  await installFakeFlasher(page)
  await page.goto('/#/flash')
  await page.getByRole('button', { name: 'Start' }).click()
  await page.getByRole('button', { name: /Heltec WiFi LoRa 32 V4/ }).click()
  await page.getByRole('button', { name: 'Next' }).click()

  await expect(page.getByRole('button', { name: 'Next' })).toBeDisabled()
  await page.locator('.field input').nth(0).fill('home-wifi')
  await expect(page.getByRole('button', { name: 'Next' })).toBeEnabled()
})

test('explains the requirement when Web Serial is unavailable', async ({ page }) => {
  await disableWebSerial(page)
  await page.goto('/#/flash')
  await expect(page.getByText(/needs a computer running Chrome or Edge/i)).toBeVisible()
  await expect(page.getByRole('button', { name: 'Start' })).toBeDisabled()
})
