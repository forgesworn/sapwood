import { test, expect } from '@playwright/test'
import { nip19 } from 'nostr-tools'
import { enableAdminTestSeam } from './helpers.js'

test('wrapped recovery selects real slots, requires file checking and fits a narrow screen', async ({ page }) => {
  await enableAdminTestSeam(page)
  await page.goto('/#/')
  const root = nip19.npubEncode('11'.repeat(32))
  const target = nip19.npubEncode('22'.repeat(32))
  await page.evaluate(({ root, target }) => {
    (window as unknown as { __sapwoodConnect: (o: unknown) => void }).__sapwoodConnect({ mode: 'serial', masters: [
      { slot: 0, label: 'recovery root', mode: 1, npub: root },
      { slot: 1, label: 'imported account', mode: 0, npub: target },
      { slot: 0, label: 'persona', persona: true, npub: 'a'.repeat(64) },
    ], slots: [] })
  }, { root, target })
  await page.getByRole('button', { name: 'Advanced ⚙', exact: true }).click()
  await page.getByRole('button', { name: 'Identity', exact: true }).click()
  await page.getByText('Back up or restore an existing raw account', { exact: true }).click()
  const panel = page.locator('.wrapped-account')
  await panel.getByLabel('Recovery root', { exact: true }).selectOption('0')
  await expect(panel.getByLabel('Recovery root').getByRole('option')).toHaveCount(3)
  await panel.getByLabel('Raw account to back up').selectOption('1')
  await expect(panel.getByRole('button', { name: 'Download encrypted account file' })).toBeEnabled()
  await panel.getByLabel('Saved encrypted file').setInputFiles({ name: 'oversize.nstw', mimeType: 'text/plain', buffer: Buffer.from('x'.repeat(182)) })
  await expect(panel.getByRole('alert')).toContainText('181-byte')
  await expect(panel.getByRole('button', { name: /Restore into empty slot/ })).toBeDisabled()
  await page.setViewportSize({ width: 390, height: 844 })
  await panel.scrollIntoViewIfNeeded()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  await page.screenshot({ path: 'e2e/results/wrapped-account-mobile.png', fullPage: true })
})
