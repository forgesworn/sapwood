import { test, expect } from '@playwright/test'

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
