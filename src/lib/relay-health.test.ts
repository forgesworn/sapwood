import { afterEach, describe, expect, it, vi } from 'vitest'
import { classifyRelayHealth, classifyWriteReply, GATED_NOTE, probeRelay } from './relay-health.js'

describe('classifyRelayHealth', () => {
  it('marks a failure or no-answer red', () => {
    expect(classifyRelayHealth(null, true)).toEqual({ health: 'red', note: 'unreachable' })
    expect(classifyRelayHealth(null, false)).toEqual({ health: 'red', note: 'unreachable' })
    expect(classifyRelayHealth(1234, true)).toEqual({ health: 'red', note: 'unreachable' })
  })

  it('marks a prompt answer green', () => {
    expect(classifyRelayHealth(120, false)).toEqual({ health: 'green' })
    expect(classifyRelayHealth(799, false)).toEqual({ health: 'green' })
  })

  it('marks a slow answer amber', () => {
    expect(classifyRelayHealth(800, false)).toEqual({ health: 'amber', note: 'slow' })
    expect(classifyRelayHealth(3999, false)).toEqual({ health: 'amber', note: 'slow' })
  })

  it('marks a very slow answer red', () => {
    expect(classifyRelayHealth(4000, false)).toEqual({ health: 'red', note: 'very slow' })
    expect(classifyRelayHealth(9000, false)).toEqual({ health: 'red', note: 'very slow' })
  })
})

describe('classifyWriteReply', () => {
  it('reads "invalid:" as proof the write path answers', () => {
    expect(classifyWriteReply('invalid: event id is wrong')).toEqual({ health: 'green' })
    expect(classifyWriteReply('invalid: event creation date is too far off')).toEqual({ health: 'green' })
  })

  it('reads ban and rate-limit words as red, with the relay\'s own words kept', () => {
    expect(classifyWriteReply('banned: too many rate-limit violations, try again later'))
      .toEqual({ health: 'red', note: 'writes refused: banned: too many rate-limit violations, ' })
    expect(classifyWriteReply('rate-limited: slow down').health).toBe('red')
    expect(classifyWriteReply('blocked: too many requests').health).toBe('red')
  })

  it('reads the NIP-42 gate as alive, not a failure', () => {
    expect(classifyWriteReply('auth-required: this relay is private; sign in with an allowed key'))
      .toEqual({ health: 'amber', note: GATED_NOTE })
  })

  it('does not claim green for any other refusal', () => {
    expect(classifyWriteReply('blocked: pubkey not on the allowlist'))
      .toEqual({ health: 'amber', note: 'writes answered: blocked: pubkey not on the allowlist' })
    expect(classifyWriteReply('restricted: paid relay').health).toBe('amber')
  })
})

/** A stub WebSocket (runtime only; the production type stays the DOM one) that
 *  answers the probe's REQ and EVENT frames from a script keyed by frame type. */
class FakeSocket {
  static script: { onReq?: unknown[][]; onEvent?: unknown[][]; closeAfterReq?: boolean } = {}
  readonly sent: string[] = []
  onopen: (() => void) | null = null
  onmessage: ((ev: { data: string }) => void) | null = null
  onerror: (() => void) | null = null
  onclose: (() => void) | null = null
  constructor(_url: string | URL) {
    queueMicrotask(() => this.onopen?.())
  }
  send(frame: string) {
    this.sent.push(frame)
    const msg = JSON.parse(frame) as unknown[]
    const frames = msg[0] === 'REQ' ? (FakeSocket.script.onReq ?? []) : (FakeSocket.script.onEvent ?? [])
    for (const reply of frames) queueMicrotask(() => this.onmessage?.({ data: JSON.stringify(reply) }))
    if (msg[0] === 'REQ' && FakeSocket.script.closeAfterReq) queueMicrotask(() => this.onclose?.())
  }
  close() { /* settling side */ }
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
  FakeSocket.script = {}
})

describe('probeRelay', () => {
  it('marks a relay green when it answers the read and rejects the invalid event as invalid', async () => {
    FakeSocket.script = {
      onReq: [['EOSE', 'hw-health']],
      onEvent: [['OK', '0'.repeat(64), false, 'invalid: event id is wrong']],
    }
    vi.stubGlobal('WebSocket', FakeSocket)
    await expect(probeRelay('wss://healthy.test')).resolves.toEqual({
      url: 'wss://healthy.test', health: 'green', ms: expect.any(Number), note: undefined,
    })
  })

  it('marks a write-banned address red with the relay\'s own words, however fast the read', async () => {
    FakeSocket.script = {
      onReq: [['EOSE', 'hw-health']],
      onEvent: [['OK', '0'.repeat(64), false, 'banned: too many rate-limit violations, try again later']],
    }
    vi.stubGlobal('WebSocket', FakeSocket)
    const probe = await probeRelay('wss://banned.test')
    expect(probe.health).toBe('red')
    expect(probe.note).toMatch(/^writes refused: banned:/)
  })

  it('marks a sign-in gated relay amber, never a failure', async () => {
    FakeSocket.script = {
      onReq: [['AUTH', 'challenge'], ['CLOSED', 'hw-health', 'auth-required: this relay is private; sign in with an allowed key']],
    }
    vi.stubGlobal('WebSocket', FakeSocket)
    await expect(probeRelay('wss://ours.test')).resolves.toMatchObject({ health: 'amber', note: GATED_NOTE })
  })

  it('marks a read answered but a write never returned as writes unanswered', async () => {
    FakeSocket.script = { onReq: [['EOSE', 'hw-health']] }
    vi.stubGlobal('WebSocket', FakeSocket)
    vi.useFakeTimers()
    const probe = probeRelay('wss://half.test')
    await vi.advanceTimersByTimeAsync(50)
    await vi.advanceTimersByTimeAsync(6_000)
    await expect(probe).resolves.toMatchObject({ health: 'amber', note: 'writes unanswered' })
  })

  it('marks a relay that accepts the invalid event as suspect, not green', async () => {
    FakeSocket.script = {
      onReq: [['EOSE', 'hw-health']],
      onEvent: [['OK', '0'.repeat(64), true, '']],
    }
    vi.stubGlobal('WebSocket', FakeSocket)
    await expect(probeRelay('wss://leaky.test')).resolves.toMatchObject({ health: 'amber', note: 'accepted an invalid event' })
  })
})
