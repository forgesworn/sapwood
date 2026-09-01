// Node serial transport for the Sapwood CLI.
//
// Speaks the Heartwood frame protocol over a serialport connection, reusing
// the same byte-stream splitter and UART write pacing as the web app. The
// serialport module is imported lazily so --help, --version and unit tests
// never load a native module.

import { FrameStream } from '../src/lib/frame-stream.js'
import { paceSlices } from '../src/lib/pacing.js'
import type { Frame, FrameTypeValue } from '../src/lib/frame.js'

/** The slice of node-serialport the transport uses; tests fake this. */
export interface PortLike {
  write(data: Uint8Array, cb: (err?: Error | null) => void): unknown
  drain(cb: (err?: Error | null) => void): unknown
  close(cb: (err?: Error | null) => void): unknown
  on(event: 'data' | 'close' | 'error', listener: (arg?: unknown) => void): unknown
}

export interface PortCandidate {
  path: string
  vendorId?: string
  productId?: string
  manufacturer?: string
}

// Same devices the web app's port chooser filters for: ESP32-S3
// USB-Serial-JTAG (Espressif), and the WCH / Silicon Labs / FTDI UART
// bridges on tethered boards.
const KNOWN_VENDORS = new Set(['303a', '1a86', '10c4', '0403'])

interface RawPortInfo {
  path: string
  vendorId?: string
  productId?: string
  manufacturer?: string
}

/** Normalise a port listing: filter to known signer hardware unless `all`. */
export function toCandidates(ports: RawPortInfo[], platform: string, all: boolean): PortCandidate[] {
  const mapped: PortCandidate[] = ports.map((p) => ({
    // macOS: open the call-up device, not the modem-style tty (which blocks
    // waiting for carrier detect).
    path: platform === 'darwin' ? p.path.replace('/dev/tty.', '/dev/cu.') : p.path,
    ...(p.vendorId ? { vendorId: p.vendorId.toLowerCase() } : {}),
    ...(p.productId ? { productId: p.productId.toLowerCase() } : {}),
    ...(p.manufacturer ? { manufacturer: p.manufacturer } : {}),
  }))
  return all ? mapped : mapped.filter((p) => p.vendorId && KNOWN_VENDORS.has(p.vendorId))
}

/** List serial ports, filtered to known signer hardware unless `all`. */
export async function listPorts(all = false): Promise<PortCandidate[]> {
  const { SerialPort } = await import('serialport')
  return toCandidates(await SerialPort.list(), process.platform, all)
}

/** Pick the port to open: an explicit choice wins; otherwise exactly one
 *  candidate must exist. Throws a message ready for the terminal. */
export function pickPort(candidates: PortCandidate[], explicit: string | undefined): string {
  if (explicit) return explicit
  if (candidates.length === 1) return candidates[0]!.path
  if (candidates.length === 0) {
    throw new Error('no signer found. Plug the device in, or pass --port <path>. `sapwood ports --all` lists every serial port.')
  }
  throw new Error(`several possible signers found. Pass --port <path>:\n${candidates.map((c) => `  ${c.path}${c.manufacturer ? `  (${c.manufacturer})` : ''}`).join('\n')}`)
}

export type TransportEvent =
  | { kind: 'frame'; frame: Frame }
  | { kind: 'log'; line: string }
  | { kind: 'error'; message: string }
  | { kind: 'close' }

export class NodeSerialTransport {
  private listeners: Array<(e: TransportEvent) => void> = []
  private closed = false
  private closePromise: Promise<void> | null = null
  // Round trips are serialised: frames carry no request id, so overlapping
  // requests could each claim the other's response.
  private chain: Promise<unknown> = Promise.resolve()
  private stream = new FrameStream({
    onFrame: (frame) => this.emit({ kind: 'frame', frame }),
    onLog: (line) => this.emit({ kind: 'log', line }),
  })

  private constructor(private readonly port: PortLike) {}

