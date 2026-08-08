import { defineConfig } from 'vitest/config'
import { svelte } from '@sveltejs/vite-plugin-svelte'
import { svelteTesting } from '@testing-library/svelte/vite'

// The svelte plugin compiles .svelte components and runes-mode .svelte.ts
// modules so they can be unit/component tested. svelteTesting wires in
// auto-cleanup and the browser resolve condition for @testing-library/svelte.
export default defineConfig({
  plugins: [svelte(), svelteTesting()],
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.ts', 'cli/**/*.test.ts'],
    // Keeps unit tests off the network — see the note in the setup file.
    setupFiles: ['./vitest.setup.ts'],
  },
})
