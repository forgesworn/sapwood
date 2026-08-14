// One-off config for the untracked hardware click-through test: reuses the
// base config (svelte plugin, jsdom) but collects ONLY the bench file, so
// normal `npm test` / CI never see it.
import base from './vitest.config'
export default {
  ...base,
  test: { ...(base as { test?: object }).test, include: ['hardware-clickthrough.test.ts'] },
}
