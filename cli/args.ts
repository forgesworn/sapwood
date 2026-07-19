// Argument parsing for the Sapwood CLI. Hand-rolled: the whole grammar is a
// command word, positionals, and a dozen flags — a parser dependency would
// cost more startup time than it saves code.

export class UsageError extends Error {}

const VALUE_FLAGS = new Set(['port', 'parent', 'identity', 'signature', 'timeout', 'baud'])
const BOOL_FLAGS = new Set(['json', 'all', 'help', 'version', 'yes'])

export interface ParsedArgs {
  positionals: string[]
  flags: Partial<Record<string, string | boolean>>
}

export function parseArgs(argv: string[]): ParsedArgs {
  const positionals: string[] = []
  const flags: Partial<Record<string, string | boolean>> = {}
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!
    if (token === '-h') {
      flags['help'] = true
    } else if (token.startsWith('--')) {
      const eq = token.indexOf('=')
      const name = eq === -1 ? token.slice(2) : token.slice(2, eq)
      if (BOOL_FLAGS.has(name)) {
        if (eq !== -1) throw new UsageError(`--${name} takes no value`)
        flags[name] = true
      } else if (VALUE_FLAGS.has(name)) {
        const value = eq !== -1 ? token.slice(eq + 1) : argv[++i]
        if (value === undefined || (eq === -1 && value.startsWith('--'))) {
          throw new UsageError(`--${name} needs a value`)
        }
        flags[name] = value
      } else {
        throw new UsageError(`Unknown option --${name}`)
      }
    } else {
      positionals.push(token)
    }
  }
  return { positionals, flags }
}

/** Parse an integer flag, or throw a usage error naming it. */
export function intFlag(flags: ParsedArgs['flags'], name: string): number | undefined {
  const raw = flags[name]
  if (raw === undefined) return undefined
  const n = Number(raw)
  if (!Number.isInteger(n) || n < 0) throw new UsageError(`--${name} must be a non-negative integer`)
  return n
}

export const HELP = `sapwood: command line console for the Heartwood signer

USAGE
  sapwood <command> [options]

COMMANDS
  ports                       List signer serial ports
  device                      Signer status: firmware, board, identities, apps
  identities                  List identities on the signer
  identities remove <slot>    Remove an identity (typed-name confirmation)
  derive <name>               Derive a new identity on-device
  apps                        List connected apps and their permissions
  apps revoke <slot>          Revoke a connected app's slot
  logs                        Stream the device log (Ctrl-C to stop)
  firmware update <file.bin>  Update firmware over USB (button approval)
  key backup                  Make a 24-word backup of an nsec/ncryptsec (offline)
  operator new                Mint an operator (management) key: phrase, pubkey, secret
  operator restore            Recover the operator key from a phrase (offline)

OPTIONS
  --port <path>       Serial port; auto-detected when one signer is present
  --identity <slot>   Identity slot for app commands (default: the only master)
  --parent <slot>     Parent identity slot for derive (default: the only master)
  --signature <path>  ed25519 release signature for firmware update
                      (<file.bin>.sig is picked up automatically)
  --timeout <ms>      Round-trip timeout (default 10000)
  --baud <rate>       Serial baud rate (default 115200)
  --all               ports: include non-signer serial ports
  --yes               identities remove: skip the typed-name confirmation
  --json              Machine-readable output
  -h, --help          Show this help
  --version           Show the version

The signer's secrets never travel over this connection. Destructive
operations require the physical button on the device. 'key backup' works
offline on a key you supply and never opens the device.

Backup and restore guide:
https://github.com/forgesworn/sapwood/blob/main/docs/backup-and-restore.md`
