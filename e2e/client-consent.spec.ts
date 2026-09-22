import { test, expect } from '@playwright/test'
import { enableAdminTestSeam } from './helpers.js'

test('shared pairing shows per-device consent and scoped withdrawal on a phone', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await enableAdminTestSeam(page)
  await page.goto('/#/')
  await page.evaluate(() => {
    const a = 'aa'.repeat(32), b = 'bb'.repeat(32), c = 'cc'.repeat(32)
    ;(window as unknown as { __sapwoodConnect: (o: unknown) => void }).__sapwoodConnect({
      mode: 'serial', masters: [{ slot: 0, label: 'Personal', mode: 1, npub: 'dd'.repeat(32) }],
      slots: [{ slot_index: 0, label: 'Shared KithMoot', secret: '', secret_fingerprint: 'ee'.repeat(32),
        current_pubkey: b, authorized_pubkeys: [a, b, c],
        allowed_methods: ['sign_event', 'nip44_encrypt', 'nip44_decrypt'], allowed_kinds: [30078],
        auto_approve: true, signing_approved: true, strict_permissions: true,
        client_approvals: [
          { client_pubkey: a, approved_identities: ['11'.repeat(32)], legacy_identity_tags: [] },
          { client_pubkey: b, approved_identities: [], legacy_identity_tags: ['22'.repeat(8)] },
          { client_pubkey: c, approved_identities: [], legacy_identity_tags: [] },
        ],
      }],
    })
  })
  await page.getByRole('button', { name: 'Advanced ⚙', exact: true }).click()
  await page.getByRole('button', { name: 'Apps', exact: true }).click()
  await page.getByText('Persona consent', { exact: true }).click()
  for (const fp of ['aaaaaaaa…aaaaaaaa', 'bbbbbbbb…bbbbbbbb', 'cccccccc…cccccccc']) {
    await page.getByText(fp, { exact: true }).click()
  }
  await expect(page.getByText('No remembered persona consent.', { exact: true })).toBeVisible()
  await expect(page.getByText('inherited approval', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Withdraw identity', exact: true }).nth(1).click()
  await expect(page.getByText('Withdraw consent for ' + '22'.repeat(8) + ' from bbbbbbbb…bbbbbbbb?', { exact: true })).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1)
  await page.screenshot({ path: process.env.CONSENT_SCREENSHOT ?? 'test-results/client-consent-phone.png', fullPage: true })
})
