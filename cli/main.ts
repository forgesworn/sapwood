// Sapwood CLI entry point: sapwood <command> [options].
//
// The management console for the Heartwood signer, at a shell prompt. Talks
// the same frame protocol as the web app over node-serialport; the same
// security model applies — no secrets on this side of the cable, destructive
// operations gated by the device's physical button.

import { readFile, writeFile } from 'node:fs/promises'
import process from 'node:process'
import { createInterface } from 'node:readline/promises'
import { HELP, UsageError, intFlag, parseArgs } from './args.js'
import { NodeSerialTransport, listPorts, pickPort } from './transport.js'
import {
  CommandError,
  cmdApps,
  cmdAppsRevoke,
  cmdDerive,
  cmdDevice,
  cmdIdentities,
  cmdIdentitiesRemove,
  cmdKeyBackup,
  cmdOperatorNew,
  cmdOperatorRestore,
  deviceMastersForBackup,
  findRemovalTarget,
  parseSignature,
} from './commands.js'
import type { CommandResult } from './commands.js'
import { OtaError, streamOta } from '../src/lib/ota.js'
import { isValidNcryptsec } from '../src/lib/restore.js'
import {
  decryptBackup,
  encryptBackup,
  exportBackup,
  importBackup,
  parseBackupEnvelope,
} from '../src/lib/backup.js'

declare const __SAPWOOD_VERSION__: string
const VERSION = typeof __SAPWOOD_VERSION__ === 'string' ? __SAPWOOD_VERSION__ : 'dev'

const DEFAULT_TIMEOUT_MS = 10_000

function fail(message: string, code: 1 | 2 = 1): never {
  process.stderr.write(`sapwood: ${message}\n`)
  process.exit(code)
}

function printResult(result: CommandResult, json: boolean): void {
  if (json) process.stdout.write(`${JSON.stringify(result.data, null, 2)}\n`)
  else process.stdout.write(`${result.lines.join('\n')}\n`)
}

/** Pick the serial port: --port wins; otherwise exactly one known signer. */
async function resolvePort(flag: string | undefined): Promise<string> {
  try {
    return pickPort(flag ? [] : await listPorts(), flag)
  } catch (e) {
    fail(e instanceof Error ? e.message : String(e))
  }
}

/** Read the ed25519 release signature: 64 raw bytes, or 128 hex chars. */
async function readSignature(path: string): Promise<Uint8Array> {
  return parseSignature(new Uint8Array(await readFile(path)), path)
}

async function cmdLogs(transport: NodeSerialTransport, json: boolean): Promise<never> {
  process.stderr.write('Streaming the device log. Ctrl-C to stop.\n')
  transport.on((event) => {
    if (event.kind === 'log') {
      process.stdout.write(json ? `${JSON.stringify({ line: event.line })}\n` : `${event.line}\n`)
    } else if (event.kind === 'close') {
      process.stderr.write('sapwood: device disconnected\n')
      process.exit(1)
    }
  })
  return new Promise<never>(() => {
    process.on('SIGINT', () => {
      void transport.close().finally(() => process.exit(0))
    })
  })
}

/** Read all of stdin to a string. Used when a key is piped in, not typed. */
async function readAllStdin(): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks).toString('utf8')
}

/** Prompt on stderr and read a line without echoing it (for a key password).
 *  Falls back to a plain readline when stdin is not a TTY. Control keys are
 *  matched by code point so no raw control characters live in this source. */
function questionHidden(query: string): Promise<string> {
  const stdin = process.stdin
  if (!stdin.isTTY) {
    const rl = createInterface({ input: stdin, output: process.stderr })
    return rl.question(query).finally(() => rl.close())
  }
  return new Promise<string>((resolve) => {
    process.stderr.write(query)
    const prevRaw = stdin.isRaw
    stdin.setRawMode(true)
    stdin.resume()
    let value = ''
    const finish = (): void => {
      stdin.setRawMode(prevRaw)
      stdin.pause()
      stdin.removeListener('data', onData)
      process.stderr.write('\n')
    }
    const onData = (buf: Buffer): void => {
      for (const ch of buf.toString('utf8')) {
        const code = ch.charCodeAt(0)
        if (code === 13 || code === 10 || code === 4) {
          finish() // CR, LF, Ctrl-D: submit
          resolve(value)
          return
        } else if (code === 3) {
          finish() // Ctrl-C: abort
          process.exit(130)
        } else if (code === 127 || code === 8) {
          value = value.slice(0, -1) // DEL / backspace
        } else if (code >= 32) {
          value += ch // printable
        }
      }
    }
    stdin.on('data', onData)
  })
}

