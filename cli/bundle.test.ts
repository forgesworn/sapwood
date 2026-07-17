// The built bundle, spawned as a user would run it. Hardware-free paths only;
// the build itself is part of the test (esbuild, ~15ms).

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { beforeAll, describe, expect, it } from 'vitest'

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
    expect(r.stdout.trim()).toMatch(/^\d+\.\d+\.\d+$/)
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
})
