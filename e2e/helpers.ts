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
        // flashAppOnly reads the partition table before writing and refuses
        // unless there is exactly one firmware slot at 0x10000. Answer with a
        // single-slot 4 MB factory layout (nvs, phy_init, factory, config) so
        // the quick USB update flow can run end to end.
        readFlash: async (_address: number, size: number) => {
          const out = new Uint8Array(size).fill(0xff)
          const view = new DataView(out.buffer)
          const rows: Array<[string, number, number, number, number]> = [
            ['nvs', 1, 0x02, 0x9000, 0x6000],
            ['phy_init', 1, 0x01, 0xf000, 0x1000],
            ['factory', 0, 0x00, 0x10000, 0x300000],
            ['config', 1, 0x40, 0x310000, 0x4000],
          ]
          rows.forEach(([label, type, subtype, offset, len], i) => {
            const o = i * 32
            out.set([0xaa, 0x50, type, subtype], o)
            view.setUint32(o + 4, offset, true)
            view.setUint32(o + 8, len, true)
            out.fill(0, o + 12, o + 32)
            out.set(new TextEncoder().encode(label), o + 12)
          })
          return out
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
