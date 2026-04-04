// Reactive device state shared across all components.
// Listens to the serial transport and exposes current state.

import { transport, type SerialEvent } from './serial.js'
import { FrameType, buildProvisionList, buildPolicyListRequest } from './frame.js'
import type { ClientPolicy, MasterInfo } from './types.js'

// --- Reactive state ---

export const device = $state({
  connected: false,
  portInfo: '',
  masters: [] as MasterInfo[],
  clients: [] as ClientPolicy[],
  selectedSlot: 0,
  logs: [] as string[],
  error: null as string | null,
})

const MAX_LOG_LINES = 500

// --- Transport listener ---

transport.on((event: SerialEvent) => {
  switch (event.kind) {
    case 'connected':
      device.connected = true
      device.portInfo = event.port
      device.error = null
      // Auto-fetch masters on connect.
      refreshMasters()
      break

    case 'disconnected':
      device.connected = false
      device.portInfo = ''
      device.masters = []
      device.clients = []
      break

    case 'frame':
      handleFrame(event.frame)
      break

    case 'log':
      device.logs.push(event.line)
      if (device.logs.length > MAX_LOG_LINES) {
        device.logs = device.logs.slice(-MAX_LOG_LINES)
      }
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

// --- Actions ---

export async function connect(baudRate = 115200) {
  await transport.connect(baudRate)
}

export async function disconnect() {
  await transport.disconnect()
}

export async function refreshMasters() {
  if (!device.connected) return
  try {
    await transport.write(buildProvisionList())
  } catch (e) {
    device.error = e instanceof Error ? e.message : 'Failed to fetch masters'
  }
}

export async function refreshClients(slot?: number) {
  if (!device.connected) return
  const s = slot ?? device.selectedSlot
  try {
    await transport.write(buildPolicyListRequest(s))
  } catch (e) {
    device.error = e instanceof Error ? e.message : 'Failed to fetch clients'
  }
}

export { transport }
