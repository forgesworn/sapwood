import { describe, it, expect } from 'vitest'
import { generateBridgeSecret, bridgeArtifacts } from './bridge-setup'

// A valid-shaped 32-byte secret, built programmatically so no 64-char hex
// literal appears in the source (the repo's check-in guard flags those).
const SECRET = 'ab'.repeat(32)

describe('generateBridgeSecret', () => {
  it('returns 64 lowercase hex characters (32 bytes)', () => {
    expect(generateBridgeSecret()).toMatch(/^[0-9a-f]{64}$/)
  })

  it('is random — two calls differ', () => {
    expect(generateBridgeSecret()).not.toBe(generateBridgeSecret())
  })
})

describe('bridgeArtifacts', () => {
  const cfg = { devicePort: '/dev/ttyUSB0', secretHex: SECRET, relays: ['wss://relay.trotters.cc'] }

  it('marks the master as an HSM signer on the host port', () => {
    expect(bridgeArtifacts(cfg).masterPayload).toBe('hsm:/dev/ttyUSB0')
  })

  it('writes the relays into config.json', () => {
    const { configJson } = bridgeArtifacts(cfg)
    expect(JSON.parse(configJson)).toEqual({ relays: ['wss://relay.trotters.cc'] })
  })

  it('defaults the data dir and threads it through every file + the run command', () => {
    const a = bridgeArtifacts(cfg)
    expect(a.dataDir).toBe('/var/lib/heartwood/esp8266')
    expect(a.setupScript).toContain('/var/lib/heartwood/esp8266/master.payload')
    expect(a.setupScript).toContain('/var/lib/heartwood/esp8266/bridge.secret')
    expect(a.setupScript).toContain('/var/lib/heartwood/esp8266/config.json')
    expect(a.setupScript).toContain(SECRET)
    expect(a.runCommand).toContain('HEARTWOOD_DATA_DIR=/var/lib/heartwood/esp8266')
    expect(a.runCommand).toContain('heartwood-bridge')
  })

  it('honours a custom data dir', () => {
    const a = bridgeArtifacts({ ...cfg, dataDir: '/srv/hw/sign1' })
    expect(a.masterPayload).toBe('hsm:/dev/ttyUSB0')
    expect(a.setupScript).toContain('/srv/hw/sign1/master.payload')
    expect(a.runCommand).toContain('HEARTWOOD_DATA_DIR=/srv/hw/sign1')
  })

  it('trims + drops blank relays', () => {
    const a = bridgeArtifacts({ ...cfg, relays: ['  wss://a.example  ', '', 'wss://b.example'] })
    expect(JSON.parse(a.configJson)).toEqual({ relays: ['wss://a.example', 'wss://b.example'] })
  })

  it('rejects a malformed secret', () => {
    expect(() => bridgeArtifacts({ ...cfg, secretHex: 'deadbeef' })).toThrow(/64 lowercase hex/)
  })

  it('rejects an empty relay list', () => {
    expect(() => bridgeArtifacts({ ...cfg, relays: [] })).toThrow(/at least one relay/)
  })

  it('rejects an empty host port', () => {
    expect(() => bridgeArtifacts({ ...cfg, devicePort: '  ' })).toThrow(/serial port is required/)
  })
})
