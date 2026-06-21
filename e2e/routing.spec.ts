import { test, expect } from '@playwright/test'

test('navigates between the admin console and the flasher', async ({ page }) => {
  await page.goto('/#/')
  await expect(page.getByText('SHAPE YOUR SIGNER')).toBeVisible()

  // Two entry points carry this label (header link + the disconnected CTA).
  await page.getByRole('button', { name: /Set up a new device/ }).first().click()
  await expect(page).toHaveURL(/#\/flash/)
  await expect(page.getByRole('heading', { name: 'Set up your Heartwood' })).toBeVisible()

  await page.getByRole('button', { name: /Advanced console/ }).click()
  await expect(page).toHaveURL(/#\/?$/)
  await expect(page.getByText('SHAPE YOUR SIGNER')).toBeVisible()
})
