import { defineConfig } from 'vite'
import { svelte } from '@sveltejs/vite-plugin-svelte'

export default defineConfig({
  plugins: [svelte()],
  // Relative base so the same build works at GitHub Pages' /sapwood/ subpath
  // (Web Serial initial provisioning) and at the bridge's / root on mypi.
  base: './',
  build: {
    target: 'es2022',
    outDir: 'dist',
  },
})
