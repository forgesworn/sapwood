// Web Serial transport layer for Heartwood ESP32.
//
// Connects to the ESP32 via USB-Serial-JTAG using the Web Serial API.
// Reads incoming bytes, hunts for frame magic, and emits parsed frames.
// Non-frame bytes (ESP-IDF log output) are emitted as log lines.

import type { Frame, FrameTypeValue } from './frame.js'
import { FrameStream } from './frame-stream.js'
import { paceSlices } from './pacing.js'
import { releaseGrantedPorts, releasePortsOnUnload } from './serial-ports.js'

export type SerialEvent =
  | { kind: 'connected'; port: string }
  | { kind: 'disconnected' }
  | { kind: 'frame'; frame: Frame }
  | { kind: 'log'; line: string }
  | { kind: 'error'; message: string }

export type SerialListener = (event: SerialEvent) => void

interface SerialRequest {
  frameBytes: Uint8Array
  expectedTypes: FrameTypeValue[]
  timeoutMs: number
  resolve: (frame: Frame) => void
  reject: (error: Error) => void
  /** Installed only while this request owns the response listener. */
  cancel?: (error: Error) => void
}

/** Web Serial connection to the ESP32. */
export class SerialTransport {
  private port: SerialPort | null = null
  private reader: ReadableStreamDefaultReader<Uint8Array> | null = null
  private running = false
  private listeners: SerialListener[] = []
  // Writes are serialised through this chain. getWriter() throws if the writable
  // is still locked by a previous (possibly stalled) write, so two overlapping
  // writes — e.g. refreshMasters racing refreshSlots on connect — would otherwise
  // fail with "Cannot create writer when WritableStream is locked".
  private writeChain: Promise<void> = Promise.resolve()

  // A frame has no request id, and most mutations share the same ACK/NACK
  // response types. Serialising writes alone is therefore insufficient: two
  // overlapping sendAndReceive calls would both observe one ACK and both report
  // success. Keep exactly one response listener active and queue complete
  // request/response lifecycles behind it.
  private requestQueue: SerialRequest[] = []
  private activeRequest: SerialRequest | null = null
  private requestDraining = false

  // Splits the raw byte stream into frames and log lines.
  private stream = new FrameStream({
    onFrame: (frame) => this.emit({ kind: 'frame', frame }),
    onLog: (line) => this.emit({ kind: 'log', line }),
  })

  get connected(): boolean {
    return this.port !== null && this.running
  }

  /** Subscribe to transport events. Returns an unsubscribe function. */
  on(listener: SerialListener): () => void {
    this.listeners.push(listener)
    return () => {
      this.listeners = this.listeners.filter(l => l !== listener)
    }
  }

  private emit(event: SerialEvent) {
    for (const listener of this.listeners) {
      try { listener(event) } catch { /* listener errors must not break the read loop */ }
    }
  }

  /** Connect to a serial port — asking the user to pick one, or using a
   *  specific already-granted port (e.g. detected on the cable) when given. */
  async connect(baudRate = 115200, existingPort?: SerialPort): Promise<void> {
    try {
      // requestPort FIRST. Any teardown of a previous session must happen AFTER
      // this — its awaits would otherwise consume the click's user gesture and
      // Chrome would reject requestPort. This is also what lets the error
      // banner's "Reconnect" work in a single click while still "connected".
      // (A provided port needs no gesture, so it skips the chooser entirely.)
      const port = existingPort ?? await navigator.serial.requestPort({
        filters: [
          // ESP32-S3 USB-Serial-JTAG
          { usbVendorId: 0x303a, usbProductId: 0x1001 },
          // USB-UART bridges used by the tethered ESP8266 (and CH9102 boards like
          // the T-Display): WCH CH34x, Silicon Labs CP210x, FTDI. Vendor-only so
          // any product id from them appears in the picker.
          { usbVendorId: 0x1a86 },
          { usbVendorId: 0x10c4 },
          { usbVendorId: 0x0403 },
        ],
      })

      // Tear down a previous session now (gesture already captured). Quiet — no
      // 'disconnected' emit, so the UI transitions straight into the new session
      // instead of flashing back to the picker.
      if (this.port) {
        this.cancelRequests(new Error('Disconnected'))
        this.running = false
        try { await this.reader?.cancel() } catch { /* ignore */ }
        try { this.reader?.releaseLock() } catch { /* ignore */ }
        this.reader = null
        if (this.port !== port) {
          try { await this.port.close() } catch { /* ignore */ }
        }
        this.port = null
      }

      // Close any port left open by a previous flash/connect (or an ESP32-S3 USB
      // re-enumeration) so open() below doesn't fail with "port in use". Done
      // AFTER requestPort so its awaits don't consume the click's user gesture.
      await releaseGrantedPorts()

      // If the port still reports open, reuse it; otherwise open it fresh.
      if (!port.readable) {
        try {
          await port.open({ baudRate, bufferSize: 4096 })
        } catch (openErr) {
          const msg = openErr instanceof Error ? openErr.message : String(openErr)
          if (msg.includes('Failed to open')) {
            throw new Error('The device port is busy. Unplug the device, plug it back in, then try again.')
          }
          throw openErr
        }
      }
      this.port = port
      this.running = true
      this.stream.reset()
      this.writeChain = Promise.resolve() // fresh write queue for this session

      const info = port.getInfo()
      this.emit({
        kind: 'connected',
        port: `USB ${info.usbVendorId?.toString(16) ?? '?'}:${info.usbProductId?.toString(16) ?? '?'}`,
      })

      // Start the read loop (fire and forget -- errors handled internally).
      this.readLoop()
    } catch (e) {
      this.emit({ kind: 'error', message: e instanceof Error ? e.message : 'Connection failed' })
      // A failed reconnect may have already torn down the old session, leaving us
      // portless. Reflect that so the UI drops to a clean "connect" state rather
      // than appearing connected with no working port.
      if (!this.port) {
        this.cancelRequests(new Error('Disconnected'))
        this.running = false
        this.emit({ kind: 'disconnected' })
      }
    }
  }

