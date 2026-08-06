// Web Serial port hygiene.
//
// A previous flash or connect — or an ESP32-S3 native-USB re-enumeration when
// esptool resets the chip — can leave a granted port OPEN and locked in this
// tab. The next open() then fails with "Failed to open serial port" ("port in
// use") until the device is physically unplugged. Proactively closing any open
// granted ports before opening a new one breaks that lock without a replug.

/**
 * A previously-granted port whose device is physically attached right now, or
 * null. Uses `SerialPort.connected` (Chrome 117+); we only trust an explicit
 * `true` — older browsers without the property simply report nothing attached,
 * and the user still has the explicit "Connect by USB cable" button.
 */
export async function findAttachedGrantedPort(): Promise<SerialPort | null> {
  if (typeof navigator === 'undefined' || !('serial' in navigator)) return null
  try {
    const ports = await navigator.serial.getPorts()
    return ports.find((p) => (p as SerialPort & { connected?: boolean }).connected === true) ?? null
  } catch {
    return null
  }
}

/** Close every already-open Web Serial port this tab has been granted.
 *
 *  `port.close()` REJECTS while a stream is still locked — a reader or writer
 *  held by someone else's read loop keeps the lock, the close is swallowed by
 *  the catch, and the port stays open. That is the "port is busy, unplug it"
 *  state. Cancel the streams first so the close can actually succeed. */
export async function releaseGrantedPorts(): Promise<void> {
  if (typeof navigator === 'undefined' || !('serial' in navigator)) return
  try {
    const ports = await navigator.serial.getPorts()
    await Promise.all(
      ports.map(async (p) => {
        // A closed port has null readable/writable; only close open ones.
        if (!p.readable && !p.writable) return
        // Break any outstanding lock. cancel()/abort() on a locked stream
        // throws, so fall back to cancelling through the lock holder's own
        // reader/writer, which is what actually frees it.
        try { await p.readable?.cancel() } catch {
          try {
            const reader = p.readable?.getReader()
            await reader?.cancel()
            reader?.releaseLock()
          } catch { /* already locked elsewhere; close may still succeed */ }
        }
        try { await p.writable?.abort() } catch { /* same */ }
        try {
          await p.close()
        } catch {
          /* already closed, or a stale handle from a re-enumerated device */
        }
      }),
    )
  } catch {
    /* getPorts unsupported, or no granted ports — nothing to release */
  }
}

/**
 * Close granted ports when the page goes away.
 *
 * Without this, navigating away or closing the tab leaves the port OPEN and
 * claimed by the browser process. Every later attempt — a new tab, the CLI,
 * esptool — then fails with "port is busy" until the device is physically
 * unplugged, which is the one recovery a user should never need.
 *
 * `pagehide` rather than `beforeunload`: it fires for bfcache navigations and
 * on mobile, where `beforeunload` is unreliable. The close is best-effort, as
 * unload handlers cannot await, but initiating it is what releases the claim.
 *
 * Idempotent, so callers need not guard against double registration.
 */
let unloadReleaseRegistered = false
export function releasePortsOnUnload(): void {
  if (unloadReleaseRegistered) return
  if (typeof window === 'undefined' || typeof navigator === 'undefined') return
  if (!('serial' in navigator)) return
  unloadReleaseRegistered = true
  window.addEventListener('pagehide', () => { void releaseGrantedPorts() })
}
