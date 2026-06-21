import { test, expect } from '@playwright/test'

// Regression net for the mobile-first work: neither surface may overflow
// horizontally on a phone-sized viewport.
test.use({ viewport: { width: 390, height: 844 } })

for (const path of ['/#/', '/#/flash']) {
  test(`no horizontal overflow at 390px on ${path}`, async ({ page }) => {
    await page.goto(path)
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    )
    expect(overflow).toBeLessThanOrEqual(1) // allow sub-pixel rounding
  })
}