  /** Tear down one serial session and reject everything that still belongs to
   *  it. `error` distinguishes an ordinary disconnect from a protocol timeout,
   *  where the late reply makes this no-request-ID stream unsafe to reuse. */
  private async closeSession(error: Error): Promise<void> {
    this.cancelRequests(error)
    this.running = false
    try {
      if (this.reader) {
        try { await this.reader.cancel() } catch { /* ignore */ }
        try { this.reader.releaseLock() } catch { /* ignore */ }
      }
      if (this.port) {
        try { await this.port.close() } catch { /* ignore — port may be re-grabbed on reconnect */ }
      }
    } finally {
      this.reader = null
      this.port = null
      this.stream.reset()
      this.writeChain = Promise.resolve()
      this.emit({ kind: 'disconnected' })
    }
  }

  /** Disconnect from the serial port. Always resets state — even if close()
   *  throws (e.g. a stream still locked) — so a fresh connect can recover. */
  async disconnect(): Promise<void> {
    // Reject the active round trip and every queued caller immediately. Merely
    // resetting a promise chain would leave queued operations alive, allowing
    // them to write to a later connection after this disconnect completes.
    await this.closeSession(new Error('Disconnected'))
  }

  /** Send raw bytes to the ESP32. Serialised so writes never overlap (a second
   *  getWriter() while the first writer holds the lock throws "WritableStream is
   *  locked"). A stalled write is bounded by a timeout and the writer aborted, so
   *  a non-responding device (e.g. one still in the bootloader after a flash that
   *  didn't reboot) can't lock the stream forever. */
  async write(data: Uint8Array, timeoutMs = 5_000): Promise<void> {
    const run = this.writeChain.then(() => this.writeOne(data, timeoutMs))
    // Keep the chain alive even if this write rejects, so one failure doesn't
    // wedge every subsequent write.
    this.writeChain = run.then(() => {}, () => {})
    return run
  }

