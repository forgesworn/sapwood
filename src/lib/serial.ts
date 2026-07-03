// Web Serial transport layer for Heartwood ESP32.
//
// Connects to the ESP32 via USB-Serial-JTAG using the Web Serial API.
// Reads incoming bytes, hunts for frame magic, and emits parsed frames.
// Non-frame bytes (ESP-IDF log output) are emitted as log lines.

import { MAGIC, MAX_PAYLOAD, HEADER_SIZE, CRC_SIZE, parseFrame } from './frame.js'
import type { Frame, FrameTypeValue } from './frame.js'
import { releaseGrantedPorts } from './serial-ports.js'

export type SerialEvent =
  | { kind: 'connected'; port: string }
  | { kind: 'disconnected' }
  | { kind: 'frame'; frame: Frame }
  | { kind: 'log'; line: string }
  | { kind: 'error'; message: string }

export type SerialListener = (event: SerialEvent) => void

// Write pacing for frames that could overrun a UART board's 4KB driver ring
// (identity-card avatars ~8KB, OTA chunks 4KB). Two phases, measured against a
// live T-Display (v0.9.10) in wifi mode: its relay loop polls USB as rarely as
// once a second, so the HEAD of a frame must drip in slower than 4KB/s or the
// ring overflows before the firmware latches on. Once latched, the firmware
// blocks draining the rest of the frame continuously, so the tail can cruise
// at heartwood-bridge's proven 64B/6ms.
const PACE_THRESHOLD = 512
const PACE_CHUNK = 64
const PACE_HEAD_BYTES = 3072
const PACE_HEAD_GAP_MS = 24
const PACE_GAP_MS = 6

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

  // Buffer for accumulating incoming bytes.
  private buffer = new Uint8Array(0)
  // Buffer for accumulating non-frame text (ESP-IDF log lines).
  private logBuffer = ''

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
      this.buffer = new Uint8Array(0)
      this.logBuffer = ''
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
        this.running = false
        this.emit({ kind: 'disconnected' })
      }
    }
  }

  /** Disconnect from the serial port. Always resets state — even if close()
   *  throws (e.g. a stream still locked) — so a fresh connect can recover. */
  async disconnect(): Promise<void> {
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
      this.writeChain = Promise.resolve()
      this.emit({ kind: 'disconnected' })
    }
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
      if (data.length <= PACE_THRESHOLD) {
        await writer.write(data)
      } else {
        // Pace large frames: the UART-bridge boards (T-Display, Heltec V3,
        // ESP8266) have a 4KB driver ring the firmware may be slow to drain,
        // so a burst bigger than the ring silently loses bytes and the frame
        // dies on CRC. Head slices drip (see PACE_HEAD_* above), the rest
        // cruise once the firmware is committed to reading the frame.
        for (let o = 0; o < data.length; o += PACE_CHUNK) {
          await writer.write(data.subarray(o, Math.min(o + PACE_CHUNK, data.length)))
          if (o + PACE_CHUNK < data.length) {
            await new Promise((r) => setTimeout(r, o < PACE_HEAD_BYTES ? PACE_HEAD_GAP_MS : PACE_GAP_MS))
          }
        }
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
    return new Promise<Frame>((resolve, reject) => {
      const timeout = setTimeout(() => {
        unsub()
        reject(new Error("No response from the device. If you just flashed it, press the RESET button on the board so it starts the new firmware, then reconnect."))
      }, timeoutMs)

      const unsub = this.on((event) => {
        if (event.kind === 'frame' && expectedTypes.includes(event.frame.type)) {
          clearTimeout(timeout)
          unsub()
          resolve(event.frame)
        } else if (event.kind === 'disconnected') {
          clearTimeout(timeout)
          unsub()
          reject(new Error('Disconnected'))
        }
      })

      this.write(frameBytes).catch((e) => {
        clearTimeout(timeout)
        unsub()
        reject(e)
      })
    })
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
      this.running = false
      this.port = null
      this.emit({ kind: 'disconnected' })
    }
  }

  private processBytes(chunk: Uint8Array) {
    // Append to buffer.
    const combined = new Uint8Array(this.buffer.length + chunk.length)
    combined.set(this.buffer)
    combined.set(chunk, this.buffer.length)
    this.buffer = combined

    // Process as many frames as possible from the buffer.
    while (this.buffer.length > 0) {
      // Hunt for magic bytes.
      const magicIdx = this.findMagic()
      if (magicIdx === -1) {
        // No magic found -- everything is log output.
        this.emitLogBytes(this.buffer)
        this.buffer = new Uint8Array(0)
        return
      }

      // Emit any bytes before the magic as log output.
      if (magicIdx > 0) {
        this.emitLogBytes(this.buffer.slice(0, magicIdx))
        this.buffer = this.buffer.slice(magicIdx)
      }

      // Do we have enough bytes for a header?
      if (this.buffer.length < HEADER_SIZE) return // Wait for more data.

      // Read the payload length from the header.
      const payloadLen = (this.buffer[3]! << 8) | this.buffer[4]!
      if (payloadLen > MAX_PAYLOAD) {
        // Corrupt -- skip past this magic and keep hunting.
        this.buffer = this.buffer.slice(2)
        continue
      }

      const frameLen = HEADER_SIZE + payloadLen + CRC_SIZE
      if (this.buffer.length < frameLen) return // Wait for more data.

      // Try to parse the frame.
      try {
        const frame = parseFrame(this.buffer.slice(0, frameLen))
        this.emit({ kind: 'frame', frame })
        this.buffer = this.buffer.slice(frameLen)
      } catch {
        // Bad CRC or other parse error -- skip past magic and keep hunting.
        this.buffer = this.buffer.slice(2)
      }
    }
  }

  private findMagic(): number {
    for (let i = 0; i <= this.buffer.length - 2; i++) {
      if (this.buffer[i] === MAGIC[0] && this.buffer[i + 1] === MAGIC[1]) {
        return i
      }
    }
    return -1
  }

  private emitLogBytes(bytes: Uint8Array) {
    // Accumulate text and emit complete lines.
    const text = new TextDecoder().decode(bytes)
    this.logBuffer += text
    const lines = this.logBuffer.split('\n')
    // Emit all complete lines, keep the last (potentially incomplete) fragment.
    for (let i = 0; i < lines.length - 1; i++) {
      const line = lines[i]!.trim()
      if (line.length > 0) {
        this.emit({ kind: 'log', line })
      }
    }
    this.logBuffer = lines[lines.length - 1] ?? ''
  }
}

/** Singleton transport instance shared across the app. */
export const transport = new SerialTransport()
