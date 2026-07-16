// Live relay health: probe a relay's reachability from the browser and classify
// it red / amber / green, so a user can see which relays are dragging a signer
// down and disable the problem ones. Probing is best-effort and advisory; it
// never blocks connecting, and a relay the browser cannot reach may still work
// for a signer on a different network (shown as a caveat, not a verdict).

export type RelayHealth = 'green' | 'amber' | 'red' | 'unknown'

export interface RelayProbe {
  url: string
  health: RelayHealth
  /** Round-trip to the first response (connect + REQ→EOSE), ms; null if it never answered. */
  ms: number | null
  /** Short reason for amber/red (e.g. 'timeout', 'auth required'), else undefined. */
  note?: string
}

/** Classify a probe outcome. Pure, so it is unit-tested without a socket.
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

const PROBE_TIMEOUT_MS = 6_000

/** Probe one relay: connect, send a tiny REQ, time the first EOSE/EVENT.
 *  Resolves (never rejects) with a classified RelayProbe. */
export function probeRelay(url: string): Promise<RelayProbe> {
  return new Promise((resolve) => {
    const t0 = Date.now()
    let settled = false
    let ws: WebSocket
    const finish = (ms: number | null, failed: boolean, noteOverride?: string) => {
      if (settled) return
      settled = true
      try { ws.close() } catch { /* ignore */ }
      const { health, note } = classifyRelayHealth(ms, failed)
      resolve({ url, health, ms, note: noteOverride ?? note })
    }
    const timer = setTimeout(() => finish(null, true, 'timeout'), PROBE_TIMEOUT_MS)
    try {
      ws = new WebSocket(url)
    } catch {
      clearTimeout(timer)
      return resolve({ url, health: 'red', ms: null, note: 'bad address' })
    }
    ws.onopen = () => {
      // A cheap, universally-served query; any relay answers REQ with EOSE.
      try { ws.send(JSON.stringify(['REQ', 'hw-health', { kinds: [1], limit: 1 }])) } catch { /* ignore */ }
    }
    ws.onmessage = (m) => {
      try {
        const d = JSON.parse(typeof m.data === 'string' ? m.data : '')
        if (d[0] === 'EOSE' || d[0] === 'EVENT') { clearTimeout(timer); finish(Date.now() - t0, false) }
        else if (d[0] === 'NOTICE' || d[0] === 'CLOSED') { clearTimeout(timer); finish(Date.now() - t0, true, String(d[2] ?? d[1] ?? 'refused').slice(0, 40)) }
      } catch { /* ignore non-JSON */ }
    }
    ws.onerror = () => { clearTimeout(timer); finish(null, true, 'connection failed') }
    ws.onclose = () => { clearTimeout(timer); finish(null, true, 'closed early') }
  })
}

/** Probe several relays concurrently. Order of the result matches the input. */
export async function probeRelays(urls: string[]): Promise<RelayProbe[]> {
  return Promise.all(urls.map((u) => probeRelay(u)))
}
