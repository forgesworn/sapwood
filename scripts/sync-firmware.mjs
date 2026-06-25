#!/usr/bin/env node
// Pull the published firmware into public/firmware so flashing and OTA always
// ship the current build — replacing the old hand-copied, drift-prone binaries.
//
// Downloads `version.json` + each board's app + bootloader image and the board's
// own partition table from a heartwood-esp32 GitHub release (latest by default, or
// a tag passed as the first argument), verifies every SHA-256, and lays them out
// under public/firmware/<dir>/ as the flasher expects (app.bin, and — for the
// esp-idf boards — bootloader.bin + the board's own partition-table.bin). Writes a
// served version.json (per board: app + sha + bytes + ota flag) that the update UI
// reads for "running vX → update to vY".
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
// Map a firmware board id to its public/firmware subdirectory. A released board
// with no mapping here is skipped (with a warning), not a hard failure — so
// heartwood-esp32 can introduce a board before the flasher UI here supports it.
const BOARD_DIR = {
  'heltec-v4': 'v4',
  'heltec-v3': 'v3',
  tdisplay: 'tdisplay',
  c6: 'c6',
  esp8266: 'esp8266',
}

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const flags = process.argv.slice(2)
const tag = flags.find((a) => !a.startsWith('--')) // optional; omitted ⇒ latest release
// The bootloader + partition table change ~never and a board's bootloader, once
// flash-proven, should not be silently swapped for a byte-different CI rebuild.
// So they are written only when absent; --force overwrites them deliberately.
const force = flags.includes('--force')

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
    '--pattern', 'partition-table*.bin',
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

  const served = { version: manifest.version, builtAt: manifest.builtAt, boards: {} }
  const synced = []
  const skipped = []

  for (const [board, meta] of boards) {
    const dir = BOARD_DIR[board]
    if (!dir) {
      skipped.push(`${board} (no public/firmware mapping — add it to BOARD_DIR to flash it here)`)
      continue
    }
    const destDir = join(root, 'public', 'firmware', dir)
    mkdirSync(destDir, { recursive: true })

    // App image always updates (it carries the firmware version). Bootloader +
    // partition table are pinned: written only when absent, unless --force.
    const place = (name, bytes, pinned) => {
      const dest = join(destDir, name)
      if (pinned && existsSync(dest) && !force) {
        skipped.push(`${board}/${name} (kept; --force to overwrite)`)
        return name
      }
      writeFileSync(dest, bytes)
      return name
    }

    // The partition table is per-board now: heltec is a 2 MB A/B OTA layout, the
    // 4 MB boards a single factory slot, and the esp8266 carries none at all.
    const ptBytes = meta.partitionTable
      ? verified(meta.partitionTable, meta.partitionTableSha256, `${board} partition table`)
      : null

    const lines = [place('app.bin', verified(meta.app, meta.sha256, `${board} app`), false)]
    if (meta.bootloader) {
      lines.push(place('bootloader.bin', verified(meta.bootloader, meta.bootloaderSha256, `${board} bootloader`), true))
    }
    if (ptBytes) {
      lines.push(place('partition-table.bin', ptBytes, true))
    }

    served.boards[board] = { app: 'app.bin', sha256: meta.sha256, bytes: meta.bytes, ota: meta.ota ?? false }
    synced.push(`${board} → public/firmware/${dir}/{${lines.join(', ')}}`)
  }

  writeFileSync(join(root, 'public', 'firmware', 'version.json'), JSON.stringify(served, null, 2) + '\n')

  console.log(`Synced firmware ${manifest.version}:`)
  for (const line of synced) console.log(`  ${line}`)
  for (const line of skipped) console.log(`  · ${line}`)
  console.log('Commit the updated images + version.json to ship it.')
} finally {
  rmSync(tmp, { recursive: true, force: true })
}
