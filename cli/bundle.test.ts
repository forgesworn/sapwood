// The built bundle, spawned as a user would run it. Hardware-free paths only;
// the build itself is part of the test (esbuild, ~15ms).

import { execFile, execFileSync } from 'node:child_process'
import { promisify } from 'node:util'
import { beforeAll, describe, expect, it } from 'vitest'
import { nip19 } from 'nostr-tools'

const run = promisify(execFile)
const BUNDLE = 'dist-cli/sapwood.mjs'

async function sapwood(...args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await run('node', [BUNDLE, ...args], { cwd: process.cwd() })
    return { code: 0, stdout, stderr }
  } catch (e) {
    const err = e as { code?: number; stdout?: string; stderr?: string }
    return { code: err.code ?? 1, stdout: err.stdout ?? '', stderr: err.stderr ?? '' }
  }
}

/** Run the bundle with `input` on stdin, synchronously (so stdin gets EOF). */
function sapwoodStdin(input: string, ...args: string[]): { code: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync('node', [BUNDLE, ...args], { input, encoding: 'utf8' })
    return { code: 0, stdout, stderr: '' }
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string }
    return { code: err.status ?? 1, stdout: err.stdout ?? '', stderr: err.stderr ?? '' }
  }
}

beforeAll(async () => {
  await run('node', ['scripts/build-cli.mjs'], { cwd: process.cwd() })
}, 30_000)

describe('sapwood bundle', () => {
  it('prints help and exits 0', async () => {
    const r = await sapwood('--help')
    expect(r.code).toBe(0)
    expect(r.stdout).toContain('USAGE')
    expect(r.stdout).toContain('firmware update')
  })

  it('prints the package version', async () => {
    const r = await sapwood('--version')
    expect(r.code).toBe(0)
    expect(r.stdout.trim()).toMatch(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/)
  })

  it('help with no command at all', async () => {
    const r = await sapwood()
    expect(r.code).toBe(0)
    expect(r.stdout).toContain('USAGE')
  })

  it('rejects an unknown command with exit 2', async () => {
    const r = await sapwood('frobnicate')
    expect(r.code).toBe(2)
    expect(r.stderr).toContain("unknown command 'frobnicate'")
  })

  it('rejects an unknown option with exit 2', async () => {
    const r = await sapwood('device', '--frobnicate')
    expect(r.code).toBe(2)
    expect(r.stderr).toContain('--frobnicate')
  })

  it('demands a valid slot for identities remove', async () => {
    const r = await sapwood('identities', 'remove', 'x')
    expect(r.code).toBe(2)
    expect(r.stderr).toContain('usage: sapwood identities remove')
  })

  it('demands a name for derive', async () => {
    const r = await sapwood('derive', '--port', '/dev/null')
    expect(r.code).toBe(2)
    expect(r.stderr).toContain('usage: sapwood derive')
  })

  it('lists ports as JSON without error', async () => {
    const r = await sapwood('ports', '--json')
    expect(r.code).toBe(0)
    expect(Array.isArray(JSON.parse(r.stdout))).toBe(true)
  })

  it('rejects an unknown key subcommand with exit 2', async () => {
    const r = await sapwood('key', 'wat')
    expect(r.code).toBe(2)
    expect(r.stderr).toContain('usage: sapwood key backup')
  })

  it('makes typed recovery words from an nsec on stdin, no device', () => {
    const secret = new Uint8Array(32)
    secret[31] = 1
    const nsec = nip19.nsecEncode(secret)
    const r = sapwoodStdin(`${nsec}\n`, 'key', 'backup')
    expect(r.code).toBe(0)
    expect(r.stdout).toContain('ForgeSworn recovery words v1')
    expect(r.stdout).toContain('diesel')
  })

  it('emits the words as JSON on request', () => {
    const secret = new Uint8Array(32)
    secret[31] = 1
    const nsec = nip19.nsecEncode(secret)
    const r = sapwoodStdin(`${nsec}\n`, 'key', 'backup', '--json')
    expect(r.code).toBe(0)
    const parsed = JSON.parse(r.stdout) as { words: string[] }
    expect(parsed.words).toHaveLength(31)
    expect(parsed.words[30]).toBe('diesel')
  })

  it('fails clearly when no key is piped in', () => {
    const r = sapwoodStdin('', 'key', 'backup')
    expect(r.code).toBe(1)
    expect(r.stderr).toContain('No key given')
  })

  it('rejects an unknown operator subcommand with exit 2', async () => {
    const r = await sapwood('operator', 'wat')
    expect(r.code).toBe(2)
    expect(r.stderr).toContain('usage: sapwood operator')
  })

  it('mints a new operator key as JSON, no device', async () => {
    const r = await sapwood('operator', 'new', '--json')
    expect(r.code).toBe(0)
    const parsed = JSON.parse(r.stdout) as { mnemonic: string; pubHex: string; skHex: string }
    expect(parsed.mnemonic.split(' ')).toHaveLength(12)
    expect(parsed.pubHex).toMatch(/^[0-9a-f]{64}$/)
    expect(parsed.skHex).toMatch(/^[0-9a-f]{64}$/)
  })

  it('restores the pinned operator key from a phrase on stdin', () => {
    const canonical = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
    const pub = 'e8bcf3823669444d0b49ad45d65088635d9fd8500a75b5f20b59abefa56a144f'
    const r = sapwoodStdin(`${canonical}\n`, 'operator', 'restore', '--json')
    expect(r.code).toBe(0)
    expect((JSON.parse(r.stdout) as { pubHex: string }).pubHex).toBe(pub)
  })

  it('fails clearly when no phrase is piped to operator restore', () => {
    const r = sapwoodStdin('', 'operator', 'restore')
    expect(r.code).toBe(1)
    expect(r.stderr).toContain('No phrase given')
  })

  it('rejects an unknown backup subcommand with exit 2', async () => {
    const r = await sapwood('backup', 'wat')
    expect(r.code).toBe(2)
    expect(r.stderr).toContain('usage: sapwood backup')
  })

  it('demands a file for backup import', async () => {
    const r = await sapwood('backup', 'import')
    expect(r.code).toBe(2)
    expect(r.stderr).toContain('usage: sapwood backup import')
  })
})
