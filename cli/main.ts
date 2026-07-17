// Sapwood CLI entry point: sapwood <command> [options].
//
// The management console for the Heartwood signer, at a shell prompt. Talks
// the same frame protocol as the web app over node-serialport; the same
// security model applies — no secrets on this side of the cable, destructive
// operations gated by the device's physical button.

import { readFile } from 'node:fs/promises'
import process from 'node:process'
import { HELP, UsageError, intFlag, parseArgs } from './args.js'
import { NodeSerialTransport, listPorts, pickPort } from './transport.js'
import {
  CommandError,
  cmdApps,
  cmdAppsRevoke,
  cmdDerive,
  cmdDevice,
  cmdIdentities,
  parseSignature,
} from './commands.js'
import type { CommandResult } from './commands.js'
import { OtaError, streamOta } from '../src/lib/ota.js'

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
  switch (command) {
    case 'device':
    case 'identities':
    case 'logs':
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
        printResult(await cmdIdentities(transport, o), json)
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
