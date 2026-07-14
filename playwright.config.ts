import { defineConfig, devices } from '@playwright/test'

// End-to-end tests run against the built app (vite preview) in real browsers.
// The flash flow uses an injected fake backend (window.__sapwoodFlashBackend),
// so no hardware or Web Serial permission is needed. See e2e/*.spec.ts.
export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL: 'http://localhost:4173',
    trace: 'on-first-retry',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    // The QR receive/import path is specifically an iPhone workflow. Keep a
    // real mobile WebKit lane for it without doubling every USB/flasher test.
    {
      name: 'mobile-webkit',
      testMatch: /import\.spec\.ts/,
      use: { ...devices['iPhone 13'] },
    },
  ],
  webServer: {
    // Build then serve dist. Cheap build (~250ms) keeps this correct locally
    // and in CI without depending on a prior build step.
    command: 'npm run build && npm run preview -- --port 4173 --strictPort',
    url: 'http://localhost:4173',
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
})
