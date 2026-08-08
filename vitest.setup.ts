import { vi } from 'vitest'

// Unit tests must never open real network sockets. Components under test can
// reach for one indirectly (RelayEditor's health probe, nostr-tools pools,
// bridge log streaming), and a socket that finishes connecting after its test
// tore down crashes the run: undici fires the open event into the jsdom
// globals and Node rejects the cross-realm Event with ERR_INVALID_ARG_TYPE.
// All 777 tests pass, vitest still exits 1. This stub connects to nothing and
// fires nothing; code paths that care about socket behaviour install their own
// mock on top.
class InertWebSocket extends EventTarget {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSING = 2
  static readonly CLOSED = 3
  readonly CONNECTING = 0
  readonly OPEN = 1
  readonly CLOSING = 2
  readonly CLOSED = 3
  readyState = 0
  url: string
  binaryType = 'blob'
  bufferedAmount = 0
  extensions = ''
  protocol = ''
  onopen: ((ev: Event) => void) | null = null
  onmessage: ((ev: MessageEvent) => void) | null = null
  onerror: ((ev: Event) => void) | null = null
  onclose: ((ev: CloseEvent) => void) | null = null
  constructor(url: string | URL) {
    super()
    this.url = String(url)
  }
  send(): void {}
  close(): void {
    this.readyState = InertWebSocket.CLOSED
  }
}

vi.stubGlobal('WebSocket', InertWebSocket)
