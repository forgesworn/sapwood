import { test, expect } from '@playwright/test'

// Regression for the SPA-fallback false-connect: vite preview (like the live
// static host) answers /api/* with index.html (HTTP 200). The admin must NOT
// mistake that for a bridge, auto-connect, and choke parsing HTML as JSON.
test('does not auto-connect to a bridge on a static host', async ({ page }) => {
  await page.goto('/#/')
  await page.waitForTimeout(800)
  await expect(page.getByText('DISCONNECTED')).toBeVisible()
  await expect(page.getByText(/is not valid JSON/)).toHaveCount(0)
  await expect(page.getByText('CONNECTED', { exact: true })).toHaveCount(0)
})