  private async writeOne(data: Uint8Array, timeoutMs: number): Promise<void> {
    if (!this.port?.writable) {
      throw new Error('Not connected')
    }
    const writer = this.port.writable.getWriter()
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      // Abort unsticks a write blocked on backpressure and releases the lock
      // (a plain releaseLock() throws while a write is still pending). The
      // pending write() then rejects, which we map to the friendly error below.
      writer.abort().catch(() => { /* ignore */ })
    }, timeoutMs)
    let writeErr: unknown
    try {
      // Pace large frames: the UART-bridge boards (T-Display, Heltec V3,
      // ESP8266) have a 4KB driver ring the firmware may be slow to drain,
      // so a burst bigger than the ring silently loses bytes and the frame
      // dies on CRC. Head slices drip, the rest cruise once the firmware is
      // committed to reading the frame (cadence in pacing.ts).
      for (const { bytes, gapMs } of paceSlices(data)) {
        await writer.write(bytes)
        if (gapMs > 0) await new Promise((r) => setTimeout(r, gapMs))
      }
    } catch (e) {
      writeErr = e
    } finally {
      clearTimeout(timer)
      try { writer.releaseLock() } catch { /* already released by abort */ }
    }
    if (timedOut) {
      throw new Error("The device isn't responding. If you just flashed it, press the RESET button on the board so it starts the new firmware, then reconnect.")
    }
    if (writeErr) throw writeErr
  }

  /** Send a frame and wait for a response with one of the expected types. */
  async sendAndReceive(
    frameBytes: Uint8Array,
    expectedTypes: FrameTypeValue[],
    timeoutMs = 30_000,
  ): Promise<Frame> {
    if (!this.connected) return Promise.reject(new Error('Not connected'))
    return new Promise<Frame>((resolve, reject) => {
      this.requestQueue.push({
        frameBytes,
        expectedTypes: [...expectedTypes],
        timeoutMs,
        resolve,
        reject: (error) => reject(error),
      })
      void this.drainRequests()
    })
  }

  /** Run queued round trips in FIFO order, with only one response listener. */
  private async drainRequests(): Promise<void> {
    if (this.requestDraining) return
    this.requestDraining = true
    try {
      while (this.requestQueue.length > 0) {
        const request = this.requestQueue.shift()!
        if (!this.connected) {
          request.reject(new Error('Disconnected'))
          continue
        }
        this.activeRequest = request
        try {
          request.resolve(await this.runRequest(request))
        } catch (error) {
          request.reject(error instanceof Error ? error : new Error(String(error)))
        } finally {
          request.cancel = undefined
          if (this.activeRequest === request) this.activeRequest = null
        }
      }
    } finally {
      this.requestDraining = false
      // A request can be added after the while condition but before the guard
      // drops. Ensure it cannot be stranded waiting for another enqueue.
      if (this.requestQueue.length > 0) void this.drainRequests()
    }
  }

  /** Execute one request after it reaches the head of the FIFO. */
  private runRequest(request: SerialRequest): Promise<Frame> {
    return new Promise<Frame>((resolve, reject) => {
      let settled = false
      let unsub = () => {}
      const finish = (result: { frame: Frame } | { error: Error }) => {
        if (settled) return
        settled = true
        clearTimeout(timeout)
        unsub()
        request.cancel = undefined
        if ('frame' in result) resolve(result.frame)
        else reject(result.error)
      }

      const timeout = setTimeout(() => {
        if (settled) return

        // Frames have no request IDs and most operations answer with the same
        // ACK/NACK types. Once this response is overdue, a late ACK cannot be
        // distinguished from the next queued operation's ACK. Claim the active
        // request before the asynchronous teardown, reject all queued work, and
        // require a fresh connection before another frame can be written.
        settled = true
        unsub()
        request.cancel = undefined
        if (this.activeRequest === request) this.activeRequest = null

        const timeoutError = new Error("No response from the device. The serial session was closed so a late reply cannot be mistaken for another operation. Reconnect before trying again.")
        const queuedError = new Error('Serial session lost after a device timeout. Reconnect before trying again.')
        void this.closeSession(queuedError).then(() => reject(timeoutError))
      }, request.timeoutMs)

      unsub = this.on((event) => {
        if (event.kind === 'frame' && request.expectedTypes.includes(event.frame.type)) {
          finish({ frame: event.frame })
        } else if (event.kind === 'disconnected') {
          finish({ error: new Error('Disconnected') })
        }
      })
      request.cancel = (error) => finish({ error })

      this.write(request.frameBytes).catch((error) => {
        finish({ error: error instanceof Error ? error : new Error(String(error)) })
      })
    })
  }

  /** Cancel the active owner and reject/remove every request not yet written. */
  private cancelRequests(error: Error): void {
    this.activeRequest?.cancel?.(error)
    const queued = this.requestQueue.splice(0)
    for (const request of queued) request.reject(error)
  }

  // --- Internal read loop ---

  private async readLoop() {
    if (!this.port?.readable) return

    while (this.running && this.port?.readable) {
      try {
        this.reader = this.port.readable.getReader()
        while (this.running) {
          const { value, done } = await this.reader.read()
          if (done || !value) break
          this.processBytes(value)
        }
      } catch (e) {
        if (this.running) {
          this.emit({ kind: 'error', message: e instanceof Error ? e.message : 'Read error' })
        }
      } finally {
        this.reader?.releaseLock()
        this.reader = null
      }
    }

    if (this.running) {
      // Port closed unexpectedly.
      this.cancelRequests(new Error('Disconnected'))
      this.running = false
      this.port = null
      this.emit({ kind: 'disconnected' })
    }
  }

  private processBytes(chunk: Uint8Array) {
    this.stream.feed(chunk)
  }
}

/** Singleton transport instance shared across the app. */
export const transport = new SerialTransport()

// Release the port when the page goes away. Closing the tab or navigating off
// otherwise leaves it open and claimed by the browser process, and every later
// attempt — a new tab, the CLI, esptool — fails with "port is busy" until the
// device is physically unplugged.
releasePortsOnUnload()
