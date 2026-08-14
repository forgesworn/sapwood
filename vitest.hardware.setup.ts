// Setup for the hardware bench runs only. Unit tests keep the inert socket
// (vitest.setup.ts); the bench needs the opposite — its relay legs are real.
// The `ws` client avoids the undici cross-realm event crash that forced the
// inert stub in the first place: its events are plain objects from its own
// emitter, never Node-internal Events dispatched into the jsdom realm.
// The hardware config aliases `ws` to its real Node entry file — vite's
// browser condition would otherwise hand us ws's "does not work in the
// browser" shim.
import { vi } from 'vitest'
import WebSocketImport from 'ws'
import { useWebSocketImplementation } from 'nostr-tools/pool'

const WebSocket = WebSocketImport as unknown as typeof globalThis.WebSocket

vi.stubGlobal('WebSocket', WebSocket)
useWebSocketImplementation(WebSocket)
