// Live relay health: probe a relay from the browser and classify it
// red / amber / green, so a user can see which relays are dragging a signer
// down and disable the problem ones. Two stages, because the faults that
// matter look nothing like each other:
//
//   1. Read: connect, send a tiny REQ, time the first EOSE/EVENT.
//   2. Write admission: send one deliberately invalid event and read the
//      relay's `OK false` reason back. "invalid: ..." is the healthy answer:
//      it proves the write pipeline answers. A banned or throttled address
//      hears "banned: ..." or "rate-limited: ..." instead (relay.damus.io
//      read as green here for days while refusing every write), and a
//      NIP-42-gated relay, such as an operator's own, closes the read with
//      "auth-required: ...", which is the relay working, not failing.
//
// Probing is best-effort and advisory; it never blocks connecting, and a
// relay the browser cannot reach may still work for a signer on a different
// network (shown as a caveat, not a verdict). The write probe is unsigned
// and stores nothing: relays reject the event at validation.

export type RelayHealth = 'green' | 'amber' | 'red' | 'unknown'

export interface RelayProbe {
  url: string
  health: RelayHealth
  /** Round-trip to the first read answer (connect + REQ→EOSE), ms; null if it never answered. */
  ms: number | null
  /** Short reason for amber/red (e.g. 'timeout', 'asks for an allowed key'), else undefined. */
  note?: string
}

/** Worse of two verdicts: the relay's write admission outweighs a fast read. */
function worse(a: RelayHealth, b: RelayHealth): RelayHealth {
  const rank: Record<RelayHealth, number> = { unknown: 0, green: 1, amber: 2, red: 3 }
  return rank[b] > rank[a] ? b : a
}

/** Classify the connect+read stage. Pure, so it is unit-tested without a socket.
 *  green:  answered promptly (< 800 ms)
 *  amber:  answered, but slowly (< 4 s) — usable, not ideal
 *  red:    failed, or took longer than the ceiling
 *  Thresholds are deliberately generous: a signer tolerates more latency than a
 *  browser probe, so only a clearly bad relay is marked red. */
export function classifyRelayHealth(ms: number | null, failed: boolean): { health: RelayHealth; note?: string } {
  if (failed || ms === null) return { health: 'red', note: 'unreachable' }
  if (ms < 800) return { health: 'green' }
  if (ms < 4_000) return { health: 'amber', note: 'slow' }
  return { health: 'red', note: 'very slow' }
}

/** The relay is alive and answering, but gates requests behind NIP-42
 *  sign-in, as an operator's own relay does: healthy for a signer whose key
 *  is allowed, useless to an anonymous browser probe. Not red. */
export const GATED_NOTE = 'asks for an allowed key'

/** Classify the relay's answer to publishing one deliberately invalid event,
 *  from its `OK false` reason. Pure, so it is unit-tested without a socket.
 *  `invalid:` is the healthy answer: the write path answered. banned and
 *  rate-limit words are red, the failure a signer cannot work around from
 *  this address. auth-required is the NIP-42 gate again, not a failure. */
export function classifyWriteReply(reason: string): { health: RelayHealth; note?: string } {
  const m = reason.toLowerCase().trim()
  if (m.includes('banned') || m.includes('rate-limit') || m.includes('rate limit') || m.includes('too many'))
    return { health: 'red', note: `writes refused: ${reason.trim().slice(0, 40)}` }
  if (m.startsWith('auth-required')) return { health: 'amber', note: GATED_NOTE }
  if (m.startsWith('invalid')) return { health: 'green' }
  return { health: 'amber', note: `writes answered: ${reason.trim().slice(0, 40)}` }
}

/** One well-formed but deliberately invalid event (zeroed id/pubkey/signature,
 *  epoch timestamp): every relay rejects it at validation with an `OK false`,
 *  which is the write-admission signal. Never signed, never stored. */
