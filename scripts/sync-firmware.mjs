#!/usr/bin/env node
// Pull the published firmware into public/firmware so flashing and OTA always
// ship the current build — replacing the old hand-copied, drift-prone binaries.
//
// Downloads `app.bin` + `version.json` from a heartwood-esp32 GitHub release
// (latest by default, or a tag passed as the first argument), verifies the
// SHA-256 against the manifest, and drops them into place.
//
//   npm run sync:firmware            # latest release
//   npm run sync:firmware v0.8.0     # a specific tag
//
// Requires the `gh` CLI, authenticated with read access to the repo.

import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync, copyFileSync, mkdirSync, rmSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = 'forgesworn/heartwood-esp32'
// Map a firmware board id to its public/firmware subdirectory.
const BOARD_DIR = { 'heltec-v4': 'v4', 'heltec-v3': 'v3' }

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const tag = process.argv[2] // optional; omitted ⇒ latest release

const tmp = mkdtempSync(join(tmpdir(), 'hw-fw-'))
try {
  const dlArgs = ['release', 'download']
  if (tag) dlArgs.push(tag)
  dlArgs.push('--repo', REPO, '--pattern', 'app.bin', '--pattern', 'version.json', '--dir', tmp, '--clobber')
  execFileSync('gh', dlArgs, { stdio: 'inherit' })

  const manifest = JSON.parse(readFileSync(join(tmp, 'version.json'), 'utf8'))
  const boards = Object.keys(manifest.boards ?? {})
  if (boards.length !== 1) {
    // The release currently ships a single board's app.bin. A multi-board
    // release would need per-board asset names — extend here when that lands.
    console.error(`Expected exactly one board in version.json, found: ${boards.join(', ') || 'none'}`)
    process.exit(1)
  }
  const board = boards[0]
  const dir = BOARD_DIR[board]
  if (!dir) {
    console.error(`Unknown board "${board}" — add it to BOARD_DIR in sync-firmware.mjs`)
    process.exit(1)
  }

  const appBytes = readFileSync(join(tmp, 'app.bin'))
  const sha = createHash('sha256').update(appBytes).digest('hex')
  const expected = manifest.boards[board].sha256
  if (sha !== expected) {
    console.error(`SHA-256 mismatch — refusing to install.\n  got      ${sha}\n  manifest ${expected}`)
    process.exit(1)
  }

  const destDir = join(root, 'public', 'firmware', dir)
  mkdirSync(destDir, { recursive: true })
  copyFileSync(join(tmp, 'app.bin'), join(destDir, 'app.bin'))
  writeFileSync(join(root, 'public', 'firmware', 'version.json'), JSON.stringify(manifest, null, 2) + '\n')

  console.log(`Synced firmware ${manifest.version} (${board}) → public/firmware/${dir}/app.bin`)
  console.log('Commit the updated app.bin + version.json to ship it.')
} finally {
  rmSync(tmp, { recursive: true, force: true })
}
