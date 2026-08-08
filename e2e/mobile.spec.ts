import { test, expect, type Page } from '@playwright/test'
import { enableAdminTestSeam } from './helpers.js'

// Regression net for the mobile-first work: no surface may overflow
// horizontally on a phone-sized viewport, and the primary touch controls
// must stay finger-sized. Runs in the chromium lane at a forced 390px and
// in the iPhone 13 WebKit lane (see playwright.config.ts).
test.use({ viewport: { width: 390, height: 844 } })

const MASTER = { slot: 0, label: 'daily', mode: -1, modeLabel: 'WIFI', npub: 'a'.repeat(64), apps: 2 }
const SLOTS = [
  {
    slot_index: 0, label: 'Damus on my phone', secret: '', current_pubkey: 'c'.repeat(64),
    allowed_methods: ['sign_event'], allowed_kinds: [1, 7], auto_approve: true, signing_approved: true,
  },
  {
    slot_index: 1, label: 'Coracle desktop with a much longer label than usual', secret: '',
    current_pubkey: null, allowed_methods: ['sign_event'], allowed_kinds: [1],
    auto_approve: false, signing_approved: false,
  },
]

async function overflow(page: Page): Promise<number> {
  return page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  )
}

async function fakeConnect(page: Page) {
  await page.waitForFunction(() => typeof (window as { __sapwoodConnect?: unknown }).__sapwoodConnect === 'function')
  await page.evaluate(
    ({ m, s }) => (window as unknown as { __sapwoodConnect: (o: unknown) => void }).__sapwoodConnect({
      masters: [m],
      slots: s,
      mode: 'relay',
      relays: ['wss://relay.trotters.cc'],
      relayStatus: { master_count: 1, slots: s.length, mode: 'wifi-standalone', relay: 'wss://relay.trotters.cc', capabilities: [] },
    }),
    { m: MASTER, s: SLOTS },
  )
}

for (const path of ['/#/', '/#/flash']) {
  test(`no horizontal overflow at 390px on ${path}`, async ({ page }) => {
    await page.goto(path)
    expect(await overflow(page)).toBeLessThanOrEqual(1) // allow sub-pixel rounding
  })
}

test('no horizontal overflow on the connected Home; app actions stay inside their card', async ({ page }) => {
  await enableAdminTestSeam(page)
  await page.goto('/#/')
  await fakeConnect(page)

  await expect(page.getByText('Connected apps')).toBeVisible()
  expect(await overflow(page)).toBeLessThanOrEqual(1)

  // The action row wraps rather than poking out of the card's left edge.
  const card = page.locator('.app-card').first()
  const cardBox = (await card.boundingBox())!
  const copy = card.getByRole('button', { name: 'Copy link' })
  const copyBox = (await copy.boundingBox())!
  expect(copyBox.x).toBeGreaterThanOrEqual(cardBox.x)
  expect(copyBox.x + copyBox.width).toBeLessThanOrEqual(cardBox.x + cardBox.width + 1)
})

test('no horizontal overflow on any cockpit tab; bottom nav is docked and finger-sized', async ({ page }) => {
  await enableAdminTestSeam(page)
  await page.goto('/#/')
  await fakeConnect(page)

  await page.getByRole('button', { name: 'Advanced ⚙', exact: true }).click()
  for (const tab of ['Apps', 'Identity', 'Device', 'Logs']) {
    await page.getByRole('button', { name: tab, exact: true }).click()
    // Panel mounts probe the absent transport; the error banner is part of the
    // layout under test, so leave it up and just measure.
    expect(await overflow(page), `overflow on ${tab}`).toBeLessThanOrEqual(1)
  }

  // The tab bar docks to the bottom of the viewport with 44px-class targets.
  const apps = page.getByRole('button', { name: 'Apps', exact: true })
  const box = (await apps.boundingBox())!
  expect(box.height).toBeGreaterThanOrEqual(40)
  const viewport = page.viewportSize()!
  expect(box.y + box.height).toBeGreaterThan(viewport.height - 80)
})
