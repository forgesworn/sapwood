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

// The support pages under /about/ are static files in public/; they must
// deploy with the app and keep their assets self-hosted (the /about/* CSP
// allows nothing third-party).
test('serves the web and CLI guides with their assets', async ({ page }) => {
  const guide = await page.request.get('/about/guide/')
  expect(guide.status()).toBe(200)
  await expect(guide.text()).resolves.toContain('<title>Sapwood guide: the web console</title>')

  const cli = await page.request.get('/about/cli/')
  expect(cli.status()).toBe(200)
  await expect(cli.text()).resolves.toContain('<title>Sapwood guide: the command line</title>')

  const css = await page.request.get('/about/guide.css')
  expect(css.status()).toBe(200)

  // One still and one recording, standing in for the asset set.
  const still = await page.request.get('/about/guide/img/home.png')
  expect(still.status()).toBe(200)
  expect(still.headers()['content-type']).toContain('image/png')
  const rec = await page.request.get('/about/guide/img/connect-app.gif')
  expect(rec.status()).toBe(200)
  expect(rec.headers()['content-type']).toContain('image/gif')

  // Every figure the page references must actually deploy. Status alone proves
  // nothing here: a missing file under /about/ falls through to the SPA
  // fallback, which answers 200 with index.html, so the page would render a
  // broken image while the request looked healthy. Check the type it served.
  const figures = [...(await guide.text()).matchAll(/<img src="(img\/[^"]+)"/g)].map((m) => m[1])
  expect(figures.length).toBeGreaterThan(10)
  for (const src of figures) {
    const asset = await page.request.get(`/about/guide/${src}`)
    expect(asset.status(), src).toBe(200)
    expect(asset.headers()['content-type'], src).toMatch(/^image\//)
  }

  // The about page links to both guides.
  const about = await page.request.get('/about/')
  await expect(about.text()).resolves.toMatch(/href="guide\/"[\s\S]*href="cli\/"/)
})