/** `key backup`: turn an nsec/ncryptsec into a 24-word key backup. Offline; the
 *  secret is read from stdin (piped) or a prompt, never from argv, so it does
 *  not land in shell history or `ps`. The device is never opened. */
async function runKeyBackup(json: boolean): Promise<never> {
  let secret: string
  let password: string | undefined
  if (process.stdin.isTTY) {
    const rl = createInterface({ input: process.stdin, output: process.stderr })
    secret = (await rl.question('Paste an nsec or an encrypted key (ncryptsec): ')).trim()
    rl.close()
    if (isValidNcryptsec(secret)) password = await questionHidden('Password for the encrypted key: ')
  } else {
    const lines = (await readAllStdin()).split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0)
    secret = lines[0] ?? ''
    password = lines[1]
  }
  try {
    printResult(cmdKeyBackup(secret, password), json)
  } catch (e) {
    fail(e instanceof Error ? e.message : String(e))
  }
  process.exit(0)
}

/** `operator restore`: derive the operator key from a recovery phrase read on
 *  stdin (piped) or a prompt, never from argv. Offline; no device is opened. */
async function runOperatorRestore(json: boolean): Promise<never> {
  let phrase: string
  if (process.stdin.isTTY) {
    const rl = createInterface({ input: process.stdin, output: process.stderr })
    phrase = (await rl.question('Paste the operator recovery phrase: ')).trim()
    rl.close()
  } else {
    phrase = (await readAllStdin()).trim()
  }
  try {
    printResult(cmdOperatorRestore(phrase), json)
  } catch (e) {
    fail(e instanceof Error ? e.message : String(e))
  }
  process.exit(0)
}

/** Read a backup passphrase. Interactive prompts (twice, to confirm, when
 *  `confirm`); non-interactive reads it from the first line of stdin. */
async function readBackupPassphrase(confirm: boolean): Promise<string> {
  if (!process.stdin.isTTY) {
    const passphrase = (await readAllStdin()).split(/\r?\n/)[0]?.trim() ?? ''
    if (!passphrase) fail('a passphrase is required (pipe it on stdin, or run interactively)')
    return passphrase
  }
  const passphrase = await questionHidden(confirm ? 'Passphrase to encrypt the backup: ' : 'Backup passphrase: ')
  if (!passphrase) fail('a passphrase is required')
  if (confirm && (await questionHidden('Confirm passphrase: ')) !== passphrase) fail('passphrases do not match')
  return passphrase
}

/** `backup export`: read the signer's connection slots (button-confirmed on the
 *  device), encrypt them under a passphrase, and write the file. */
async function runBackupExport(transport: NodeSerialTransport, outPath: string | undefined, json: boolean): Promise<void> {
  const passphrase = await readBackupPassphrase(true)
  process.stderr.write('Confirm the export on the signer: press its button when prompted.\n')
  const payload = await exportBackup(transport)
  const envelope = encryptBackup(payload, passphrase)
  const file = outPath ?? `heartwood-backup-${payload.device_id.slice(0, 8) || 'signer'}.json`
  await writeFile(file, `${JSON.stringify(envelope, null, 2)}\n`)
  const slots = payload.masters.reduce((total, m) => total + m.connection_slots.length, 0)
  if (json) {
    process.stdout.write(`${JSON.stringify({ file, masters: payload.masters.length, slots })}\n`)
  } else {
    process.stdout.write(`✓ Encrypted backup written to ${file}. ${payload.masters.length} identities, ${slots} app slots.\n`)
  }
}

/** `backup import <file>`: decrypt a backup, match it against the signer's
 *  current identities, and restore the matching slots (button-confirmed). */
async function runBackupImport(transport: NodeSerialTransport, file: string, json: boolean): Promise<void> {
  const envelope = parseBackupEnvelope(await readFile(file, 'utf8'))
  const passphrase = await readBackupPassphrase(false)
  const payload = decryptBackup(envelope, passphrase)
  const masters = await deviceMastersForBackup(transport, { timeoutMs: 10_000 })
  process.stderr.write('Confirm the restore on the signer: press its button when prompted.\n')
  const result = await importBackup(transport, payload, masters)
  if (json) {
    process.stdout.write(`${JSON.stringify(result)}\n`)
  } else {
    process.stdout.write(`✓ Restored ${result.restored} app slots.\n`)
    for (const m of result.masters) {
      process.stdout.write(`  ${m.matched ? '✓' : '·'} ${m.label}: ${m.slots} slot${m.slots === 1 ? '' : 's'}${m.matched ? '' : ' (not on this signer, skipped)'}\n`)
    }
  }
}

