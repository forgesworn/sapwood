import { test, expect } from '@playwright/test'
import { readFileSync } from 'node:fs'

test('serves favicon and web app manifest as real static files', async ({ page }) => {
  const favicon = await page.request.get('/favicon.svg')
  expect(favicon.status()).toBe(200)
  expect(favicon.headers()['content-type']).toContain('image/svg+xml')
  await expect(favicon.text()).resolves.toContain('<svg')

  const manifest = await page.request.get('/manifest.webmanifest')
  expect(manifest.status()).toBe(200)
  expect(manifest.headers()['content-type']).toMatch(/json|manifest/)
  await expect(manifest.json()).resolves.toMatchObject({
    name: 'Sapwood',
    display: 'standalone',
  })
})

test('deploy routes missing hashed assets before the SPA fallback', async () => {
  const caddy = readFileSync(new URL('../deploy/sapwood.Caddyfile', import.meta.url), 'utf8')
  const assetsHandle = caddy.indexOf('handle /assets/*')
  const spaFallback = caddy.indexOf('try_files {path} /index.html')
  expect(assetsHandle).toBeGreaterThan(-1)
  expect(spaFallback).toBeGreaterThan(-1)
  expect(assetsHandle).toBeLessThan(spaFallback)
  expect(caddy).toMatch(/@assets\s*\{[\s\S]*path \/assets\/\*[\s\S]*file[\s\S]*\}/)
})
