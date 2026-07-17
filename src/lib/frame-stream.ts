// Byte-stream splitter for the Heartwood serial protocol.
//
// Feeds on raw serial bytes, hunts for frame magic, and hands complete frames
// to the sink. Bytes that are not part of a frame (ESP-IDF log output) come
// out as complete log lines. Pure logic with no transport attached, shared by
// the Web Serial transport (src/lib/serial.ts) and the CLI's Node transport.

import { MAGIC, MAX_PAYLOAD, HEADER_SIZE, CRC_SIZE, parseFrame } from './frame.js'
import type { Frame } from './frame.js'

export interface FrameStreamSink {
  onFrame(frame: Frame): void
  onLog(line: string): void
}

export class FrameStream {
  private buffer = new Uint8Array(0)
  private logBuffer = ''

  constructor(private readonly sink: FrameStreamSink) {}

  /** Drop any partial frame and pending log fragment (fresh session). */
  reset(): void {
    this.buffer = new Uint8Array(0)
    this.logBuffer = ''
  }

  feed(chunk: Uint8Array): void {
    const combined = new Uint8Array(this.buffer.length + chunk.length)
    combined.set(this.buffer)
    combined.set(chunk, this.buffer.length)
    this.buffer = combined

    // Process as many frames as possible from the buffer.
    while (this.buffer.length > 0) {
      const magicIdx = this.findMagic()
      if (magicIdx === -1) {
        // No magic found -- log output. A trailing 0x48 could be the first
        // half of a magic split across chunks, so hold it back; flushing it
        // would lose the frame that completes in the next chunk.
        const holdLast = this.buffer[this.buffer.length - 1] === MAGIC[0]
        const flushLen = holdLast ? this.buffer.length - 1 : this.buffer.length
        if (flushLen > 0) this.emitLogBytes(this.buffer.slice(0, flushLen))
        this.buffer = holdLast ? this.buffer.slice(flushLen) : new Uint8Array(0)
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

      try {
        const frame = parseFrame(this.buffer.slice(0, frameLen))
        this.sink.onFrame(frame)
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

  private emitLogBytes(bytes: Uint8Array): void {
    // Accumulate text and emit complete lines.
    const text = new TextDecoder().decode(bytes)
    this.logBuffer += text
    const lines = this.logBuffer.split('\n')
    // Emit all complete lines, keep the last (potentially incomplete) fragment.
    for (let i = 0; i < lines.length - 1; i++) {
      const line = lines[i]!.trim()
      if (line.length > 0) {
        this.sink.onLog(line)
      }
    }
    this.logBuffer = lines[lines.length - 1] ?? ''
  }
}