async function cmdFirmwareUpdate(
  transport: NodeSerialTransport,
  file: string,
  signaturePath: string | undefined,
  json: boolean,
): Promise<void> {
  const data = new Uint8Array(await readFile(file))
  let signature: Uint8Array | undefined
  const sigSource = signaturePath ?? `${file}.sig`
  try {
    signature = await readSignature(sigSource)
  } catch (e) {
    // The sibling .sig is opportunistic; an explicit --signature must exist.
    if (signaturePath) throw e
  }
  if (!signature) {
    process.stderr.write('No release signature found. Signature-enforcing firmware will refuse this update.\n')
  }

  const isTty = process.stderr.isTTY === true
  await streamOta(
    transport,
    data,
    {
      onPhase: (phase) => {
        if (phase === 'waiting') {
          process.stderr.write('Waiting for approval. Hold the button on the device for two seconds.\n')
        } else if (phase === 'verifying') {
          if (isTty) process.stderr.write('\n')
          process.stderr.write('Verifying on the device.\n')
        }
      },
      onProgress: (percent, sent, total) => {
        if (isTty) process.stderr.write(`\rUploading ${percent}% (${sent}/${total} bytes)`)
      },
    },
    signature,
  )
  if (json) process.stdout.write(`${JSON.stringify({ updated: true, bytes: data.length, signed: signature !== undefined })}\n`)
  else process.stdout.write('✓ Firmware verified. The device is rebooting into it.\n')
}