const PROBE_EVENT = {
  id: '0'.repeat(64),
  pubkey: '0'.repeat(64),
  sig: '0'.repeat(128),
  kind: 1,
  created_at: 1,
  tags: [] as string[][],
  content: '',
}

const PROBE_TIMEOUT_MS = 6_000

/** Probe one relay. Resolves (never rejects) with a classified RelayProbe. */
export function probeRelay(url: string): Promise<RelayProbe> {
  return new Promise((resolve) => {
    const t0 = Date.now()
    let settled = false
    let ws: WebSocket
    /** First read answer (EOSE/EVENT) time, or null; also the stage marker:
     *  once it is set the write probe is in flight. */
    let readMs: number | null = null
    const done = (outcome: { health: RelayHealth; note?: string }) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try { ws.close() } catch { /* ignore */ }
      resolve({ url, health: outcome.health, ms: readMs, note: outcome.note })
    }
    const failed = (ms: number | null, note?: string) => {
      const c = classifyRelayHealth(ms, true)
      done({ health: c.health, note: note ?? c.note })
    }
    const timer = setTimeout(() => {
      if (readMs === null) failed(null, 'timeout')
      else done({ health: 'amber', note: 'writes unanswered' })
    }, PROBE_TIMEOUT_MS)
    try {
      ws = new WebSocket(url)
    } catch {
      clearTimeout(timer)
      return resolve({ url, health: 'red', ms: null, note: 'bad address' })
    }
    ws.onopen = () => {
      // A cheap, universally-served query; any relay answers REQ with EOSE.
      try { ws.send(JSON.stringify(['REQ', 'hw-health', { kinds: [1], limit: 1 }])) } catch { /* the error handler reports */ }
    }
    ws.onmessage = (m) => {
      let d: unknown
      try { d = JSON.parse(typeof m.data === 'string' ? m.data : '') } catch { return }
      if (!Array.isArray(d)) return
      if (d[0] === 'AUTH') return // NIP-42 challenge: the relay is alive; the REQ's fate decides.
      if (d[0] === 'EOSE' || d[0] === 'EVENT') {
        if (readMs !== null) return
        readMs = Date.now() - t0
        // The read answered: now read the write path back.
        try { ws.send(JSON.stringify(['EVENT', PROBE_EVENT])) } catch { /* the error handler reports */ }
        return
      }
      if (d[0] === 'OK' && readMs !== null && d[1] === PROBE_EVENT.id) {
        const latency = classifyRelayHealth(readMs, false)
        if (d[2] === true) {
          done({ health: worse(latency.health, 'amber'), note: latency.note ?? 'accepted an invalid event' })
        } else {
          const write = classifyWriteReply(typeof d[3] === 'string' ? d[3] : '')
          done({ health: worse(latency.health, write.health), note: write.note ?? latency.note })
        }
        return
      }
      if (d[0] === 'CLOSED') {
        const reason = String(d[2] ?? 'refused')
        if (/^auth-required/i.test(reason)) {
          const latency = readMs === null ? null : classifyRelayHealth(readMs, false)
          done({ health: latency === null ? 'amber' : worse(latency.health, 'amber'), note: GATED_NOTE })
        } else {
          failed(readMs, reason.slice(0, 40))
        }
        return
      }
      if (d[0] === 'NOTICE') {
        const reason = String(d[1] ?? 'refused')
        // Rate words while we hold only a read open still name a ban in waiting.
        if (/rate|too many|banned/i.test(reason)) done({ health: 'red', note: `writes refused: ${reason.slice(0, 33)}` })
        else failed(readMs ?? Date.now() - t0, reason.slice(0, 40))
      }
    }
    ws.onerror = () => failed(null, 'connection failed')
    ws.onclose = () => {
      if (readMs === null) failed(null, 'closed early')
      else done({ health: 'amber', note: 'writes unanswered' })
    }
  })
}

/** Probe several relays concurrently. Order of the result matches the input. */
export async function probeRelays(urls: string[]): Promise<RelayProbe[]> {
  return Promise.all(urls.map((u) => probeRelay(u)))
}
