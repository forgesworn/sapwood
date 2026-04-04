// Web Serial transport layer for Heartwood ESP32.
//
// Connects to the ESP32 via USB-Serial-JTAG using the Web Serial API.
// Reads incoming bytes, hunts for frame magic, and emits parsed frames.
// Non-frame bytes (ESP-IDF log output) are emitted as log lines.

import { MAGIC, OVERHEAD, MAX_PAYLOAD, HEADER_SIZE, CRC_SIZE, parseFrame } from './frame.js'
import type { Frame, FrameTypeValue } from './frame.js'

export type SerialEvent =
  | { kind: 'connected'; port: string }
  | { kind: 'disconnected' }
  | { kind: 'frame'; frame: Frame }
  | { kind: 'log'; line: string }
  | { kind: 'error'; message: string }

export type SerialListener = (event: SerialEvent) => void

/** Web Serial connection to the ESP32. */
export class SerialTransport {
  private port: SerialPort | null = null
  private reader: ReadableStreamDefaultReader<Uint8Array> | null = null
  private running = false
  private listeners: SerialListener[] = []

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

  /** Request a serial port from the user and connect. */
  async connect(baudRate = 115200): Promise<void> {
    if (this.connected) return

    try {
      const port = await navigator.serial.requestPort({
        filters: [
          // ESP32-S3 USB-Serial-JTAG
          { usbVendorId: 0x303a, usbProductId: 0x1001 },
        ],
      })

      await port.open({ baudRate, bufferSize: 4096 })
      this.port = port
      this.running = true
      this.buffer = new Uint8Array(0)
      this.logBuffer = ''

      const info = port.getInfo()
      this.emit({
        kind: 'connected',
        port: `USB ${info.usbVendorId?.toString(16) ?? '?'}:${info.usbProductId?.toString(16) ?? '?'}`,
      })

      // Start the read loop (fire and forget -- errors handled internally).
      this.readLoop()
    } catch (e) {
      this.emit({ kind: 'error', message: e instanceof Error ? e.message : 'Connection failed' })
    }
  }

  /** Disconnect from the serial port. */
  async disconnect(): Promise<void> {
    this.running = false
    try {
      if (this.reader) {
        await this.reader.cancel()
        this.reader.releaseLock()
        this.reader = null
      }
      if (this.port) {
        await this.port.close()
        this.port = null
      }
    } catch {
      // Ignore close errors.
    }
    this.emit({ kind: 'disconnected' })
  }

  /** Send raw bytes to the ESP32. */
  async write(data: Uint8Array): Promise<void> {
    if (!this.port?.writable) {
      throw new Error('Not connected')
    }
    const writer = this.port.writable.getWriter()
    try {
      await writer.write(data)
    } finally {
      writer.releaseLock()
    }
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
        reject(new Error('Timeout waiting for response'))
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