async function main(): Promise<void> {
  let positionals: string[]
  let flags: ReturnType<typeof parseArgs>['flags']
  try {
    ;({ positionals, flags } = parseArgs(process.argv.slice(2)))
  } catch (e) {
    fail(e instanceof Error ? e.message : String(e), 2)
  }

  if (flags['version']) {
    process.stdout.write(`${VERSION}\n`)
    return
  }
  if (flags['help'] || positionals.length === 0) {
    process.stdout.write(`${HELP}\n`)
    return
  }

  const json = flags['json'] === true
  const [command, ...rest] = positionals

  if (command === 'ports') {
    const ports = await listPorts(flags['all'] === true)
    if (json) {
      process.stdout.write(`${JSON.stringify(ports, null, 2)}\n`)
    } else if (ports.length === 0) {
      process.stdout.write('No signer ports found.\n')
    } else {
      process.stdout.write(`${ports.map((p) => `${p.path}${p.manufacturer ? `  (${p.manufacturer})` : ''}`).join('\n')}\n`)
    }
    return
  }

  // `key backup` is offline crypto on a key you supply — it never opens the
  // port, so it is handled here, before any device work.
  if (command === 'key') {
    if (rest[0] !== 'backup' || rest.length > 1) {
      fail('usage: sapwood key backup   (reads an nsec or ncryptsec on stdin)', 2)
    }
    await runKeyBackup(json)
    return
  }

  // `operator` derives the management key offline: `new` mints one, `restore`
  // recovers it from a phrase. Neither opens the device.
  if (command === 'operator') {
    if (rest[0] === 'new' && rest.length === 1) {
      printResult(cmdOperatorNew(), json)
      return
    }
    if (rest[0] === 'restore' && rest.length === 1) {
      await runOperatorRestore(json)
      return
    }
    fail('usage: sapwood operator new   |   sapwood operator restore', 2)
  }

  let timeoutMs: number
  let baud: number
  let identity: number | undefined
  let parent: number | undefined
  try {
    timeoutMs = intFlag(flags, 'timeout') ?? DEFAULT_TIMEOUT_MS
    baud = intFlag(flags, 'baud') ?? 115_200
    identity = intFlag(flags, 'identity')
    parent = intFlag(flags, 'parent')
  } catch (e) {
    fail(e instanceof Error ? e.message : String(e), 2)
  }
  const o = { timeoutMs }

  // Validate the command's shape BEFORE touching the port: a usage mistake
  // must not open (or contend for) the device.
  let deriveName = ''
  let revokeSlot: number | undefined
  let removeSlot: number | undefined
  switch (command) {
    case 'device':
    case 'logs':
      break
    case 'identities':
      if (rest.length > 0) {
        if (rest[0] !== 'remove') fail(`unknown identities subcommand '${rest.join(' ')}'`, 2)
        removeSlot = Number(rest[1])
        if (!Number.isInteger(removeSlot) || removeSlot < 0) fail('usage: sapwood identities remove <slot> [--yes]', 2)
      }
      break
    case 'derive':
      deriveName = rest.join(' ').trim()
      if (!deriveName) fail('usage: sapwood derive <name> [--parent <slot>]', 2)
      break
    case 'apps':
      if (rest.length > 0) {
        if (rest[0] !== 'revoke') fail(`unknown apps subcommand '${rest.join(' ')}'`, 2)
        revokeSlot = Number(rest[1])
        if (!Number.isInteger(revokeSlot) || revokeSlot < 0) fail('usage: sapwood apps revoke <slot> [--identity <slot>]', 2)
      }
      break
    case 'firmware':
      if (rest[0] !== 'update' || !rest[1]) fail('usage: sapwood firmware update <file.bin> [--signature <path>]', 2)
      break
    case 'backup':
      if (rest[0] !== 'export' && rest[0] !== 'import') {
        fail('usage: sapwood backup export [--out <file>]   |   sapwood backup import <file>', 2)
      }
      if (rest[0] === 'import' && !rest[1]) fail('usage: sapwood backup import <file>', 2)
      break
    default:
      fail(`unknown command '${command}'. Try: sapwood --help`, 2)
  }

  const portPath = await resolvePort(typeof flags['port'] === 'string' ? flags['port'] : undefined)
  let transport: NodeSerialTransport
  try {
    transport = await NodeSerialTransport.open(portPath, baud)
  } catch (e) {
    fail(e instanceof Error ? e.message : String(e))
  }

  try {
    switch (command) {
      case 'device':
        printResult(await cmdDevice(transport, o), json)
        break
      case 'identities':
        if (removeSlot !== undefined) {
          const { target, personas } = await findRemovalTarget(transport, removeSlot, o)
          if (flags['yes'] !== true) {
            process.stderr.write(`Removing '${target.label}' (slot ${target.slot})\n  ${target.npub}\n`)
            if (typeof target.apps === 'number' && target.apps > 0) {
              process.stderr.write(`  ${target.apps} connected app${target.apps === 1 ? '' : 's'} will stop working.\n`)
            }
            if (personas > 0) {
              process.stderr.write(`  ${personas} persona${personas === 1 ? '' : 's'} under this identity will be removed with it.\n`)
            }
            process.stderr.write('  The key itself remains derivable from its parent or phrase.\n')
            const rl = createInterface({ input: process.stdin, output: process.stderr })
            const answer = (await rl.question(`Type the identity's name to confirm: `)).trim()
            rl.close()
            if (answer !== target.label) fail('names do not match; nothing removed')
          }
          printResult(await cmdIdentitiesRemove(transport, target, o), json)
        } else {
          printResult(await cmdIdentities(transport, o), json)
        }
        break
      case 'derive':
        printResult(await cmdDerive(transport, deriveName, parent, o), json)
        break
      case 'apps':
        if (revokeSlot !== undefined) {
          printResult(await cmdAppsRevoke(transport, revokeSlot, identity, o), json)
        } else {
          printResult(await cmdApps(transport, identity, o), json)
        }
        break
      case 'logs':
        await cmdLogs(transport, json)
        break
      case 'firmware': {
        const sig = typeof flags['signature'] === 'string' ? flags['signature'] : undefined
        await cmdFirmwareUpdate(transport, rest[1]!, sig, json)
        break
      }
      case 'backup':
        if (rest[0] === 'export') {
          await runBackupExport(transport, typeof flags['out'] === 'string' ? flags['out'] : undefined, json)
        } else {
          await runBackupImport(transport, rest[1]!, json)
        }
        break
    }
  } catch (e) {
    if (e instanceof CommandError || e instanceof OtaError || e instanceof UsageError) {
      fail(e.message, e instanceof UsageError ? 2 : 1)
    }
    fail(e instanceof Error ? e.message : String(e))
  } finally {
    await transport.close().catch(() => {})
  }
}

void main()
