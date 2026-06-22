#!/usr/bin/env node
// Pull the published firmware into public/firmware so flashing and OTA always
// ship the current build — replacing the old hand-copied, drift-prone binaries.
//
// Downloads `version.json` + each board's app + bootloader image and the shared
// partition table from a heartwood-esp32 GitHub release (latest by default, or a
// tag passed as the first argument), verifies every SHA-256, and lays them out
// under public/firmware/<dir>/ as the flasher expects (app.bin, bootloader.bin,
// partition-table.bin). Writes a served version.json (per board: app + sha + bytes)
// that the update UI reads for "running vX → update to vY".
//
//   npm run sync:firmware            # latest release
//   npm run sync:firmware v0.8.0     # a specific tag
//
// Requires the `gh` CLI, authenticated with read access to the repo.

import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs'
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
  dlArgs.push(
    '--repo', REPO,
    '--pattern', 'version.json',
    '--pattern', 'app*.bin',
    '--pattern', 'bootloader*.bin',
    '--pattern', 'partition-table.bin',
    '--dir', tmp, '--clobber',
  )
  execFileSync('gh', dlArgs, { stdio: 'inherit' })

  const manifest = JSON.parse(readFileSync(join(tmp, 'version.json'), 'utf8'))
  const boards = Object.entries(manifest.boards ?? {})
  if (boards.length === 0) fail('version.json lists no boards')

  // Read + verify a downloaded asset, returning its bytes.
  const verified = (assetName, expectedSha, what) => {
    const p = join(tmp, assetName)
    if (!existsSync(p)) fail(`Release asset "${assetName}" (${what}) not found`)
    const bytes = readFileSync(p)
    const sha = createHash('sha256').update(bytes).digest('hex')
    if (expectedSha && sha !== expectedSha) {
      fail(`SHA-256 mismatch for ${what} (${assetName})\n  got      ${sha}\n  manifest ${expectedSha}`)
    }
    return bytes
  }

  // Shared partition table (board-independent), if the release carries one.
  const pt = manifest.partitionTable
  const ptBytes = pt ? verified(pt.asset, pt.sha256, 'partition table') : null

  const served = { version: manifest.version, builtAt: manifest.builtAt, boards: {} }
  const synced = []

  for (const [board, meta] of boards) {
    const dir = BOARD_DIR[board]
    if (!dir) fail(`Unknown board "${board}" — add it to BOARD_DIR in sync-firmware.mjs`)
    const destDir = join(root, 'public', 'firmware', dir)
    mkdirSync(destDir, { recursive: true })

    // App image (asset name lives in meta.app).
    const appBytes = verified(meta.app, meta.sha256, `${board} app`)
    writeFileSync(join(destDir, 'app.bin'), appBytes)
    const lines = ['app.bin']

    // Bootloader (board-specific), if present.
    if (meta.bootloader) {
      const blBytes = verified(meta.bootloader, meta.bootloaderSha256, `${board} bootloader`)
      writeFileSync(join(destDir, 'bootloader.bin'), blBytes)
      lines.push('bootloader.bin')
    }

    // Shared partition table.
    if (ptBytes) {
      writeFileSync(join(destDir, 'partition-table.bin'), ptBytes)
      lines.push('partition-table.bin')
    }

    served.boards[board] = { app: 'app.bin', sha256: meta.sha256, bytes: meta.bytes }
    synced.push(`${board} → public/firmware/${dir}/{${lines.join(', ')}}`)
  }

  writeFileSync(join(root, 'public', 'firmware', 'version.json'), JSON.stringify(served, null, 2) + '\n')

  console.log(`Synced firmware ${manifest.version}:`)
  for (const line of synced) console.log(`  ${line}`)
  console.log('Commit the updated images + version.json to ship it.')
} finally {
  rmSync(tmp, { recursive: true, force: true })
}
