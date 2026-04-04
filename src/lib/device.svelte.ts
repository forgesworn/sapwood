// Reactive device state shared across all components.
// Supports two transport modes: Web Serial (direct USB) and HTTP (bridge API).

import { transport as serialTransport, type SerialEvent } from './serial.js'
import { httpTransport, HttpTransport, type HttpEvent } from './http.js'
import { FrameType, buildProvisionList, buildPolicyListRequest } from './frame.js'
import type { ClientPolicy, MasterInfo } from './types.js'

// --- Reactive state ---

export type TransportMode = 'none' | 'serial' | 'http'

export const device = $state({
  connected: false,
  mode: 'none' as TransportMode,
  portInfo: '',
  masters: [] as MasterInfo[],
  clients: [] as ClientPolicy[],
  selectedSlot: 0,
  logs: [] as string[],
  error: null as string | null,
  bridgeInfo: null as Record<string, unknown> | null,
})

const MAX_LOG_LINES = 500

// --- Serial transport listener ---

serialTransport.on((event: SerialEvent) => {
  switch (event.kind) {
    case 'connected':
      device.connected = true
      device.mode = 'serial'
      device.portInfo = event.port
      device.error = null
      refreshMasters()
      break
    case 'disconnected':
      if (device.mode === 'serial') {
        device.connected = false
        device.mode = 'none'
        device.portInfo = ''
        device.masters = []
        device.clients = []
      }
      break
    case 'frame':
      handleFrame(event.frame)
      break
    case 'log':
      addLog(event.line)
      break
    case 'error':
      device.error = event.message
      break
  }
})

// --- HTTP transport listener ---

httpTransport.on((event: HttpEvent) => {
  switch (event.kind) {
    case 'connected':
      device.connected = true
      device.mode = 'http'
      device.portInfo = event.port
      device.error = null
      refreshMasters()
      break
    case 'disconnected':
      if (device.mode === 'http') {
        device.connected = false
        device.mode = 'none'
        device.portInfo = ''
        device.masters = []
        device.clients = []
        device.bridgeInfo = null
      }
      break
    case 'frame':
      handleFrame(event.frame)
      break
    case 'log':
      addLog(event.line)
      break
    case 'error':
      device.error = event.message
      break
  }
})

function handleFrame(frame: { type: number; payload: Uint8Array }) {
  const decoder = new TextDecoder()
  switch (frame.type) {
    case FrameType.PROVISION_LIST_RESPONSE:
      try {
        device.masters = JSON.parse(decoder.decode(frame.payload)) as MasterInfo[]
      } catch {
        device.error = 'Failed to parse master list'
      }
      break
    case FrameType.POLICY_LIST_RESPONSE:
      try {
        device.clients = JSON.parse(decoder.decode(frame.payload)) as ClientPolicy[]
      } catch {
        device.error = 'Failed to parse client list'
      }
      break
  }
}

function addLog(line: string) {
  device.logs.push(line)
  if (device.logs.length > MAX_LOG_LINES) {
    device.logs = device.logs.slice(-MAX_LOG_LINES)
  }
}

// --- Actions ---

export async function connectSerial(baudRate = 115200) {
  await serialTransport.connect(baudRate)
}

export async function connectHttp(address: string) {
  await httpTransport.connect(address)
  // Fetch bridge info after connecting.
  try {
    device.bridgeInfo = await httpTransport.bridgeInfo()
  } catch { /* non-fatal */ }
}

export async function disconnect() {
  if (device.mode === 'serial') {
    await serialTransport.disconnect()
  } else if (device.mode === 'http') {
    await httpTransport.disconnect()
  }
}

export async function refreshMasters() {
  if (!device.connected) return
  if (device.mode === 'serial') {
    try { await serialTransport.write(buildProvisionList()) } catch (e) {
      device.error = e instanceof Error ? e.message : 'Failed to fetch masters'
    }
  } else if (device.mode === 'http') {
    await httpTransport.fetchStatus()
  }
}

export async function refreshClients(slot?: number) {
  if (!device.connected) return
  const s = slot ?? device.selectedSlot
  if (device.mode === 'serial') {
    try { await serialTransport.write(buildPolicyListRequest(s)) } catch (e) {
      device.error = e instanceof Error ? e.message : 'Failed to fetch clients'
    }
  } else if (device.mode === 'http') {
    await httpTransport.fetchClients(s)
  }
}

export async function bridgeRestart() {
  if (device.mode !== 'http') return
  await httpTransport.bridgeRestart()
}

export { serialTransport, httpTransport, HttpTransport }
