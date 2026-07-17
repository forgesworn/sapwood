#!/usr/bin/env node
// Bundle the CLI to dist-cli/sapwood.mjs. serialport stays external: it is a
// native module resolved from node_modules at run time.
import { build } from 'esbuild'
import { chmodSync, readFileSync } from 'node:fs'

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))

await build({
  entryPoints: ['cli/main.ts'],
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'esm',
  outfile: 'dist-cli/sapwood.mjs',
  external: ['serialport'],
  banner: { js: '#!/usr/bin/env node' },
  define: { __SAPWOOD_VERSION__: JSON.stringify(pkg.version) },
  logLevel: 'info',
})

chmodSync('dist-cli/sapwood.mjs', 0o755)
