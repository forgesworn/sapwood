#!/usr/bin/env node
// Pull the published firmware into public/firmware so flashing and OTA always
// ship the current build — replacing the old hand-copied, drift-prone binaries.
//
// Downloads `version.json` + each board's app image from a heartwood-esp32
// GitHub release (latest by default, or a tag passed as the first argument),
// verifies every SHA-256 against the manifest, and drops each board's image at
// public/firmware/<dir>/app.bin. Writes a served version.json (per board:
// app.bin + sha256 + bytes) that the update UI reads.
//
//   npm run sync:firmware            # latest release
//   npm run sync:firmware v0.8.0     # a specific tag
//
// Requires the `gh` CLI, authenticated with read access to the repo.

import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync, copyFileSync, mkdirSync, rmSync, existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = 'forgesworn/heartwood-esp32'
// Map a firmware board id to its public/firmware subdirectory.
const BOARD_DIR = { 'heltec-v4': 'v4', 'heltec-v3': 'v3' }

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const tag = process.argv[2] // optional; omitted ⇒ latest release

function fail(msg) {
  console.error(msg)
  process.exit(1)
}

const tmp = mkdtempSync(join(tmpdir(), 'hw-fw-'))
try {
  const dlArgs = ['release', 'download']
  if (tag) dlArgs.push(tag)
  // Grab the manifest and every per-board app image (app-<board>.bin), plus the
  // legacy single app.bin name for older releases.
  dlArgs.push('--repo', REPO, '--pattern', 'version.json', '--pattern', 'app*.bin', '--dir', tmp, '--clobber')
  execFileSync('gh', dlArgs, { stdio: 'inherit' })

  const manifest = JSON.parse(readFileSync(join(tmp, 'version.json'), 'utf8'))
  const boards = Object.entries(manifest.boards ?? {})
  if (boards.length === 0) fail('version.json lists no boards')

  const served = { version: manifest.version, builtAt: manifest.builtAt, boards: {} }
  const synced = []

  for (const [board, meta] of boards) {
    const dir = BOARD_DIR[board]
    if (!dir) fail(`Unknown board "${board}" — add it to BOARD_DIR in sync-firmware.mjs`)

    // The manifest names the release asset; older releases used a bare app.bin.
    const assetName = meta.asset ?? 'app.bin'
    const assetPath = join(tmp, assetName)
    if (!existsSync(assetPath)) fail(`Release asset "${assetName}" for ${board} not found`)

    const bytes = readFileSync(assetPath)
    const sha = createHash('sha256').update(bytes).digest('hex')
    if (sha !== meta.sha256) {
      fail(`SHA-256 mismatch for ${board} — refusing to install.\n  got      ${sha}\n  manifest ${meta.sha256}`)
    }

    const destDir = join(root, 'public', 'firmware', dir)
    mkdirSync(destDir, { recursive: true })
    copyFileSync(assetPath, join(destDir, 'app.bin'))
    served.boards[board] = { app: 'app.bin', sha256: meta.sha256, bytes: meta.bytes }
    synced.push(`${board} → public/firmware/${dir}/app.bin`)
  }

  writeFileSync(join(root, 'public', 'firmware', 'version.json'), JSON.stringify(served, null, 2) + '\n')

  console.log(`Synced firmware ${manifest.version}:`)
  for (const line of synced) console.log(`  ${line}`)
  console.log('Commit the updated app.bin(s) + version.json to ship it.')
} finally {
  rmSync(tmp, { recursive: true, force: true })
}
