import { readFileSync } from 'node:fs'
import { defineConfig, type Plugin } from 'vite'
import { svelte } from '@sveltejs/vite-plugin-svelte'

// App version, surfaced in the UI so a tester can confirm which build they're on
// (a stale tab runs old JS until a hard reload).
const APP_VERSION = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version

// Content-Security-Policy for the deployed app. Locks every resource-load vector
// to our own origin so no third party (fonts, scripts, images, frames) can ever
// be loaded — the font is self-hosted, so there is no IP leak, and this stops
// one from being reintroduced. connect-src is necessarily open (ws/wss for
// arbitrary Nostr relays, http(s) for a user's bridge); style 'unsafe-inline'
// covers Svelte's inline width styles. Injected at BUILD only, so it never
// breaks the dev server's HMR (which needs inline scripts + eval).
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  // data: for the small JetBrains Mono subsets Vite inlines as data URIs
  // (inline — no network request, so no privacy impact).
  "font-src 'self' data:",
  "img-src 'self' data:",
  "connect-src 'self' ws: wss: http: https:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join('; ')

function cspPlugin(): Plugin {
  return {
    name: 'inject-csp',
    apply: 'build',
    transformIndexHtml(html) {
      return html.replace(
        '</head>',
        `    <meta http-equiv="Content-Security-Policy" content="${CSP}" />\n  </head>`,
      )
    },
  }
}

export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify(APP_VERSION),
  },
  plugins: [svelte(), cspPlugin()],
  // Relative base so the same build works at GitHub Pages' /sapwood/ subpath
  // (Web Serial initial provisioning) and at the bridge's / root on mypi.
  base: './',
  build: {
    target: 'es2022',
    outDir: 'dist',
  },
  server: {
    hmr: {
      host: 'localhost',
      port: 5173,
      protocol: 'ws',
    },
  },
})
