import { test, expect } from '@playwright/test'

// The headline privacy guarantee: Sapwood must phone no one home. Loading either
// surface may only touch our own origin — no fonts.googleapis.com, no CDN, no
// analytics. This test fails the build if a third-party request is reintroduced.
const LOCAL = new Set(['localhost', '127.0.0.1'])

test('makes no third-party requests on load (no IP leak)', async ({ page }) => {
  const external: string[] = []
  page.on('request', (req) => {
    let host = ''
    try { host = new URL(req.url()).hostname } catch { return }
    if (host && !LOCAL.has(host)) external.push(req.url())
  })

  await page.goto('/#/')
  await page.waitForLoadState('load')
  await page.waitForTimeout(600)
  await page.goto('/#/flash')
  await page.waitForLoadState('load')
  await page.waitForTimeout(600)

  expect(external, `unexpected third-party requests:\n${external.join('\n')}`).toEqual([])
})

test('ships a Content-Security-Policy that locks resources to our origin', async ({ page }) => {
  await page.goto('/#/')
  const csp = await page
    .locator('meta[http-equiv="Content-Security-Policy"]')
    .getAttribute('content')
  expect(csp).toContain("default-src 'self'")
  expect(csp).toContain("font-src 'self'")
  expect(csp).toContain("object-src 'none'")
})
