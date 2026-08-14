// One-off config for the hardware bench tests: reuses the base config
// (svelte plugin, jsdom) but collects ONLY the bench files, so normal
// `npm test` / CI never see them. Name a single file on the command line to
// run one bench: `npx vitest run --config vitest.hardware.config.ts hardware-recovery.test.ts`
import { fileURLToPath } from 'node:url'
import base from './vitest.config'
export default {
  ...base,
  resolve: {
    // Pin `ws` to its real Node entry: the test environment's browser resolve
    // condition would otherwise pick ws's throwing browser shim.
    alias: { ws: fileURLToPath(new URL('./node_modules/ws/index.js', import.meta.url)) },
  },
  test: {
    ...(base as { test?: object }).test,
    include: ['hardware-*.test.ts'],
    // Real sockets instead of the inert stub: the bench's relay legs are real.
    setupFiles: ['./vitest.hardware.setup.ts'],
  },
}
