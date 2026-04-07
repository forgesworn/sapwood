# Contributing to Sapwood

Sapwood is part of the [Heartwood](https://github.com/forgesworn/heartwood-esp32) signing device ecosystem. Contributions are welcome.

## Prerequisites

- Node.js 20+
- npm
- Chrome or Edge 89+ (for manual testing -- Web Serial is not available in Firefox/Safari)
- A Heartwood ESP32 device (optional, but helpful for integration testing)

## Setup

```bash
git clone https://github.com/forgesworn/sapwood.git
cd sapwood
npm install
npm run dev
```

Dev server runs at `http://localhost:5173`.

## Tests

```bash
npm test           # run all tests
npm run test:watch # watch mode during development
```

The 19 frame protocol tests in `src/lib/frame.test.ts` verify byte-level compatibility with the Rust implementation in heartwood-esp32. Keep them passing. If you add a new frame type, add corresponding tests.

## Code style

- **British English** in all prose, comments, and UI copy
- TypeScript strict mode -- no `any`, no type assertions without justification
- Svelte 5 runes mode -- `$state`, `$derived`, `$effect`; no legacy Svelte 4 patterns
- ESM-only (`"type": "module"`, target ES2022)
- No external runtime dependencies unless strictly necessary

## Frame protocol changes

The frame protocol in `src/lib/frame.ts` is a TypeScript port of `heartwood-common/src/frame.rs`. Any change here must be mirrored in the Rust implementation (or vice versa) and verified with tests. Do not change the wire format unilaterally.

## Pull requests

- One logical change per PR
- Describe what and why in the PR body
- All tests must pass
- Build must succeed (`npm run build`)

## Commit format

```
type: short description
```

Types: `feat`, `fix`, `refactor`, `test`, `docs`, `chore`. No Co-Authored-By lines.

## Reporting issues

Open an issue on GitHub. For security issues, do not open a public issue -- contact the maintainers privately.
