import type { Page } from '@playwright/test'

/**
 * Make Web Serial appear present and inject a fake flash backend, so the whole
 * flasher flow runs in a real browser with no hardware. Call before page.goto.
 */
export async function installFakeFlasher(page: Page): Promise<void> {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'serial', { value: {}, configurable: true })
    ;(window as unknown as { __sapwoodFlashBackend: unknown }).__sapwoodFlashBackend = {
      hasWebSerial: () => true,
      requestPort: async () => ({}),
      fetchBin: async (url: string) => {
        const res = await fetch(url, { cache: 'no-store' })
        if (!res.ok) throw new Error(`fetch ${url} failed: ${res.status}`)
        return new Uint8Array(await res.arrayBuffer())
      },
      fetchManifest: async () => {
        const res = await fetch('/firmware/version.json', { cache: 'no-store' })
        if (!res.ok) throw new Error(`fetch manifest failed: ${res.status}`)
        return res.json()
      },
      openSession: async () => ({
        detectChip: async () => 'ESP32-S3 (fake)',
        eraseFlash: async () => {},
        writeFlash: async (
          regions: unknown[],
          report: (fileIndex: number, written: number, total: number) => void,
        ) => {
          for (let i = 0; i < regions.length; i++) report(i, 100, 100)
        },
        hardReset: async () => {},
        close: async () => {},
      }),
    }
  })
}

/**
 * Arm the connected-admin test seam: sets `window.__sapwoodE2E` before load so
 * `window.__sapwoodConnect(...)` becomes available to fake a connected device
 * (no relay/hardware needed). Call before page.goto.
 */
export async function enableAdminTestSeam(page: Page): Promise<void> {
  await page.addInitScript(() => {
    ;(window as unknown as { __sapwoodE2E: boolean }).__sapwoodE2E = true
  })
}

/** Force Web Serial to be absent, so the unsupported-browser path renders. */
export async function disableWebSerial(page: Page): Promise<void> {
  await page.addInitScript(() => {
    try { delete (Navigator.prototype as { serial?: unknown }).serial } catch { /* ignore */ }
    try { delete (navigator as { serial?: unknown }).serial } catch { /* ignore */ }
  })
}