  /** Wrap an already-open port (tests, or a custom transport). */
  static wrap(port: PortLike): NodeSerialTransport {
    const t = new NodeSerialTransport(port)
    port.on('data', (chunk) => {
      const buf = chunk as Buffer
      t.stream.feed(new Uint8Array(buf.buffer, buf.byteOffset, buf.length))
    })
    port.on('close', () => {
      t.closed = true
      t.emit({ kind: 'close' })
    })
    port.on('error', (e) => t.emit({ kind: 'error', message: e instanceof Error ? e.message : String(e) }))
    return t
  }

  /** Open a serial port and start splitting its byte stream. */
  static async open(path: string, baudRate = 115200): Promise<NodeSerialTransport> {
    const { SerialPort } = await import('serialport')
    return new Promise((resolve, reject) => {
      const port = new SerialPort({ path, baudRate, autoOpen: false })
      const t = NodeSerialTransport.wrap(port as unknown as PortLike)
      port.open((err) => {
        if (err) reject(new Error(`Could not open ${path}: ${err.message}`))
        else resolve(t)
      })
    })
  }

  /** Subscribe to transport events. Returns an unsubscribe function. */
  on(listener: (e: TransportEvent) => void): () => void {
    this.listeners.push(listener)
    return () => {
      this.listeners = this.listeners.filter((l) => l !== listener)
    }
  }

  private emit(event: TransportEvent) {
    for (const listener of this.listeners) {
      try { listener(event) } catch { /* listener errors must not break the stream */ }
    }
  }

  /** Write raw bytes, paced so UART-bridge boards don't overrun (pacing.ts). */
  async write(data: Uint8Array): Promise<void> {
    for (const { bytes, gapMs } of paceSlices(data)) {
      await new Promise<void>((resolve, reject) => {
        this.port.write(bytes, (err) => {
          if (err) return reject(err)
          this.port.drain((drainErr) => (drainErr ? reject(drainErr) : resolve()))
        })
      })
      if (gapMs > 0) await new Promise((r) => setTimeout(r, gapMs))
    }
  }

  /** Send a frame and wait for a response with one of the expected types. */
  sendAndReceive(
    frameBytes: Uint8Array,
    expectedTypes: FrameTypeValue[],
    timeoutMs = 30_000,
  ): Promise<Frame> {
    const run = this.chain.then(() => this.roundTrip(frameBytes, [...expectedTypes], timeoutMs))
    this.chain = run.then(() => {}, () => {})
    return run
  }

  private roundTrip(
    frameBytes: Uint8Array,
    expectedTypes: FrameTypeValue[],
    timeoutMs: number,
  ): Promise<Frame> {
    return new Promise<Frame>((resolve, reject) => {
      // The close event may predate this round trip (port gone before the
      // queue reached it); without the check it would wait out the timeout.
      if (this.closed) return reject(new Error('Device disconnected'))
      let settled = false
      let unsub = () => {}
      const finish = (result: { frame: Frame } | { error: Error }) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        unsub()
        if ('frame' in result) resolve(result.frame)
        else reject(result.error)
      }
      const timer = setTimeout(() => {
        if (settled) return

        // The protocol has no request IDs. A response arriving after this
        // timeout could otherwise satisfy the next queued command when both
        // expect a generic ACK/NACK. Close the port before rejecting so the
        // promise chain cannot advance on the ambiguous session.
        settled = true
        unsub()
        const error = new Error('No response from the device. The serial session was closed so a late reply cannot be mistaken for another operation.')
        void this.close().then(() => reject(error))
      }, timeoutMs)
      unsub = this.on((event) => {
        if (event.kind === 'frame' && expectedTypes.includes(event.frame.type)) {
          finish({ frame: event.frame })
        } else if (event.kind === 'close') {
          finish({ error: new Error('Device disconnected') })
        }
      })
      this.write(frameBytes).catch((error) => {
        finish({ error: error instanceof Error ? error : new Error(String(error)) })
      })
    })
  }

  async close(): Promise<void> {
    if (this.closePromise) return this.closePromise
    if (this.closed) return
    this.closed = true
    this.stream.reset()
    this.closePromise = new Promise<void>((resolve) => this.port.close(() => resolve()))
    await this.closePromise
  }
}
