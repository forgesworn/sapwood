// Reactive device state shared across all components.
// Supports two transport modes: Web Serial (direct USB) and HTTP (bridge API).

import { transport as serialTransport, type SerialEvent } from './serial.js'
import { httpTransport, HttpTransport, type HttpEvent } from './http.js'
import {
  buildSetNetConfig, FrameType, buildProvisionList, type NetConfig,
  buildGetNetConfig, buildPatchNetConfig, buildSetOperator, type LocalNetConfigPatch,
  buildSessionAuth, buildSetBridgeSecret, buildGenerateIdentity, buildRestoreIdentity,
  buildFirmwareInfo, buildWifiScan,
  buildConnSlotCreate, buildConnSlotList, buildConnSlotRevoke, buildConnSlotUpdate, buildConnSlotUri,
  buildDeriveIdentity,
} from './frame.js'
import type { ConnectSlot, ExactClientPolicy, MasterInfo } from './types.js'
import { policiesEqual } from './client-policy.js'
import { loadAvatar, placeholderAvatar, buildSetIdentityMeta, type Avatar } from './avatar.js'
import { buildProvisionFrame, type ProvisionMode } from './provision.js'
import { resolveProfiles, profileDisplayName } from './profiles.js'
import {
  FirstFulfilledError,
  firstFulfilled,
  RelayTransport,
  throwIfSignalAborted,
} from './relay-transport.js'
import { getOperatorCandidates } from './op-mgmt.js'
import {
  clearPendingNetworkHandoff, networkRecoveryRelays, pendingNetworkHandoff,
  rememberDevice, replaceDeviceRelays, savePendingNetworkHandoff, npubShort,
} from './known-devices.js'
import { DEFAULT_SIGNER_RELAYS } from './wizard.js'
import { nip19 } from 'nostr-tools'
import { kindLabel } from './kinds.js'

// --- Reactive state ---

export type TransportMode = 'none' | 'serial' | 'http' | 'relay'

/** Live device status reported by a wifi device over the relay (kind 24134). */
export interface RelayStatus {
  master_count: number
  slots: number
  mode: string
  relay: string
  capabilities: string[]
  /** Seconds since the signer booted (absent on older firmware). */
  uptime_s?: number
  /** Why the chip last reset: software-restart is deliberate; panic,
   *  watchdog and brownout are crashes worth investigating. */
  last_reset?: string
  /** What the signer was doing when it last crashed (only after a crash
   *  reset that left a breadcrumb), e.g. 'relay sign_event kind 1059'. */
  crashed_during?: string
  /** Whether runtime logging is dropped to warnings (calms activity LEDs
   *  wired to the log UART). */
  log_quiet?: boolean
  /** Running firmware version (absent on older firmware). */
  version?: string
  /** Board identifier, e.g. 'tdisplay' (absent on older firmware). */
  board?: string
}

/** Network state returned by relay management. Password material is never
 * returned: `password_set` is the only credential information the UI sees. */
export interface RedactedNetworkConfig {
  mode: 'usb' | 'wifi'
  ssid: string
  relays: string[]
  password_set: boolean
}

export interface NetworkConfigTrial extends RedactedNetworkConfig {
  transaction_id: string
  attempted: number
  phase: 'staged' | 'trying'
}

export interface RemoteNetworkState {
  revision: number
  active: RedactedNetworkConfig
  trial: NetworkConfigTrial | null
  last_result: {
    transaction_id: string
    revision: number
    outcome: 'committed' | 'aborted' | 'rolled_back'
  } | null
}

/** Current password-redacted state read directly from this USB-attached signer. */
export interface UsbNetworkState {
  version: 1
  configured: boolean
  revision: number
  mode?: 'usb' | 'wifi'
  ssid?: string
  relays?: string[]
  password_set?: boolean
  op_mgmt?: string
  recovery_ok: boolean
  /** A non-null value means the stored active route is not proof of the route
   * this boot is actually trying. Phone handoff must remain locked until the
   * firmware reports a terminal state. */
  trial: {
    transaction_id: string
    revision: number
    phase: 'staged' | 'trying' | 'committed'
    mode: 'usb' | 'wifi'
    ssid: string
    relays: string[]
    password_set: boolean
    attempted: boolean
  } | null
}

export type RemotePasswordChange =
  | { action: 'keep' }
  | { action: 'set'; value: string }
  | { action: 'clear' }

/** Remote management deliberately cannot switch the signer to USB-only or
 * rotate `op_mgmt`: either would let a remote session lock out its owner. */
export interface RemoteNetworkPatch {
  mode?: 'wifi'
  ssid?: string
  relays?: string[]
  password?: RemotePasswordChange
}

interface RelayAuditEntry {
  seq?: unknown
  method?: unknown
  label?: unknown
  client?: unknown
  kind?: unknown
  preview?: unknown
  outcome?: unknown
}

export interface SignerActivityEntry {
  id: string
  at: string
  source: 'relay-audit' | 'device-log'
  method: string
  outcome: string
  action: string
  app: string
  client: string
  kind: number | null
  kindText: string
  preview: string
}

export interface PendingClient {
  pubkey: string
  firstSeen: string
  lastSeen: string
  attempts: number
}

export const device = $state({
  connected: false,
  mode: 'none' as TransportMode,
  portInfo: '',
  masters: [] as MasterInfo[],
  slots: [] as ConnectSlot[],
  /** Bunker links captured at create time, keyed by slot index. Updated WiFi
   *  firmware can re-issue pending links over operator management; this cache
   *  keeps the common same-session copy path instant. */
  slotUris: {} as Record<number, string>,
  pendingClients: [] as PendingClient[],
  approvals: [] as Record<string, unknown>[],
  selectedSlot: 0,
  logs: [] as string[],
  signerActivity: [] as SignerActivityEntry[],
  error: null as string | null,
  /** When set, the signer is waiting on a physical button hold and this is the
   *  instruction to show (e.g. the one-time USB pairing). Cleared when done. */
  awaitingButton: null as string | null,
  /** The signer's last WiFi-join failure reason, lifted out of the log stream so
   *  it can be surfaced instead of buried. Cleared once WiFi comes up. */
  wifiJoinError: null as string | null,
  bridgeInfo: null as Record<string, unknown> | null,
  relayStatus: null as RelayStatus | null,
  /** Relay: the relays this signer is reachable on (set on a relay connect). A
   *  nostrconnect app can only pair when it shares one of these. */
  relays: [] as string[],
  /** Relay: exact active relays read back through authenticated management.
   * `relays` may temporarily be an A+B recovery union; only this device-proven
   * set is safe to export in a phone handoff. Null means not proven yet. */
  relayConfiguredRelays: null as string[] | null,
  /** Relay: the operator pubkey Sapwood signs management with (must match the device's baked op_mgmt). */
  operatorPub: '',
  /** Exact relay-management target, independent of the display/master response. */
  relayDevicePub: '',
  /** Monotonic local connection epoch. Async UI reads bind to this so a late
   * response from a prior transport cannot populate a newly connected signer. */
  connectionGeneration: 0,
  /** USB-direct: true once the bridge session is authenticated (client mgmt allowed). */
  bridgeAuthed: false,
  /** USB-direct: probing whether the freshly-connected device answers frames. */
  usbProbing: false,
  /** USB-direct: device is connected at the port level but answers no frames.
   *  Firmware v0.9.10+ serves USB in every mode, so silence now means older
   *  WiFi firmware (whose relay loop ignored the cable), a device still
   *  booting, or a port that isn't a signer. Drives the retry / "manage over
   *  WiFi" guidance. */
  usbSilent: false,
  /** Exact state read from the attached signer; never contains a password. */
  usbNetworkState: null as UsbNetworkState | null,
  usbNetworkSupport: 'unknown' as 'unknown' | 'supported' | 'unsupported',
})

const MAX_LOG_LINES = 500
const MAX_ACTIVITY_LINES = 100
let signerActivitySeq = 0

// --- Serial transport listener ---

serialTransport.on((event: SerialEvent) => {
  switch (event.kind) {
    case 'connected':
      device.connectionGeneration += 1
      device.connected = true
      device.mode = 'serial'
      device.relayDevicePub = ''
      device.portInfo = event.port
      device.error = null
      device.signerActivity = []
      device.usbSilent = false
      device.usbNetworkState = null
      device.usbNetworkSupport = 'unknown'
      void probeSerial()
      break
    case 'disconnected':
      if (device.mode === 'serial') {
        device.connectionGeneration += 1
        device.connected = false
        device.mode = 'none'
        device.portInfo = ''
        device.masters = []
        device.slots = []
        device.selectedSlot = 0
        device.signerActivity = []
        device.bridgeAuthed = false
        device.usbProbing = false
        device.usbSilent = false
        device.usbNetworkState = null
        device.usbNetworkSupport = 'unknown'
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
      device.connectionGeneration += 1
      device.connected = true
      device.mode = 'http'
      device.relayDevicePub = ''
      device.portInfo = event.port
      device.error = null
      device.signerActivity = []
      refreshMasters()
      break
    case 'disconnected':
      if (device.mode === 'http') {
        device.connectionGeneration += 1
        device.connected = false
        device.mode = 'none'
        device.portInfo = ''
        device.masters = []
        device.slots = []
        device.selectedSlot = 0
        device.pendingClients = []
        device.approvals = []
        device.signerActivity = []
        device.bridgeInfo = null
      }
      break
    case 'frame':
      handleFrame(event.frame)
      break
    case 'pending-clients':
      device.pendingClients = event.clients
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
        // A selection carried over from another signer must not silently target
        // a different identity's slot table here.
        if (!device.masters.some((m) => m.slot === device.selectedSlot)) {
          device.selectedSlot = device.masters[0]?.slot ?? 0
        }
        // Knowing the master npub is all we need to dress the signer's screen.
        void autoSyncIdentityMeta()
      } catch {
        device.error = 'Failed to parse master list'
      }
      break
    case 0x43: // CONNSLOT_LIST_RESP
      try {
        device.slots = JSON.parse(decoder.decode(frame.payload)) as ConnectSlot[]
      } catch {
        device.error = 'Failed to parse slot list'
      }
      break
  }
}

function addLog(line: string) {
  device.logs.push(line)
  if (device.logs.length > MAX_LOG_LINES) {
    device.logs = device.logs.slice(-MAX_LOG_LINES)
  }
  const activity = signerActivityFromDeviceLog(line)
  if (activity) appendSignerActivity(activity)
  // Lift the signer's WiFi-join outcome out of the log stream. The firmware
  // retries a failed join every 3s (relay.rs), so a bad SSID/password otherwise
  // just scrolls past unnoticed; surface the reason and clear it once WiFi is up.
  const failed = line.match(/wifi connect failed:\s*(.+?)(?:;|$)/i)
  if (failed) device.wifiJoinError = failed[1]!.trim()
  else if (/wifi up\b/i.test(line)) device.wifiJoinError = null
}

function appendSignerActivity(entry: Omit<SignerActivityEntry, 'id' | 'at'> & { at?: string }) {
  const next: SignerActivityEntry = {
    ...entry,
    id: `activity-${++signerActivitySeq}`,
    at: entry.at ?? new Date().toISOString(),
  }
  device.signerActivity.push(next)
  if (device.signerActivity.length > MAX_ACTIVITY_LINES) {
    device.signerActivity = device.signerActivity.slice(-MAX_ACTIVITY_LINES)
  }
}

function signerActivityFromDeviceLog(line: string): Omit<SignerActivityEntry, 'id' | 'at'> | null {
  if (/^Sign audit:/i.test(line)) return null
  const signed = line.match(/^sign_event\s+([^:]+):\s+(.+?)(?:\s+\((\d+)\))?\s+for\s+(.+?)(?:\s+[—-]\s+(.+))?$/i)
  if (!signed) return null
  const outcome = signed[1]!.trim()
  const kindName = signed[2]!.trim()
  const kind = signed[3] ? Number(signed[3]) : NaN
  const app = signed[4]!.trim() || 'unknown app'
  const preview = signed[5]?.trim() ?? ''
  return {
    source: 'device-log',
    method: 'sign_event',
    outcome,
    action: auditAction('sign_event', outcome),
    app,
    client: '',
    kind: Number.isFinite(kind) ? kind : null,
    kindText: Number.isFinite(kind) ? `${kindName} (kind ${kind})` : kindName,
    preview,
  }
}

// --- Actions ---

export async function connectSerial(baudRate = 115200, port?: SerialPort) {
  resetIdMetaSync() // a reconnect should retry the identity-card push, not stay given-up
  device.wifiJoinError = null
  await serialTransport.connect(baudRate, port)
}

/** Uint8Array → base64, chunked so String.fromCharCode never overflows argv. */
function bytesToBase64(bytes: Uint8Array): string {
  let bin = ''
  const CHUNK = 0x8000
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  }
  return btoa(bin)
}

/**
 * Fetch the master's kind-0 profile, resize its avatar in-browser to a small
 * Rgb565 bitmap, and push the name + avatar to the signer — over USB
 * (SET_IDENTITY_META, 0x5b) or over the relay management channel
 * (`set_identity_meta`, firmware ≥0.9.12). The signer stores it and shows it
 * on its identity card; it never fetches or decodes images itself. If the
 * picture is missing or its host refuses the fetch (CORS), an initial-on-disc
 * placeholder is pushed so the card still carries the name. Returns the synced
 * name, or null when there is no master / no resolvable profile.
 */
export async function syncIdentityMeta(): Promise<string | null> {
  if (device.mode !== 'serial' && device.mode !== 'relay') return null
  const master = device.masters[0]
  if (!master?.npub) return null
  let pubHex: string
  try {
    pubHex = nip19.decode(master.npub).data as string
  } catch {
    return null
  }

  const profile = (await resolveProfiles([pubHex])).get(pubHex)
  if (!profile) return null
  const name = profileDisplayName(profile)
  if (!name) return null

  // Relay pushes travel inside a NIP-44 event a classic ESP32 must parse while
  // its TLS session already occupies the heap — 48x48 halves the bytes end to
  // end (a 64x64 relay push OOM-rebooted a T-Display). USB keeps full 64x64.
  const size = device.mode === 'relay' ? 48 : 64
  let avatar: Avatar
  try {
    avatar = profile.picture ? await loadAvatar(profile.picture, size) : placeholderAvatar(name, size)
  } catch {
    avatar = placeholderAvatar(name, size) // image host refused — name + disc beats nothing
  }

  if (device.mode === 'relay') {
    if (!relayTransport) return null
    await relayTransport.request(
      'set_identity_meta',
      { name, w: avatar.w, h: avatar.h, avatar_b64: bytesToBase64(avatar.bytes) },
      30_000,
    )
    return name
  }

  const frame = buildSetIdentityMeta(pubHex, name, avatar)

  // A wifi-mode signer only drains USB in windows (fast polls while wifi
  // retries, ~1s polls while its relay session is idle, nothing in between).
  // An 8KB frame launched into a dead window overflows the 4KB UART ring and
  // dies, so gate each attempt on a fresh FIRMWARE_INFO round-trip — a reply
  // means the signer polled the cable within the last instant, and the paced
  // frame sent right behind it lands inside the same window.
  let lastErr: unknown = null
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const ping = await serialTransport.sendAndReceive(
        buildFirmwareInfo(),
        [FrameType.FIRMWARE_INFO_RESPONSE, FrameType.NACK],
        6_000,
      )
      if (ping.type === FrameType.NACK) throw new Error('device rejected the version query')
      const reply = await serialTransport.sendAndReceive(frame, [FrameType.ACK, FrameType.NACK], 20_000)
      if (reply.type === FrameType.NACK) throw new Error('device rejected identity metadata')
      return name
    } catch (e) {
      lastErr = e // dead window or lost frame — wait out the blackout and retry
      await new Promise((r) => setTimeout(r, 2_000))
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error('signer did not accept the identity card')
}

// Auto-push bookkeeping per npub per page load: dedupe successes, and cap
// fruitless rounds so the relay path's 4-second status poll doesn't hammer
// the profile relays (or an old-firmware device) forever.
const idMetaSynced = new Set<string>()
const idMetaAttempts = new Map<string, number>()
const ID_META_MAX_ATTEMPTS = 3

/** Clear the auto-sync guard so a fresh connection retries the identity-card
 *  push from scratch. A provision reboots a WiFi signer and kills the USB drain
 *  window, so the first push often exhausts its attempts and gives up; without
 *  this reset, only a full page reload — not a reconnect — would try again, which
 *  is exactly why a restored signer showed no avatar until it was reconnected. */
function resetIdMetaSync() {
  idMetaSynced.clear()
  idMetaAttempts.clear()
}

/**
 * Push the identity card to the signer as soon as we know who it is — fired
 * whenever a serial master list lands or a relay status refresh resolves the
 * master, so connecting is enough and no manual sync step is needed. Quiet
 * best-effort: failures (and "no profile yet") release the guard so a later
 * refresh retries, up to ID_META_MAX_ATTEMPTS per page load.
 */
async function autoSyncIdentityMeta() {
  if (device.mode !== 'serial' && device.mode !== 'relay') return
  const npub = device.masters[0]?.npub
  if (!npub || idMetaSynced.has(npub)) return
  if ((idMetaAttempts.get(npub) ?? 0) >= ID_META_MAX_ATTEMPTS) return
  idMetaSynced.add(npub) // claim before the await so overlapping triggers no-op
  try {
    const name = await syncIdentityMeta()
    if (name) {
      addLog(`identity card synced to signer: ${name}`)
    } else {
      // No profile on the relays yet — release for a later refresh to retry.
      idMetaSynced.delete(npub)
      idMetaAttempts.set(npub, (idMetaAttempts.get(npub) ?? 0) + 1)
    }
  } catch (e) {
    idMetaSynced.delete(npub)
    idMetaAttempts.set(npub, (idMetaAttempts.get(npub) ?? 0) + 1)
    addLog(`identity card sync failed: ${e instanceof Error ? e.message : String(e)}`)
  }
}

let pollTimer: ReturnType<typeof setInterval> | null = null

export async function connectHttp(address: string) {
  await httpTransport.connect(address)
  // Fetch bridge info after connecting.
  try {
    device.bridgeInfo = await httpTransport.bridgeInfo()
  } catch { /* non-fatal */ }

  // Poll for state changes every 3 seconds while connected via HTTP.
  if (pollTimer) clearInterval(pollTimer)
  pollTimer = setInterval(async () => {
    if (!device.connected || device.mode !== 'http') {
      if (pollTimer) { clearInterval(pollTimer); pollTimer = null }
      return
    }
    try {
      await refreshMasters()
      await refreshSlots()
      device.approvals = await httpTransport.fetchApprovals()
    } catch { /* non-fatal */ }
  }, 3000)
}

// --- Relay transport (wifi-standalone devices, kind 24134) ---

let relayTransport: RelayTransport | null = null
let lastRelayAuditSeq = 0

// The signer's relay loop is single-threaded: a sign_event awaiting the physical
// button parks it for up to APPROVAL_TIMEOUT_SECS (30s, see firmware
// nip46_handler.rs) during which no other request is answered. Management writes
// must outwait that window, or a create/update issued while a signature is
// pending reports a spurious "timeout" (and a create loses its one-shot link).
const MGMT_WRITE_TIMEOUT_MS = 35_000
/** Pairing that may dial a new relay: TLS + WS handshake on the signer adds
 * up to ~10s of connect timeout on top of the normal management round trip. */
const MGMT_DIAL_TIMEOUT_MS = 50_000
const RELAY_STATUS_TIMEOUT_MS = 75_000
const HANDOFF_STATUS_REPUBLISH_MS = 5_000
const RELAY_POLL_MS = 4_000
let lastRelayRefreshLog = ''
const SLOT_FINGERPRINT_RE = /^[0-9a-f]{64}$/

function stopRelayPoll(): void {
  if (pollTimer) {
    clearInterval(pollTimer)
    pollTimer = null
  }
}

function startRelayPoll(): void {
  stopRelayPoll()
  pollTimer = setInterval(() => {
    if (!device.connected || device.mode !== 'relay') {
      stopRelayPoll()
      return
    }
    void relayRefresh()
  }, RELAY_POLL_MS)
}

function relaySummary(relays: string[]): string {
  if (relays.length === 0) return ''
  if (relays.length === 1) return relays[0]
  return `${relays.length} relays`
}

function sameRelayList(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((relay, index) => relay === b[index])
}

interface RelaySelection {
  transport: RelayTransport
  status?: Record<string, unknown>
}

export type RelayConnectProgress =
  | 'opening-relays'
  | 'relay-opened'
  | 'request-published'
  | 'waiting-for-signer'
  | 'response-authenticated'

function closeRelayTransports(transports: RelayTransport[], keep: RelayTransport): void {
  for (const t of transports) {
    if (t !== keep) t.close()
  }
}

async function selectRelayTransport(
  devicePubHex: string,
  relays: string[],
  requiredOperatorPubHex?: string,
  signal?: AbortSignal,
  onProgress?: (stage: RelayConnectProgress) => void,
): Promise<RelaySelection> {
  const operators = getOperatorCandidates()
  if (requiredOperatorPubHex) {
    const required = requiredOperatorPubHex.toLowerCase()
    const operator = operators.find((candidate) => candidate.pubHex === required)
    if (!operator) throw new Error('the imported operator credential is unavailable')
    const transport = new RelayTransport(devicePubHex, relays, operator.skHex)
    try {
      await transport.connect(signal)
      throwIfSignalAborted(signal)
      onProgress?.('relay-opened')
      // A phone handoff is not complete merely because a relay subscription
      // opened. Require an authenticated reply from this exact signer/operator.
      const status = await transport.requestReadWithRepublish(
        'get_status',
        {},
        RELAY_STATUS_TIMEOUT_MS,
        HANDOFF_STATUS_REPUBLISH_MS,
        {
          onPublishSubmitted: () => onProgress?.('request-published'),
          onPublishAccepted: () => onProgress?.('waiting-for-signer'),
        },
      )
      throwIfSignalAborted(signal)
      onProgress?.('response-authenticated')
      return { transport, status }
    } catch (error) {
      transport.close()
      throw error
    }
  }
  if (operators.length === 1) {
    const transport = new RelayTransport(devicePubHex, relays, operators[0]!.skHex)
    console.log(`[hw] relay connect → signer ${devicePubHex.slice(0, 8)}… on [${relays.join(', ')}] as operator ${transport.operatorPub.slice(0, 8)}…`)
    await transport.connect()
    return { transport }
  }

  console.log(`[hw] relay connect → signer ${devicePubHex.slice(0, 8)}… on [${relays.join(', ')}] trying ${operators.length} saved operator keys`)
  const transports = operators.map((op) => new RelayTransport(devicePubHex, relays, op.skHex))
  try {
    const selection = await firstFulfilled(transports.map(async (transport): Promise<RelaySelection> => {
      await transport.connect()
      const status = await transport.request('get_status', {}, RELAY_STATUS_TIMEOUT_MS)
      return { transport, status }
    }))
    closeRelayTransports(transports, selection.transport)
    console.log(`[hw] relay: signer answered operator ${selection.transport.operatorPub.slice(0, 8)}…`)
    return selection
  } catch (e) {
    transports.forEach((t) => t.close())
    if (e instanceof FirstFulfilledError) {
      const first = e.errors.find((err) => err instanceof Error) as Error | undefined
      throw first ?? new Error('timeout waiting for device (get_status)')
    }
    throw e
  }
}

function applyRelayStatus(raw: Record<string, unknown>) {
  appendRelayAudit(Array.isArray(raw.audit) ? raw.audit as RelayAuditEntry[] : [])
  const status: RelayStatus = {
    master_count: Number(raw.master_count ?? 0),
    slots: Number(raw.slots ?? 0),
    mode: String(raw.mode ?? 'wifi-standalone'),
    relay: String(raw.relay ?? ''),
    capabilities: Array.isArray(raw.capabilities)
      ? raw.capabilities.filter((value): value is string => typeof value === 'string')
      : [],
    ...(typeof raw.uptime_s === 'number' ? { uptime_s: raw.uptime_s } : {}),
    ...(typeof raw.last_reset === 'string' ? { last_reset: raw.last_reset } : {}),
    ...(typeof raw.crashed_during === 'string' ? { crashed_during: raw.crashed_during } : {}),
    ...(typeof raw.log_quiet === 'boolean' ? { log_quiet: raw.log_quiet } : {}),
    ...(typeof raw.version === 'string' ? { version: raw.version } : {}),
    ...(typeof raw.board === 'string' ? { board: raw.board } : {}),
  }
  device.relayStatus = status
  const masterHex = String(raw.master_npub_hex ?? '')
  if (masterHex) {
    let npub = masterHex
    try { npub = nip19.npubEncode(masterHex) } catch { /* keep hex */ }
    // Seed the addressed master only when it is not already known: the full
    // list_identities inventory supersedes this single entry, and re-seeding
    // on every status poll made the identity list flap between one and many
    // entries (the page visibly shuffled every few seconds).
    if (!device.masters.some((m) => m.npub === npub)) {
      const known = device.masters[0]
      device.masters = [{
        slot: 0,
        label: known?.label ?? 'master',
        mode: -1,
        modeLabel: status.mode.toUpperCase(),
        npub,
      }]
    }
  }
  // Knowing the master npub is all we need to dress the signer's screen —
  // over the relay too (firmware ≥0.9.12 accepts set_identity_meta).
  if (device.masters.length > 0) void autoSyncIdentityMeta()
}

/**
 * Connect to a wifi-standalone device over its relay, as the operator.
 * `devicePubHex` is the device MASTER pubkey (the kind-24134 mgmt address);
 * `relays` is where it listens. Uses the persisted operator secret to sign.
 */
export async function connectRelay(
  devicePubHex: string,
  relays: string[],
  label?: string,
  requiredOperatorPubHex?: string,
  signal?: AbortSignal,
  onProgress?: (stage: RelayConnectProgress) => void,
) {
  resetIdMetaSync() // a reconnect should retry the identity-card push, not stay given-up
  // A killed/reloaded mobile tab may have left an activated handoff whose
  // terminal route is not known yet. Subscribe to B + A from the password-free
  // journal so either commit or rollback remains reachable.
  const recoveryRelays = networkRecoveryRelays(devicePubHex, relays)
  onProgress?.('opening-relays')
  const { transport: t, status } = await selectRelayTransport(
    devicePubHex,
    recoveryRelays,
    requiredOperatorPubHex,
    signal,
    onProgress,
  )
  if (signal?.aborted) {
    t.close()
    throwIfSignalAborted(signal)
  }
  relayTransport = t
  resetRelayRefreshGuard()
  device.connectionGeneration += 1
  device.connected = true
  device.mode = 'relay'
  device.relayDevicePub = t.devicePub
  device.operatorPub = t.operatorPub
  device.portInfo = `${npubShort(devicePubHex)} · ${relaySummary(recoveryRelays)}`
  device.error = null
  device.masters = []
  device.slots = []
  // A relay session manages a single master; slot indices from a previous
  // USB or bridge session do not apply here.
  device.selectedSlot = 0
  device.signerActivity = []
  device.relays = recoveryRelays
  device.relayConfiguredRelays = null
  device.relayStatus = null
  lastRelayAuditSeq = 0
  rememberDevice(devicePubHex, relays, label)

  // First load, then poll for live status/clients every 4s while connected. A
  // protected phone handoff already proved the signer with get_status above;
  // surface that success immediately while the client list finishes in the
  // background. Normal/manual connects preserve their existing await contract.
  const initialRefresh = relayRefresh(status)
  if (requiredOperatorPubHex) {
    startRelayPoll()
    void initialRefresh
  } else {
    await initialRefresh
    startRelayPoll()
  }
}

/** Refresh masters (get_status) and clients (list_clients) over the relay.
 *  Guarded against overlap: on a slow link a refresh can outlast the 4s poll,
 *  and piling more requests onto a struggling connection only makes it worse, so
 *  a tick that finds one already in flight simply skips. */
let relayRefreshing = false
let relayRefreshRun = 0
let relayNetworkConfigUnsupported = false
let relayAuthorityEpoch = 0

function resetRelayRefreshGuard(): void {
  relayRefreshRun += 1
  relayRefreshing = false
  relayNetworkConfigUnsupported = false
  relayAuthorityEpoch += 1
}

function invalidateRelayAuthorityReads(): void {
  relayAuthorityEpoch += 1
}

function relayRefreshIsCurrent(
  current: RelayTransport,
  generation: number,
  authorityEpoch: number,
): boolean {
  return relayTransport === current
    && device.connected
    && device.mode === 'relay'
    && device.connectionGeneration === generation
    && relayAuthorityEpoch === authorityEpoch
}

async function relayRefresh(prefetchedStatus?: Record<string, unknown>) {
  if (!relayTransport || relayRefreshing) return
  const current = relayTransport
  const generation = device.connectionGeneration
  const authorityEpoch = relayAuthorityEpoch
  const run = ++relayRefreshRun
  relayRefreshing = true
  try {
    const raw = prefetchedStatus ?? await current.request('get_status', {}, RELAY_STATUS_TIMEOUT_MS)
    if (!relayRefreshIsCurrent(current, generation, authorityEpoch)) return
    applyRelayStatus(raw)
    const configuredRead = await readRelayConfiguredRelays(current)
    if (!relayRefreshIsCurrent(current, generation, authorityEpoch)) return
    if (configuredRead.unsupported) relayNetworkConfigUnsupported = true
    const configuredRelays = configuredRead.relays
    const previousConfiguredRelays = device.relayConfiguredRelays
    device.relayConfiguredRelays = configuredRelays
    if (configuredRelays?.length
      && (!previousConfiguredRelays
        || !sameRelayList(previousConfiguredRelays, configuredRelays))) {
      replaceDeviceRelays(current.devicePub, configuredRelays)
    }
    // Full identity inventory: every master (and derived persona) the signer
    // serves, not just the addressed one. The addressed identity stays first —
    // masters[0] drives the identity card, phone handoff and NIP-05 defaults.
    // Best-effort: an older signer only reports the addressed master here.
    try {
      const inv = await current.request('list_identities', {}, RELAY_STATUS_TIMEOUT_MS)
      if (!relayRefreshIsCurrent(current, generation, authorityEpoch)) return
      const rows = Array.isArray(inv.identities)
        ? inv.identities as Array<Record<string, unknown>>
        : []
      if (rows.length) {
        const addressedHex = current.devicePub.toLowerCase()
        const mapped = rows.map((r, i): MasterInfo => {
          const hex = String(r.npub_hex ?? '').toLowerCase()
          let npub = hex
          try { npub = nip19.npubEncode(hex) } catch { /* keep hex */ }
          if (r.kind === 'persona') {
            return { slot: Number(r.slot ?? 0), label: String(r.label ?? ''), npub, persona: true }
          }
          const addressed = typeof r.addressed === 'boolean' ? r.addressed : hex === addressedHex
          return {
            slot: Number(r.slot ?? i),
            label: String(r.label ?? ''),
            mode: -1,
            modeLabel: addressed
              ? (device.relayStatus?.mode ?? 'wifi-standalone').toUpperCase()
              : 'MASTER',
            npub,
            addressed,
            ...(typeof r.apps === 'number' ? { apps: r.apps } : {}),
          }
        })
        mapped.sort((a, b) =>
          Number(b.addressed ?? false) - Number(a.addressed ?? false)
          || Number(a.persona ?? false) - Number(b.persona ?? false)
          || a.slot - b.slot)
        // Only assign on real change: this refresh runs every few seconds and
        // replacing identical state makes the page shuffle under the user
        // (identity cards re-render while they are typing a new name).
        const firstInventory = !device.masters.some((m) => m.addressed !== undefined)
        if (JSON.stringify(device.masters) !== JSON.stringify(mapped)) {
          device.masters = mapped
        }
        // Pre-select the identity this session was connected to; after that
        // the operator's choice sticks.
        if (firstInventory) {
          device.selectedSlot = mapped.find((m) => m.addressed)?.slot ?? mapped[0]?.slot ?? 0
        }
      }
    } catch { /* older firmware — keep the status-derived single master */ }
    const res = await current.request('list_clients', {}, RELAY_STATUS_TIMEOUT_MS, relayMgmtTarget())
    if (!relayRefreshIsCurrent(current, generation, authorityEpoch)) return
    const clients = (res.clients as Array<Record<string, unknown>>) ?? []
    // Slot URIs are reusable credentials and numeric indices compact on revoke.
    // Never carry an index-keyed cache across a fresh authoritative listing;
    // remote reissue below is fingerprint-bound and can safely fetch it again.
    const nextSlots = clients.map((c) => ({
      slot_index: Number(c.slot_index),
      label: String(c.label ?? ''),
      secret: '',
      current_pubkey: (c.current_pubkey as string | null) ?? null,
      authorized_pubkeys: Array.isArray(c.authorized_pubkeys)
        ? c.authorized_pubkeys.filter((pk): pk is string => typeof pk === 'string')
        : [],
      allowed_methods: (c.allowed_methods as string[]) ?? [],
      allowed_kinds: (c.allowed_kinds as number[]) ?? [],
      auto_approve: Boolean(c.auto_approve),
      signing_approved: Boolean(c.signing_approved),
      strict_permissions: Boolean(c.strict_permissions),
      secret_fingerprint: typeof c.secret_fingerprint === 'string'
        && SLOT_FINGERPRINT_RE.test(c.secret_fingerprint.toLowerCase())
        ? c.secret_fingerprint.toLowerCase()
        : undefined,
    }))
    // Assign only on real change so the periodic refresh doesn't make the
    // Apps list (and everything below it) re-render under the user.
    if (JSON.stringify(device.slots) !== JSON.stringify(nextSlots)) {
      device.slotUris = {}
      device.slots = nextSlots
    }
    await recoverPendingNetworkRoute()
    if (!relayRefreshIsCurrent(current, generation, authorityEpoch)) return
    device.error = null
    lastRelayRefreshLog = ''
  } catch (e) {
    if (!relayRefreshIsCurrent(current, generation, authorityEpoch)) return
    const message = e instanceof Error ? e.message : 'Relay request failed'
    // A failed authenticated cycle cannot leave its preceding status/route
    // masquerading as current authority for phone pairing.
    device.relayStatus = null
    device.relayConfiguredRelays = null
    device.error = message
    logRelayRefreshIssue(message)
  } finally {
    if (relayRefreshRun === run) relayRefreshing = false
  }
}

/** Resolve the exact configured relay route from the same authenticated signer
 * session used for status. Cached/imported addresses only locate the signer;
 * they are never exported to another phone as if the device had confirmed
 * them. A live network trial remains intentionally unproven until terminal. */
interface RelayConfiguredRead {
  relays: string[] | null
  unsupported: boolean
}

async function readRelayConfiguredRelays(current: RelayTransport): Promise<RelayConfiguredRead> {
  if (relayNetworkConfigUnsupported) return { relays: [], unsupported: true }
  try {
    const state = await getNetworkConfigFrom(current, NETWORK_PROBE_TIMEOUT_MS)
    // Active A is not current-route proof while firmware is serving a live B
    // trial. Returning null explicitly invalidates any prior poll's A proof.
    if (state.trial) return { relays: null, unsupported: false }
    return {
      relays: state.active.mode === 'wifi' ? [...state.active.relays] : [],
      unsupported: false,
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    // Old firmware cannot provide an authenticated route. Mark the read as
    // terminally unavailable so the 4s poll does not hammer an unknown method;
    // the handoff UI remains failed closed with upgrade guidance.
    if (/unknown method.*get_network_config/i.test(message)) {
      return { relays: [], unsupported: true }
    }
    throw error
  }
}

let recoveringNetworkRoute = false

/**
 * Finish a network handoff that survived a mobile tab kill/reload. The journal
 * contains no SSID or password, only the two relay routes and tx/revision. We
 * collapse it only after authenticated device state proves a terminal outcome
 * (or reports a later revision with one of those routes active).
 */
async function recoverPendingNetworkRoute(): Promise<void> {
  const current = relayTransport
  if (!current || recoveringNetworkRoute) return
  const generation = device.connectionGeneration
  const authorityEpoch = relayAuthorityEpoch
  const pending = pendingNetworkHandoff(current.devicePub)
  if (!pending) return
  recoveringNetworkRoute = true
  try {
    const state = await getNetworkConfigFrom(current, NETWORK_PROBE_TIMEOUT_MS)
    if (!relayRefreshIsCurrent(current, generation, authorityEpoch)) return
    const terminal = state.last_result?.transaction_id === pending.transactionId
      && state.last_result.revision === pending.revision
      ? state.last_result.outcome
      : null
    const activeRelays = state.active.relays
    let terminalRelays: string[] | null = null
    if (terminal === 'committed' && sameRelayList(activeRelays, pending.candidateRelays)) {
      terminalRelays = pending.candidateRelays
    } else if ((terminal === 'aborted' || terminal === 'rolled_back')
      && sameRelayList(activeRelays, pending.oldRelays)) {
      terminalRelays = pending.oldRelays
    } else if (!state.trial && state.revision >= pending.revision) {
      // The one-record terminal result may eventually be superseded by a later
      // physical change. The signer's current redacted active route is still an
      // authenticated source of truth for safely collapsing this old journal.
      if (sameRelayList(activeRelays, pending.candidateRelays)) terminalRelays = pending.candidateRelays
      else if (sameRelayList(activeRelays, pending.oldRelays)) terminalRelays = pending.oldRelays
    }
    if (!terminalRelays) return

    // Persist the proven route before deleting the union journal. If storage is
    // unavailable, leave the journal intact so another reload still tries A+B.
    if (!replaceDeviceRelays(current.devicePub, terminalRelays)) return
    if (!clearPendingNetworkHandoff(current.devicePub)) return

    // Narrow this live session too. Failure is non-destructive: the current
    // union remains connected, while the next reload uses the proven route.
    let liveTransport = current
    let liveGeneration = generation
    let liveAuthorityEpoch = authorityEpoch
    if (!sameRelayList(current.relays, terminalRelays)) {
      const operators = getOperatorCandidates()
      const operator = operators.find((candidate) => candidate.pubHex === current.operatorPub)
        ?? (operators.length === 1 ? operators[0] : undefined)
      if (operator) {
        const narrowed = new RelayTransport(current.devicePub, terminalRelays, operator.skHex)
        try {
          await narrowed.connect()
          if (!relayRefreshIsCurrent(current, generation, authorityEpoch)) {
            narrowed.close()
            return
          }
          await narrowed.request('get_status', {}, NETWORK_PROBE_TIMEOUT_MS)
          if (!relayRefreshIsCurrent(current, generation, authorityEpoch)) {
            narrowed.close()
            return
          }
          relayTransport = narrowed
          resetRelayRefreshGuard()
          device.connectionGeneration += 1
          liveTransport = narrowed
          liveGeneration = device.connectionGeneration
          liveAuthorityEpoch = relayAuthorityEpoch
          current.close()
        } catch {
          narrowed.close()
        }
      }
    }
    if (!relayRefreshIsCurrent(liveTransport, liveGeneration, liveAuthorityEpoch)) return
    device.relays = [...terminalRelays]
    device.relayConfiguredRelays = [...terminalRelays]
    device.portInfo = `${npubShort(liveTransport.devicePub)} · ${relaySummary(terminalRelays)}`
    addLog(`Recovered network transaction ${pending.transactionId}; using its ${terminal === 'committed' ? 'committed' : 'last known-good'} relay route.`)
  } catch {
    // Still pending/offline: keep A+B and retry after the next successful poll.
  } finally {
    recoveringNetworkRoute = false
  }
}

function logRelayRefreshIssue(message: string) {
  const timedOut = /timeout waiting for device \((get_status|list_clients)\)/i.test(message)
  const line = timedOut
    ? `WiFi status read timed out; signer may be busy signing or reconnecting. Signed-event audit will appear after the next successful refresh. (${message})`
    : `WiFi status refresh failed: ${message}`
  if (line === lastRelayRefreshLog) return
  lastRelayRefreshLog = line
  addLog(line)
}

function auditKindLabel(kind: number): string {
  const label = kindLabel(kind)
  const known = /^(.+) \((\d+)\)$/.exec(label)
  return known ? `${known[1]} (kind ${known[2]})` : `unknown Nostr kind ${kind}`
}

function auditAction(method: string, outcome: string): string {
  if (method === 'sign_event' && outcome === 'signed') return 'signed'
  if (outcome.startsWith('error:')) return `${method} failed (${outcome.slice('error:'.length).trim()})`
  return `${method} ${outcome}`
}

function relayAuditLine(entry: RelayAuditEntry): string {
  const activity = signerActivityFromRelayAudit(entry)
  const method = activity.method
  const outcome = activity.outcome
  const label = activity.app
  const client = activity.client
  const fromClient = client ? ` from client ${client}` : ''
  const preview = activity.preview ? `; preview: ${activity.preview}` : ''
  const action = auditAction(method, outcome)
  const target = activity.kind !== null ? ` ${activity.kindText}` : ''
  return `Sign audit: ${action}${target} for ${label}${fromClient}${preview}`
}

function signerActivityFromRelayAudit(entry: RelayAuditEntry): Omit<SignerActivityEntry, 'id' | 'at'> {
  const method = typeof entry.method === 'string' && entry.method ? entry.method : 'sign_event'
  const rawKind = entry.kind
  const kind = typeof rawKind === 'number' || typeof rawKind === 'string' ? Number(rawKind) : NaN
  const outcome = typeof entry.outcome === 'string' && entry.outcome ? entry.outcome : 'handled'
  const app = typeof entry.label === 'string' && entry.label ? entry.label : 'unknown app'
  const client = typeof entry.client === 'string' && entry.client ? entry.client.slice(0, 8) : ''
  const preview = typeof entry.preview === 'string' && entry.preview ? entry.preview : ''
  return {
    source: 'relay-audit',
    method,
    outcome,
    action: auditAction(method, outcome),
    app,
    client,
    kind: Number.isFinite(kind) ? kind : null,
    kindText: Number.isFinite(kind) ? auditKindLabel(kind) : '',
    preview,
  }
}

function appendRelayAudit(entries: RelayAuditEntry[]) {
  for (const entry of entries) {
    const seq = Number(entry.seq ?? 0)
    if (!Number.isFinite(seq) || seq <= lastRelayAuditSeq) continue
    lastRelayAuditSeq = Math.max(lastRelayAuditSeq, seq)
    appendSignerActivity(signerActivityFromRelayAudit(entry))
    addLog(relayAuditLine(entry))
  }
}

/**
 * Hex pubkey of the identity relay management should address — the SELECTED
 * identity when it differs from the session's primary. The firmware resolves
 * the target from the request's #p tag, so every identity the signer serves is
 * manageable from one session; undefined addresses the primary.
 */
function relayMgmtTarget(): string | undefined {
  if (!relayTransport) return undefined
  const m = device.masters.find((x) => !x.persona && x.slot === device.selectedSlot)
  if (!m) return undefined
  try {
    const decoded = nip19.decode(m.npub)
    if (decoded.type !== 'npub') return undefined
    const hex = (decoded.data as string).toLowerCase()
    return hex === relayTransport.devicePub ? undefined : hex
  } catch { return undefined }
}

/**
 * Create a client over the relay with one exact, atomic policy. The versioned
 * method makes older firmware fail before mutation instead of ignoring fields.
 */
export async function relayCreateClient(
  label: string,
  policy: ExactClientPolicy,
): Promise<{ bunker_uri: string; secret: string; signing_approved: boolean; slot_index: number; secret_fingerprint: string }> {
  if (!relayTransport) throw new Error('not connected over relay')
  // Capture once so the create and any cleanup revoke address the SAME identity.
  const target = relayMgmtTarget()
  let res: Record<string, unknown>
  try {
    res = await relayTransport.request('create_client_v2', { label, policy }, MGMT_WRITE_TIMEOUT_MS, target)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (/unknown method.*create_client_v2/i.test(message)) {
      throw new Error('This signer firmware is too old for safe scoped remote signing. Update the signer over USB, then try again.')
    }
    return rethrowAfterManagementConflict(error)
  }
  const slotIndex = Number(res.slot_index ?? -1)
  const fingerprint = typeof res.secret_fingerprint === 'string'
    ? res.secret_fingerprint.toLowerCase()
    : ''
  const validSlot = Number.isSafeInteger(slotIndex) && slotIndex >= 0 && slotIndex <= 255
  const validFingerprint = SLOT_FINGERPRINT_RE.test(fingerprint)
  if (Number(res.policy_version) !== 2 || !policiesEqual(policy, res) || !validSlot || !validFingerprint) {
    if (validSlot && validFingerprint) {
      try {
        await relayTransport.request('revoke_client', {
          slot_index: slotIndex,
          expected_secret_fingerprint: fingerprint,
        }, MGMT_WRITE_TIMEOUT_MS, target)
      }
      catch { /* do not expose the credential when cleanup cannot be confirmed */ }
    }
    await relayRefresh()
    throw new Error('The signer did not confirm the exact app policy and slot credential, so the connection was not exposed.')
  }
  await relayRefresh()
  return {
    bunker_uri: String(res.bunker_uri ?? ''),
    secret: String(res.secret ?? ''),
    signing_approved: Boolean(res.signing_approved),
    slot_index: slotIndex,
    secret_fingerprint: fingerprint,
  }
}

function isManagementConflict(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /Another phone or manager changed this signer first|slot.*(?:fingerprint|credential).*(?:mismatch|changed)|expected_secret_fingerprint/i.test(message)
}

function requireExpectedSlotFingerprint(slotIndex: number, expectedFingerprint?: string): string {
  const clean = expectedFingerprint?.trim().toLowerCase() ?? ''
  if (!SLOT_FINGERPRINT_RE.test(clean)) {
    throw new Error(`App slot ${slotIndex} has no safe credential fingerprint. Refresh it; if the problem remains, update the signer over USB before changing remote apps.`)
  }
  return clean
}

async function rethrowAfterManagementConflict(error: unknown): Promise<never> {
  if (isManagementConflict(error)) {
    // An index-sensitive action must not be offered against the stale slot list:
    // another manager may have revoked and reused that numeric slot. Refresh
    // before returning control to the UI; the operation itself is never retried.
    await relayRefresh()
  }
  throw error
}

/** Grant a slot signing authority over the relay (operator-authorised). */
export async function relayApproveSigning(slotIndex: number, expectedFingerprint?: string): Promise<void> {
  if (!relayTransport) throw new Error('not connected over relay')
  const fingerprint = requireExpectedSlotFingerprint(slotIndex, expectedFingerprint)
  try {
    await relayTransport.request('approve_signing', {
      slot_index: slotIndex,
      expected_secret_fingerprint: fingerprint,
    }, MGMT_WRITE_TIMEOUT_MS, relayMgmtTarget())
  } catch (error) {
    return rethrowAfterManagementConflict(error)
  }
  await relayRefresh()
}

/** Revoke a client slot over the relay (operator-authorised). */
export async function relayRevokeClient(slotIndex: number, expectedFingerprint?: string): Promise<void> {
  if (!relayTransport) throw new Error('not connected over relay')
  const fingerprint = requireExpectedSlotFingerprint(slotIndex, expectedFingerprint)
  try {
    await relayTransport.request('revoke_client', {
      slot_index: slotIndex,
      expected_secret_fingerprint: fingerprint,
    }, MGMT_WRITE_TIMEOUT_MS, relayMgmtTarget())
  } catch (error) {
    return rethrowAfterManagementConflict(error)
  }
  await relayRefresh()
}

/** Update a client slot (label / kind perms / auto-approve) over the relay. */
export async function relayUpdateClient(
  slotIndex: number,
  changes: { label?: string; allowed_methods?: string[]; allowed_kinds?: number[]; auto_approve?: boolean },
  expectedFingerprint?: string,
): Promise<void> {
  if (!relayTransport) throw new Error('not connected over relay')
  const fingerprint = requireExpectedSlotFingerprint(slotIndex, expectedFingerprint)
  try {
    await relayTransport.request('update_client', {
      slot_index: slotIndex,
      expected_secret_fingerprint: fingerprint,
      ...changes,
    }, MGMT_WRITE_TIMEOUT_MS, relayMgmtTarget())
  } catch (error) {
    return rethrowAfterManagementConflict(error)
  }
  await relayRefresh()
}

/**
 * Set the signer's runtime log verbosity over the relay. Quiet keeps warnings
 * only — on boards whose activity LED is wired to the log UART (the
 * T-Display's blue light), this is the calm-the-light control.
 */
export async function relaySetLogQuiet(quiet: boolean): Promise<void> {
  if (!relayTransport) throw new Error('not connected over relay')
  await relayTransport.request('set_log_level', { quiet }, MGMT_WRITE_TIMEOUT_MS)
  await relayRefresh()
}

export async function refreshRelayAudit(): Promise<void> {
  if (device.mode !== 'relay') throw new Error('Connect over WiFi to refresh signer audit.')
  await relayRefresh()
}

export async function disconnect() {
  device.connectionGeneration += 1
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null }
  device.slotUris = {} // session-only links; don't carry them to the next signer
  device.wifiJoinError = null
  if (device.mode === 'serial') {
    // Any late mutation continuation is generation-stale and must not be able
    // to read/publish authority from a subsequently attached signer.
    usbAuthorityMutationToken = null
    await serialTransport.disconnect()
  } else if (device.mode === 'http') {
    await httpTransport.disconnect()
  } else if (device.mode === 'relay') {
    relayTransport?.close()
    relayTransport = null
    resetRelayRefreshGuard() // let the next connection's first refresh run
    lastRelayAuditSeq = 0
    lastRelayRefreshLog = ''
    device.connected = false
    device.mode = 'none'
    device.relayDevicePub = ''
    device.portInfo = ''
    device.masters = []
    device.slots = []
    device.relays = []
    device.relayConfiguredRelays = null
    device.signerActivity = []
    device.relayStatus = null
  }
}

/**
 * Re-attempt the relay connection to the same signer — the "Try again" after a
 * WiFi management timeout. Reuses the current transport's target (npub + relays)
 * so nothing needs re-entering, tears the stale transport down first, then
 * reconnects. Errors surface through device.error like the first attempt.
 */
export async function reconnectRelay(): Promise<void> {
  const t = relayTransport
  if (!t) return
  const pubHex = t.devicePub
  const relays = [...t.relays]
  const label = device.masters[0]?.label
  await disconnect()
  await connectRelay(pubHex, relays, label)
}

const NETWORK_RECONNECT_WINDOW_MS = 120_000
const NETWORK_PROBE_TIMEOUT_MS = 8_000
const NETWORK_PROBE_PAUSE_MS = 1_200

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function redactedNetworkConfig(value: unknown): RedactedNetworkConfig {
  const raw = record(value)
  if (!raw) throw new Error('The signer returned an invalid network configuration.')
  const mode = raw.mode === 'usb' ? 'usb' : raw.mode === 'wifi' ? 'wifi' : null
  if (!mode) throw new Error('The signer returned an invalid network mode.')
  return {
    mode,
    ssid: typeof raw.ssid === 'string' ? raw.ssid : '',
    relays: Array.isArray(raw.relays)
      ? raw.relays.filter((relay): relay is string => typeof relay === 'string' && !!relay.trim())
      : [],
    password_set: raw.password_set === true,
  }
}

function remoteNetworkState(raw: Record<string, unknown>): RemoteNetworkState {
  // `network_revision` was used by the first firmware implementation; accept
  // it as a read-only alias while all mutation checks still bind the value.
  const revision = Number(raw.revision ?? raw.network_revision)
  if (!Number.isSafeInteger(revision) || revision < 0) {
    throw new Error('The signer returned an invalid network configuration revision.')
  }
  const active = redactedNetworkConfig(raw.active)
  const lastRaw = record(raw.last_result)
  const lastOutcome = lastRaw?.outcome
  const lastRevision = Number(lastRaw?.revision)
  const lastResult = lastRaw
    && typeof lastRaw.transaction_id === 'string'
    && !!lastRaw.transaction_id
    && Number.isSafeInteger(lastRevision)
    && (lastOutcome === 'committed' || lastOutcome === 'aborted' || lastOutcome === 'rolled_back')
    ? {
        transaction_id: lastRaw.transaction_id,
        revision: lastRevision,
        outcome: lastOutcome,
      } as RemoteNetworkState['last_result']
    : null
  if (raw.trial === null || raw.trial === undefined) {
    return { revision, active, trial: null, last_result: lastResult }
  }
  const trialRaw = record(raw.trial)
  if (!trialRaw || typeof trialRaw.transaction_id !== 'string' || !trialRaw.transaction_id) {
    throw new Error('The signer returned an invalid staged network transaction.')
  }
  if (trialRaw.phase !== 'staged' && trialRaw.phase !== 'trying') {
    throw new Error('The signer returned an invalid staged network phase.')
  }
  const trialRevision = Number(trialRaw.revision ?? revision)
  if (trialRevision !== revision) {
    throw new Error('The signer returned a staged transaction under the wrong network revision.')
  }
  return {
    revision,
    active,
    last_result: lastResult,
    trial: {
      ...redactedNetworkConfig(trialRaw),
      transaction_id: trialRaw.transaction_id,
      attempted: Number.isFinite(Number(trialRaw.attempted)) ? Number(trialRaw.attempted) : 0,
      phase: trialRaw.phase,
    },
  }
}

async function getNetworkConfigFrom(
  transport: RelayTransport,
  timeoutMs = MGMT_WRITE_TIMEOUT_MS,
): Promise<RemoteNetworkState> {
  const raw = await transport.request('get_network_config', {}, timeoutMs)
  return remoteNetworkState(raw)
}

/** Read the active network config over authenticated relay management. The
 * password is always redacted by the signer and discarded again here. */
export async function getNetworkConfig(): Promise<RemoteNetworkState> {
  if (device.mode !== 'relay' || !relayTransport) {
    throw new Error('Remote network settings need a WiFi management connection.')
  }
  try {
    return await getNetworkConfigFrom(relayTransport)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (/unknown method.*get_network_config/i.test(message)) {
      throw new Error('This signer firmware is too old for safe remote network changes. Update it over USB first.')
    }
    throw error
  }
}

/** Discard an inert staged transaction left behind by a closed/reloaded phone.
 * A TRYING transaction is owned by firmware's reconnect/rollback state machine
 * and is intentionally not mutated through this recovery action. */
export async function abortNetworkConfig(transactionId: string): Promise<RemoteNetworkState> {
  if (device.mode !== 'relay' || !relayTransport) {
    throw new Error('Remote network settings need a WiFi management connection.')
  }
  const before = await getNetworkConfigFrom(relayTransport)
  if (!before.trial || before.trial.transaction_id !== transactionId) {
    throw new Error('That staged network transaction is no longer pending.')
  }
  if (before.trial.phase !== 'staged') {
    throw new Error('This network change is already being tried. Wait for it to commit or roll back.')
  }
  const response = await relayTransport.request('abort_network_config', {
    transaction_id: transactionId,
    revision: before.revision,
  }, MGMT_WRITE_TIMEOUT_MS)
  if (response.transaction_id !== transactionId
    || response.revision !== before.revision
    || response.aborted !== true) {
    throw new Error('The signer did not confirm that the staged network change was discarded.')
  }
  const after = await getNetworkConfigFrom(relayTransport)
  if (!after.trial) device.relayConfiguredRelays = [...after.active.relays]
  return after
}

function cleanRelaySet(
  relays: string[],
  options: { deduplicate?: boolean; maxRelays?: number } = {},
): string[] {
  const deduplicate = options.deduplicate ?? false
  const maxRelays = options.maxRelays ?? 8
  const seen = new Set<string>()
  const clean: string[] = []
  for (const value of relays) {
    const relay = value
    if (!relay.startsWith('wss://')) {
      throw new Error(`Remote relay addresses must start with wss:// (${value})`)
    }
    if (utf8Length(relay) > 255) throw new Error('Remote relay addresses must be no longer than 255 bytes.')
    if ([...relay].some((char) => /\s/.test(char) || char.codePointAt(0)! < 0x20 || char.codePointAt(0) === 0x7f)) {
      throw new Error(`Remote relay addresses cannot contain whitespace or control characters (${value})`)
    }

    const afterScheme = relay.slice(6)
    const suffixAt = afterScheme.search(/[/?#]/)
    const authority = suffixAt === -1 ? afterScheme : afterScheme.slice(0, suffixAt)
    const suffix = suffixAt === -1 ? '' : afterScheme.slice(suffixAt)
    if (authority.includes('@')) {
      throw new Error(`Remote relay addresses cannot contain credentials (${value})`)
    }
    const host = authority.split(':')[0] ?? ''
    if (!host
      || !/[A-Za-z0-9]/.test(host)
      || !/^[A-Za-z0-9.-]+$/.test(host)) {
      throw new Error(`Remote relay addresses require an ASCII hostname using letters, digits, dots, or hyphens (${value})`)
    }
    const port = authority.slice(host.length)
    if (port && port !== ':443') {
      throw new Error(`Remote relay URL ports must be 443 (${value})`)
    }
    if (suffix && suffix !== '/') {
      throw new Error(`Remote relay URL paths, queries, and fragments are not supported (${value})`)
    }
    const key = relay.replace(/\/+$/, '').toLowerCase()
    if (seen.has(key)) {
      if (deduplicate) continue
      throw new Error(`Remote relay URLs must not be duplicated (${value})`)
    }
    seen.add(key)
    clean.push(relay)
  }
  if (clean.length > maxRelays) {
    const limit = maxRelays === 8 ? 'eight' : String(maxRelays)
    throw new Error(`Remote network settings support at most ${limit} relays.`)
  }
  return clean
}

function utf8Length(value: string): number {
  return new TextEncoder().encode(value).length
}

const REMOTE_NET_CONFIG_MAX_BYTES = 512

/** Mirror firmware's serialized NVS candidate ceiling. `get_network_config`
 * redacts a kept password, so model its largest valid JSON representation:
 * 63 quote bytes become 126 escaped bytes. The management pubkey is always a
 * fixed 64-hex field on an authenticated relay connection. */
function validateRemoteCandidateSerializedSize(
  active: RedactedNetworkConfig,
  patch: RemoteNetworkPatch,
): void {
  const password = patch.password ?? { action: 'keep' as const }
  const candidatePassword = password.action === 'set'
    ? password.value
    : password.action === 'clear'
      ? ''
      : active.password_set ? '"'.repeat(63) : ''
  const candidate = {
    ssid: patch.ssid ?? active.ssid,
    password: candidatePassword,
    relays: patch.relays ?? active.relays,
    mode: 'wifi',
    op_mgmt: '0'.repeat(64),
  }
  const serializedBytes = utf8Length(JSON.stringify(candidate))
  if (serializedBytes > REMOTE_NET_CONFIG_MAX_BYTES) {
    throw new Error(`The staged network configuration may serialize to ${serializedBytes} bytes, exceeding the signer's 512-byte limit.`)
  }
}

function safeRemoteNetworkPatch(patch: RemoteNetworkPatch): RemoteNetworkPatch {
  const safe: RemoteNetworkPatch = {}
  if (patch.mode !== undefined) {
    if (patch.mode !== 'wifi') throw new Error('A remote session cannot switch the signer to USB-only mode.')
    safe.mode = 'wifi'
  }
  if (patch.ssid !== undefined) {
    const length = utf8Length(patch.ssid)
    if (length < 1 || length > 32) throw new Error('A WiFi SSID must be 1–32 bytes.')
    if ([...patch.ssid].some((char) => char.codePointAt(0)! < 0x20 || char.codePointAt(0) === 0x7f)) {
      throw new Error('A WiFi SSID cannot contain control characters.')
    }
    safe.ssid = patch.ssid
  }
  if (patch.relays !== undefined) {
    const relays = cleanRelaySet(patch.relays)
    if (relays.length === 0) throw new Error('WiFi mode needs at least one relay.')
    safe.relays = relays
  }
  const password = patch.password ?? { action: 'keep' as const }
  if (password.action === 'set') {
    const length = utf8Length(password.value)
    const rawPsk = length === 64 && /^[0-9a-f]{64}$/i.test(password.value)
    if (!(length >= 8 && length <= 63) && !rawPsk) {
      throw new Error('A WiFi password must be 8–63 bytes, or a 64-character hexadecimal PSK.')
    }
    if ([...password.value].some((char) => char.codePointAt(0)! < 0x20 || char.codePointAt(0) === 0x7f)) {
      throw new Error('A WiFi password cannot contain control characters.')
    }
    safe.password = { action: 'set', value: password.value }
  } else if (password.action === 'clear') {
    safe.password = { action: 'clear' }
  } else {
    safe.password = { action: 'keep' }
  }
  return safe
}

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function newNetworkTransactionId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

function expectedRemoteNetworkConfig(
  active: RedactedNetworkConfig,
  patch: RemoteNetworkPatch,
): RedactedNetworkConfig {
  const password = patch.password ?? { action: 'keep' as const }
  return {
    mode: 'wifi',
    ssid: patch.ssid ?? active.ssid,
    relays: patch.relays ?? active.relays,
    password_set: password.action === 'set' ? true
      : password.action === 'clear' ? false
        : active.password_set,
  }
}

function sameRedactedNetworkConfig(a: RedactedNetworkConfig, b: RedactedNetworkConfig): boolean {
  return a.mode === b.mode
    && a.ssid === b.ssid
    && a.password_set === b.password_set
    && a.relays.length === b.relays.length
    && a.relays.every((relay, index) => relay === b.relays[index])
}

function isCommittedNetworkState(
  state: RemoteNetworkState,
  transactionId: string,
  revision: number,
  expectedActive: RedactedNetworkConfig,
): boolean {
  return state.revision === revision
    && state.trial === null
    && sameRedactedNetworkConfig(state.active, expectedActive)
    && state.last_result?.transaction_id === transactionId
    && state.last_result.revision === revision
    && state.last_result.outcome === 'committed'
}

/**
 * Safely change a remote signer's WiFi config:
 *
 * 1. read a revision, open a handoff subscription across old + candidate relays;
 * 2. stage under a caller-generated transaction id without changing the live network;
 * 3. explicitly activate, then reconnect and require that transaction in trial mode;
 * 4. commit, then (and only then) replace the locally remembered relay set.
 *
 * A failed observation or commit sends a best-effort abort. Firmware also owns
 * the trial rollback timer, so losing the phone mid-flight cannot strand the
 * signer on an unconfirmed network.
 */
export async function configureNetworkRemotely(patch: RemoteNetworkPatch): Promise<RemoteNetworkState> {
  const originalTransport = relayTransport
  if (device.mode !== 'relay' || !originalTransport) {
    throw new Error('Remote network settings need a WiFi management connection.')
  }

  const safePatch = safeRemoteNetworkPatch(patch)
  const operators = getOperatorCandidates()
  const operator = operators.find((candidate) => candidate.pubHex === originalTransport.operatorPub)
    ?? (operators.length === 1 ? operators[0] : undefined)
  if (!operator) throw new Error('The operator key for this signer is no longer available in this browser.')

  stopRelayPoll()
  let before: RemoteNetworkState
  let originalRelays: string[]
  let nextRelays: string[]
  let candidateRelays: string[]
  try {
    before = await getNetworkConfigFrom(originalTransport)
    // The live transport can be an A+B crash-recovery union. Firmware's
    // authenticated active config is the exact committed A route and the
    // default candidate relay set for a password/SSID-only patch.
    originalRelays = cleanRelaySet(before.active.relays)
    device.relayConfiguredRelays = before.trial ? null : [...originalRelays]
    nextRelays = safePatch.relays ?? originalRelays
    validateRemoteCandidateSerializedSize(
      { ...before.active, relays: originalRelays },
      safePatch,
    )
    // This transport is an internal recovery union, not a firmware candidate;
    // each side was already validated at the firmware limit of eight.
    candidateRelays = cleanRelaySet(
      [...nextRelays, ...originalRelays],
      { deduplicate: true, maxRelays: 16 },
    )
  } catch (error) {
    if (device.connected && device.mode === 'relay') startRelayPoll()
    throw error
  }

  // Subscribe to candidate relays before asking the signer to reboot. That
  // closes the race where its first trial-mode response arrives before the
  // phone has re-subscribed on the new route.
  const handoff = new RelayTransport(originalTransport.devicePub, candidateRelays, operator.skHex)
  const candidateProof = new RelayTransport(originalTransport.devicePub, nextRelays, operator.skHex)
  const transactionId = newNetworkTransactionId()
  let acceptedRevision = 0
  let stageAttempted = false
  let journaled = false
  let switched = false
  let committed = false
  try {
    if (before.trial) {
      throw new Error(`The signer already has a ${before.trial.phase} network transaction (${before.trial.transaction_id}). Wait for it to finish or abort it before starting another.`)
    }
    if (safePatch.ssid !== undefined
      && safePatch.ssid !== before.active.ssid
      && (safePatch.password?.action ?? 'keep') === 'keep') {
      throw new Error('Changing the WiFi name remotely needs a new password, or an explicit choice to clear it for an open network. Blank can only keep the password when the SSID is unchanged.')
    }
    acceptedRevision = before.revision + 1
    if (!Number.isSafeInteger(acceptedRevision)) throw new Error('The signer network revision is too large to update safely.')
    const expectedCandidate = expectedRemoteNetworkConfig(before.active, safePatch)
    await handoff.connect()
    await candidateProof.connect()
    let staged: Record<string, unknown> | null = null
    let stageFailure: unknown = null
    try {
      stageAttempted = true
      staged = await originalTransport.request('stage_network_config', {
        transaction_id: transactionId,
        base_revision: before.revision,
        patch: safePatch,
      }, MGMT_WRITE_TIMEOUT_MS)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (/unknown method.*stage_network_config/i.test(message)) {
        throw new Error('This signer firmware is too old for safe remote network changes. Update it over USB first.')
      }
      // Never obtain a fresh challenge and replay an ambiguously acknowledged
      // mutation. A timeout/publish failure is resolved from authenticated
      // state below; explicit firmware errors prove nothing was staged.
      if (!/timeout waiting for device|failed to publish/i.test(message)) throw error
      stageFailure = error
    }

    const stageAckValid = staged?.transaction_id === transactionId
      && staged.staged === true
      && staged.revision === acceptedRevision
    if (!stageAckValid) {
      let resolved = false
      try {
        const state = await getNetworkConfigFrom(originalTransport, NETWORK_PROBE_TIMEOUT_MS)
        resolved = state.revision === acceptedRevision
          && state.trial?.transaction_id === transactionId
          && state.trial.phase === 'staged'
          && sameRedactedNetworkConfig(state.trial, expectedCandidate)
      } catch { /* preserve the original ambiguous stage failure below */ }
      if (!resolved) {
        if (stageFailure) throw stageFailure
        throw new Error('The signer did not confirm the staged network transaction; nothing was activated.')
      }
    }

    // This is the mobile page-kill boundary. Do not activate B until A+B and
    // the exact tx/revision have been durably read back from password-free
    // browser storage; a reload can then reconnect and resolve either outcome.
    journaled = savePendingNetworkHandoff({
      devicePubHex: originalTransport.devicePub,
      transactionId,
      revision: acceptedRevision,
      oldRelays: originalRelays,
      candidateRelays: nextRelays,
    })
    if (!journaled) {
      throw new Error('Sapwood could not save a recovery route in this browser, so the staged network change was not activated.')
    }

    // Stage is inert and power-loss safe. Only this second authenticated call
    // asks firmware to try the candidate and schedule a reboot after replying.
    // From this point either route may become current, so phone pairing stays
    // locked until commit/rollback proves one exact terminal relay set.
    invalidateRelayAuthorityReads()
    device.relayConfiguredRelays = null
    try {
      const activation = await originalTransport.request(
        'activate_network_config',
        { transaction_id: transactionId, revision: acceptedRevision },
        MGMT_WRITE_TIMEOUT_MS,
      )
      if (activation.transaction_id !== transactionId
        || activation.revision !== acceptedRevision
        || (activation.phase !== undefined && activation.phase !== 'trying')
        || activation.rebooting !== true) {
        throw new Error('The signer did not confirm activation of the staged network transaction.')
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (/unknown method.*activate_network_config/i.test(message)) {
        throw new Error('This signer firmware is too old for safe remote network changes. Update it over USB first.')
      }
      // A lost activation ACK is ambiguous: because the signer replies before
      // scheduling reboot, try the candidate route and commit only if the exact
      // transaction appears there. Explicit firmware errors still stop here.
      if (!/timeout waiting for device|failed to publish/i.test(message)) throw error
    }

    relayTransport = handoff
    switched = true
    resetRelayRefreshGuard()
    // Keep the original old-relays-only transport subscribed but idle until
    // commit. It is the clean rollback route if the candidate cannot prove
    // itself; the union handoff is used only to issue the abort.

    const deadline = Date.now() + NETWORK_RECONNECT_WINDOW_MS
    let observed: RemoteNetworkState | null = null
    while (Date.now() < deadline) {
      try {
        // Proof comes from a transport scoped to candidate relays only. Firmware
        // enters TRYING before reboot, so a union transport could otherwise see
        // that phase on the old live route and mistake it for a successful boot.
        const state = await getNetworkConfigFrom(candidateProof, NETWORK_PROBE_TIMEOUT_MS)
        if (state.trial?.transaction_id === transactionId) {
          if (state.revision !== acceptedRevision) {
            throw new Error('The signer reported the right transaction under the wrong network revision; refusing to commit it.')
          }
          if (!sameRedactedNetworkConfig(state.trial, expectedCandidate)) {
            throw new Error('The signer reconnected with a different network candidate than Sapwood staged; refusing to commit it.')
          }
          if (state.trial.phase === 'trying' && state.trial.attempted >= 1) {
            observed = state
            break
          }
        }
        if (state.trial && state.trial.transaction_id !== transactionId) {
          throw new Error('The signer reported a different staged network transaction; refusing to commit it.')
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        if (!/timeout waiting for device|failed to publish|transport closed/i.test(message)) throw error
      }
      await pause(NETWORK_PROBE_PAUSE_MS)
    }
    if (!observed) {
      throw new Error('The signer did not reconnect on the staged network in time. It will roll back to the previous settings.')
    }

    const expectedActive = expectedCandidate
    let terminalState: RemoteNetworkState | null = null
    try {
      const commit = await candidateProof.request(
        'commit_network_config',
        { transaction_id: transactionId, revision: acceptedRevision },
        MGMT_WRITE_TIMEOUT_MS,
      )
      if (commit.transaction_id !== transactionId
        || commit.committed !== true) {
        throw new Error('The signer did not confirm that the network transaction was committed.')
      }
      if (commit.revision !== acceptedRevision) {
        throw new Error('The signer confirmed the network transaction under the wrong revision.')
      }
      committed = true
      // Exact tx/revision/committed fields are an authoritative terminal ACK.
      // Return terminal B even though the only pre-commit state we observed was
      // active A + trial B; no stale trial leaks back into the UI.
      terminalState = {
        revision: acceptedRevision,
        active: expectedActive,
        trial: null,
        last_result: {
          transaction_id: transactionId,
          revision: acceptedRevision,
          outcome: 'committed',
        },
      }
    } catch (error) {
      // Once the commit request has been published, *every* error is ambiguous:
      // the reply may be lost, malformed, or report a cleanup failure after the
      // firmware's durable commit marker was already written. Always resolve
      // that ambiguity from terminal state before attempting rollback.
      try {
        const confirmed = await getNetworkConfigFrom(candidateProof, NETWORK_PROBE_TIMEOUT_MS)
        committed = isCommittedNetworkState(
          confirmed,
          transactionId,
          acceptedRevision,
          expectedActive,
        )
        if (committed) terminalState = confirmed
      } catch { /* keep the original ambiguous commit error */ }
      if (!committed) throw error
    }

    // A lost ACK has no constructed state, so require the durable terminal
    // record read back from the candidate route before updating local routing.
    if (!terminalState) {
      const confirmed = await getNetworkConfigFrom(candidateProof, NETWORK_PROBE_TIMEOUT_MS)
      if (!isCommittedNetworkState(confirmed, transactionId, acceptedRevision, expectedActive)) {
        throw new Error('The signer acknowledged commit but did not report the matching terminal network state.')
      }
      terminalState = confirmed
    }

    // The commit reply is the boundary: before this point candidate relays must
    // never overwrite the last known-good route in local storage.
    const routeRemembered = replaceDeviceRelays(originalTransport.devicePub, nextRelays) !== null
    if (routeRemembered) clearPendingNetworkHandoff(originalTransport.devicePub)

    // Candidate proof was scoped to the new relays from the start; promote it
    // as the final live transport and drop the temporary old+new union.
    relayTransport = candidateProof
    handoff.close()
    originalTransport.close()
    device.relays = [...nextRelays]
    device.relayConfiguredRelays = [...nextRelays]
    device.portInfo = `${npubShort(originalTransport.devicePub)} · ${relaySummary(nextRelays)}`
    device.error = null
    addLog(`Network transaction ${transactionId} committed after reconnecting on the staged route.`)
    if (!routeRemembered) {
      // Storage can be unavailable (private mode/quota). The candidate-only
      // transport is already live, so never tear it down after a real commit;
      // warn that a reload may need the address entered again instead.
      addLog('The new relay route is live but could not be saved in this browser. Keep this page open or copy the signer address before reloading.')
    }
    return terminalState
  } catch (error) {
    if (committed) {
      // The signer has promoted the candidate, so abort/rollback is no longer
      // valid. If the final relay subscription itself failed, disconnect cleanly
      // and leave the newly committed relay set remembered for a manual retry.
      handoff.close()
      candidateProof.close()
      originalTransport.close()
      relayTransport = null
      device.connected = false
      device.mode = 'none'
      device.relayDevicePub = ''
      device.portInfo = ''
      device.relays = []
      device.relayConfiguredRelays = null
      throw new Error(`The network change was committed, but Sapwood could not reopen its final relay connection: ${error instanceof Error ? error.message : String(error)}`)
    }
    if (stageAttempted) {
      try {
        const abort = await handoff.request('abort_network_config', {
          transaction_id: transactionId,
          revision: acceptedRevision,
        }, NETWORK_PROBE_TIMEOUT_MS)
        const abortConfirmed = abort.transaction_id === transactionId
          && abort.revision === acceptedRevision
          && abort.aborted === true
        if (journaled && abortConfirmed
          && replaceDeviceRelays(originalTransport.devicePub, originalRelays)) {
          clearPendingNetworkHandoff(originalTransport.devicePub)
        }
      } catch { /* firmware's own trial deadline remains the final rollback */ }
    }
    const unresolvedHandoff = journaled
      && pendingNetworkHandoff(originalTransport.devicePub) !== null
    if (unresolvedHandoff) {
      // Commit-vs-rollback is still unknown. Keep the durable A+B route live so
      // the poller can resolve terminal state without requiring a manual reload.
      candidateProof.close()
      originalTransport.close()
      relayTransport = handoff
      const recoveryRelays = networkRecoveryRelays(originalTransport.devicePub, originalRelays)
      device.relays = recoveryRelays
      device.relayConfiguredRelays = null
      device.portInfo = `${npubShort(originalTransport.devicePub)} · ${relaySummary(recoveryRelays)}`
    } else if (!switched) {
      handoff.close()
      candidateProof.close()
      relayTransport = originalTransport
      device.relayConfiguredRelays = before.trial ? null : [...originalRelays]
    } else {
      // Return management to the old-relays-only subscription while firmware
      // rolls back. Do not keep publishing subsequent commands to candidate B.
      handoff.close()
      candidateProof.close()
      relayTransport = originalTransport
      device.relays = [...originalRelays]
      device.relayConfiguredRelays = null
      device.portInfo = `${npubShort(originalTransport.devicePub)} · ${relaySummary(originalRelays)}`
    }
    throw error
  } finally {
    if (device.connected && device.mode === 'relay') startRelayPoll()
  }
}

/**
 * Ask a USB-connected device to generate its OWN identity: it creates the seed
 * from its hardware RNG, shows the 12-word recovery phrase on its OWN screen,
 * and stores it. No phrase or secret crosses the cable — the ACK carries only
 * the public npub (returned here) so we can address it over the relay later.
 */
export async function generateIdentity(label = 'default'): Promise<string> {
  if (device.mode !== 'serial') throw new Error('Generating an identity needs a USB connection')
  const resp = await serialTransport.sendAndReceive(
    buildGenerateIdentity(label),
    [FrameType.ACK, FrameType.NACK],
    30_000,
  )
  if (resp.type !== FrameType.ACK) {
    throw new Error('The device could not generate an identity (storage write failed). Try again.')
  }
  const npub = new TextDecoder().decode(resp.payload).trim()
  // Best-effort: the device reboots into WiFi right after a first provision, so
  // a follow-up read may fail — the npub from the ACK is what we rely on.
  try { await refreshMasters() } catch { /* USB may have dropped on the WiFi reboot */ }
  return npub
}

/**
 * Ask a USB-connected device to RESTORE an existing identity: the owner re-keys
 * their 12-word phrase on the device's own screen via the button, the device
 * validates the BIP-39 checksum and stores it. The phrase is entered on the
 * device and never travels over the cable — we only learn the resulting npub
 * (from the ACK). The timeout is deliberately long: a careful one-button entry
 * of twelve words can take several minutes, and the device never times out.
 */
export async function restoreIdentity(label = 'default'): Promise<string> {
  if (device.mode !== 'serial') throw new Error('Restoring an identity needs a USB connection')
  const resp = await serialTransport.sendAndReceive(
    buildRestoreIdentity(label),
    [FrameType.ACK, FrameType.NACK],
    900_000, // up to 15 min — the owner is hand-entering 12 words on the device
  )
  if (resp.type !== FrameType.ACK) {
    throw new Error('Restore was cancelled on the device, or the phrase did not check out. You can try again.')
  }
  const npub = new TextDecoder().decode(resp.payload).trim()
  // Best-effort: a WiFi signer reboots straight after a first provision, so a
  // follow-up read may fail — the npub from the ACK is what we rely on.
  try { await refreshMasters() } catch { /* USB may have dropped on the WiFi reboot */ }
  return npub
}

/**
 * Send a browser-derived 32-byte secret to a USB device as a PROVISION frame.
 * Unlike generateIdentity / restoreIdentity (where the secret is made or entered
 * on the device and never crosses the cable), this carries a key the owner typed
 * here — the guided restore-from-nsec / ncryptsec / pasted-phrase paths, and the
 * same thing Advanced › Provision does. The npub is already known client-side
 * from derivation, so this only confirms the write. The caller zeroizes `secret`.
 */
export async function provisionSecret(secret: Uint8Array, label: string, mode: ProvisionMode): Promise<void> {
  if (device.mode !== 'serial') throw new Error('Adding a key to the signer needs a USB connection')
  const resp = await serialTransport.sendAndReceive(
    buildProvisionFrame(secret, label, mode),
    [FrameType.ACK, FrameType.NACK],
    30_000,
  )
  if (resp.type !== FrameType.ACK) {
    throw new Error('The device rejected the key (CRC error or storage write failure). Try again.')
  }
  // Best-effort: a WiFi signer reboots straight after a first provision, so this
  // follow-up read may fail — the caller already holds the npub from derivation.
  try { await refreshMasters() } catch { /* USB may have dropped on the WiFi reboot */ }
}

export interface FirmwareInfo {
  version: string
  board: string
  /** Seconds since the signer booted (absent on older firmware). */
  uptime_s?: number
  /** Why the chip last reset (absent on older firmware). */
  last_reset?: string
  /** What the signer was doing when it last crashed, if known. */
  crashed_during?: string
}

/**
 * Ask a USB-connected device which firmware version it is running. Read-only
 * and quick. Returns null if the device doesn't answer (older firmware without
 * the query, or we're not on USB) so callers can degrade gracefully.
 */
export async function getFirmwareVersion(): Promise<FirmwareInfo | null> {
  if (device.mode !== 'serial') return null
  try {
    const resp = await serialTransport.sendAndReceive(
      buildFirmwareInfo(),
      [FrameType.FIRMWARE_INFO_RESPONSE, FrameType.NACK],
      4_000,
    )
    if (resp.type !== FrameType.FIRMWARE_INFO_RESPONSE) return null
    const info = JSON.parse(new TextDecoder().decode(resp.payload))
    if (typeof info?.version !== 'string') return null
    return {
      version: info.version,
      board: typeof info.board === 'string' ? info.board : '',
      ...(typeof info.uptime_s === 'number' ? { uptime_s: info.uptime_s } : {}),
      ...(typeof info.last_reset === 'string' ? { last_reset: info.last_reset } : {}),
      ...(typeof info.crashed_during === 'string' ? { crashed_during: info.crashed_during } : {}),
    }
  } catch {
    return null // older firmware, or no response — treat as unknown
  }
}

function containsPasswordField(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false
  if (Array.isArray(value)) return value.some(containsPasswordField)
  const record = value as Record<string, unknown>
  if (Object.prototype.hasOwnProperty.call(record, 'password')) return true
  return Object.values(record).some(containsPasswordField)
}

function firstMasterHex(): string {
  const value = device.masters[0]?.npub ?? ''
  if (/^[0-9a-f]{64}$/i.test(value)) return value.toLowerCase()
  try {
    const decoded = nip19.decode(value)
    return decoded.type === 'npub' ? String(decoded.data).toLowerCase() : ''
  } catch { return '' }
}

function parseUsbNetworkState(payload: Uint8Array): UsbNetworkState | null {
  let raw: unknown
  try { raw = JSON.parse(new TextDecoder().decode(payload)) } catch { return null }
  if (!raw || typeof raw !== 'object' || containsPasswordField(raw)) return null
  const value = raw as Record<string, unknown>
  if (value.version !== 1 || typeof value.configured !== 'boolean'
    || !Number.isInteger(value.revision) || Number(value.revision) < 0
    || Number(value.revision) > 0xffffffff || typeof value.recovery_ok !== 'boolean') return null

  let trial: UsbNetworkState['trial'] = null
  if (value.trial !== null && value.trial !== undefined) {
    const candidate = record(value.trial)
    if (!candidate
      || typeof candidate.transaction_id !== 'string'
      || !/^[0-9a-f]{32}$/i.test(candidate.transaction_id)
      || !Number.isInteger(candidate.revision)
      || Number(candidate.revision) !== Number(value.revision)
      || (candidate.phase !== 'staged' && candidate.phase !== 'trying' && candidate.phase !== 'committed')
      || (candidate.mode !== 'usb' && candidate.mode !== 'wifi')
      || typeof candidate.ssid !== 'string' || candidate.ssid.length > 32
      || !Array.isArray(candidate.relays) || candidate.relays.length > 8
      || !candidate.relays.every((relay) => typeof relay === 'string' && relay.startsWith('wss://'))
      || typeof candidate.password_set !== 'boolean'
      || (typeof candidate.attempted !== 'boolean'
        && (!Number.isInteger(candidate.attempted) || Number(candidate.attempted) < 0))) return null
    trial = {
      transaction_id: candidate.transaction_id.toLowerCase(),
      revision: Number(candidate.revision),
      phase: candidate.phase,
      mode: candidate.mode,
      ssid: candidate.ssid,
      relays: [...candidate.relays] as string[],
      password_set: candidate.password_set,
      attempted: typeof candidate.attempted === 'boolean'
        ? candidate.attempted
        : Number(candidate.attempted) > 0,
    }
  }

  const base: UsbNetworkState = {
    version: 1,
    configured: value.configured,
    revision: Number(value.revision),
    recovery_ok: value.recovery_ok,
    trial,
  }
  if (!value.configured) return trial === null ? base : null
  if (value.mode !== 'usb' && value.mode !== 'wifi') return null
  if (typeof value.ssid !== 'string' || value.ssid.length > 32) return null
  if (!Array.isArray(value.relays) || value.relays.length > 8
    || !value.relays.every((relay) => typeof relay === 'string' && relay.startsWith('wss://'))) return null
  if (typeof value.password_set !== 'boolean') return null
  if (typeof value.op_mgmt !== 'string'
    || (value.op_mgmt !== '' && !/^[0-9a-f]{64}$/.test(value.op_mgmt))) return null
  return {
    ...base,
    mode: value.mode,
    ssid: value.ssid,
    relays: [...value.relays] as string[],
    password_set: value.password_set,
    op_mgmt: value.op_mgmt,
  }
}

let usbAuthorityMutationToken: symbol | null = null

interface UsbNetworkReadOptions {
  /** The one in-flight mutation allowed to read while public refreshes are
   * suppressed, preventing an unrelated probe from resurrecting old proof. */
  mutationToken?: symbol
  /** Preflight reads obtain a revision without making phone handoff ready. */
  publishAuthority?: boolean
}

function usbNetworkReadAllowed(mutationToken?: symbol): boolean {
  return mutationToken === undefined
    ? usbAuthorityMutationToken === null
    : usbAuthorityMutationToken === mutationToken
}

/** Read this exact signer's redacted USB state. NACK proves old firmware; a
 * timeout remains unknown because the board may merely be rebooting. */
async function readUsbNetworkState(
  { mutationToken, publishAuthority = true }: UsbNetworkReadOptions = {},
): Promise<UsbNetworkState | null> {
  if (device.mode !== 'serial') return null
  if (!usbNetworkReadAllowed(mutationToken)) return null
  const generation = device.connectionGeneration
  try {
    const resp = await serialTransport.sendAndReceive(
      buildGetNetConfig(),
      [FrameType.GET_NET_CONFIG_RESPONSE, FrameType.NACK],
      20_000,
    )
    if (generation !== device.connectionGeneration || device.mode !== 'serial'
      || !usbNetworkReadAllowed(mutationToken)) return null
    if (resp.type === FrameType.NACK) {
      device.usbNetworkSupport = 'unsupported'
      device.usbNetworkState = null
      return null
    }
    const state = parseUsbNetworkState(resp.payload)
    if (!state) throw new Error('The signer returned malformed network state.')
    device.usbNetworkSupport = 'supported'
    if (publishAuthority) {
      device.usbNetworkState = state
      const masterHex = firstMasterHex()
      if (state.configured && state.mode === 'wifi' && state.trial === null
        && state.relays?.length && masterHex) {
        replaceDeviceRelays(masterHex, state.relays)
      }
    }
    return state
  } catch (error) {
    if (generation === device.connectionGeneration && device.mode === 'serial'
      && usbNetworkReadAllowed(mutationToken)
      && error instanceof Error && /malformed network state/.test(error.message)) {
      // A stale previously-terminal route must not remain usable when the
      // signer now reports an unparseable trial/state shape. Lose proof rather
      // than letting phone pairing export old A.
      device.usbNetworkState = null
      device.usbNetworkSupport = 'unknown'
      device.error = error.message
    }
    return null
  }
}

export async function refreshUsbNetworkState(): Promise<UsbNetworkState | null> {
  return readUsbNetworkState()
}

async function readUsbStateAfterReboot(
  generation: number,
  mutationToken: symbol,
): Promise<UsbNetworkState | null> {
  // Never resend an ambiguous mutation. Resolve only by read-back after the
  // board has had time to reset into its startup USB service window.
  await new Promise((resolve) => setTimeout(resolve, 750))
  if (generation !== device.connectionGeneration || device.mode !== 'serial') return null
  return readUsbNetworkState({ mutationToken })
}

export async function patchNetworkOverUsb(patch: LocalNetConfigPatch): Promise<UsbNetworkState> {
  if (device.mode !== 'serial') throw new Error('Connect the signer by USB first.')
  if (usbAuthorityMutationToken) throw new Error('Another USB authority change is already in progress.')
  const mutationToken = Symbol('patch-network-over-usb')
  usbAuthorityMutationToken = mutationToken
  const cached = device.usbNetworkState
  // Capture then invalidate synchronously. From here until a token-authorised
  // fresh readback, PhoneHandoff has no operator/relay authority to export.
  device.usbNetworkState = null
  try {
    const current = cached ?? await readUsbNetworkState({
      mutationToken,
      publishAuthority: false,
    })
    if (!current?.configured) throw new Error('This firmware cannot safely patch its network settings. Update it over USB first.')
    const frame = buildPatchNetConfig(current.revision, patch)
    const generation = device.connectionGeneration
    device.awaitingButton = 'Check the signer screen, then hold its confirmation button to change the network.'
    let acknowledged = false
    let explicitFailure: unknown
    let hasExplicitFailure = false
    try {
      const resp = await serialTransport.sendAndReceive(
        frame,
        [FrameType.ACK, FrameType.NACK],
        60_000,
      )
      if (resp.type === FrameType.NACK) {
        explicitFailure = new Error(new TextDecoder().decode(resp.payload) || 'The device rejected the network change.')
        hasExplicitFailure = true
      } else {
        acknowledged = true
      }
    } catch (error) {
      // A reset can race the ACK. Read-back below is the only ambiguity resolver.
      if (!(error instanceof Error) || !/timeout|disconnect|closed|response/i.test(error.message)) {
        explicitFailure = error
        hasExplicitFailure = true
      }
    } finally {
      device.awaitingButton = null
    }
    if (hasExplicitFailure) {
      // A rejection/cancel is safe to read immediately, but the captured object
      // is never restored. Only this fresh device response can re-enable QR.
      await readUsbNetworkState({ mutationToken })
      throw explicitFailure
    }
    const state = await readUsbStateAfterReboot(generation, mutationToken)
    if (!state?.configured || state.revision <= current.revision) {
      throw new Error(acknowledged
        ? 'The signer acknowledged the network change but did not confirm it after reboot.'
        : 'The network change outcome is unknown. Reconnect by USB and read the signer state; it was not retried.')
    }
    return state
  } finally {
    if (usbAuthorityMutationToken === mutationToken) usbAuthorityMutationToken = null
  }
}

export async function setOperatorOverUsb(operatorPubHex: string): Promise<UsbNetworkState> {
  if (device.mode !== 'serial') throw new Error('Connect the signer by USB first.')
  const operator = operatorPubHex.toLowerCase()
  if (!/^[0-9a-f]{64}$/.test(operator)) throw new Error('Operator pubkey must be 64 hexadecimal characters.')
  if (usbAuthorityMutationToken) throw new Error('Another USB authority change is already in progress.')
  const mutationToken = Symbol('set-operator-over-usb')
  usbAuthorityMutationToken = mutationToken
  const cached = device.usbNetworkState
  device.usbNetworkState = null
  try {
    const current = cached ?? await readUsbNetworkState({
      mutationToken,
      publishAuthority: false,
    })
    if (!current?.configured) throw new Error('This firmware does not support safe operator recovery. Update it over USB first.')
    const frame = buildSetOperator(current.revision, operator)
    const generation = device.connectionGeneration
    device.awaitingButton = 'Verify the new operator fingerprint on the signer, then hold its confirmation button.'
    let acknowledged = false
    let explicitFailure: unknown
    let hasExplicitFailure = false
    try {
      const resp = await serialTransport.sendAndReceive(
        frame,
        [FrameType.ACK, FrameType.NACK],
        60_000,
      )
      if (resp.type === FrameType.NACK) {
        explicitFailure = new Error(new TextDecoder().decode(resp.payload) || 'The device rejected the operator change.')
        hasExplicitFailure = true
      } else {
        acknowledged = true
      }
    } catch (error) {
      if (!(error instanceof Error) || !/timeout|disconnect|closed|response/i.test(error.message)) {
        explicitFailure = error
        hasExplicitFailure = true
      }
    } finally {
      device.awaitingButton = null
    }
    if (hasExplicitFailure) {
      await readUsbNetworkState({ mutationToken })
      throw explicitFailure
    }
    const state = await readUsbStateAfterReboot(generation, mutationToken)
    if (!state?.configured || state.op_mgmt !== operator || state.revision <= current.revision) {
      throw new Error(acknowledged
        ? 'The signer acknowledged the operator change but did not confirm it after reboot.'
        : 'The operator-change outcome is unknown. Reconnect by USB and read the signer state; it was not retried.')
    }
    return state
  } finally {
    if (usbAuthorityMutationToken === mutationToken) usbAuthorityMutationToken = null
  }
}

/** One access point the signer's own radio can see. */
export interface WifiNetwork {
  ssid: string
  /** Signal strength in dBm (closer to 0 is stronger; roughly -50 great, -80 weak). */
  rssi: number
  channel: number
  /** Short auth label: open | wep | wpa | wpa2 | wpa3 | wpa2/wpa3 | … | unknown. */
  auth: string
  /** True when the AP is on the 2.4 GHz band the ESP32 can join (always true today). */
  band24: boolean
}

/**
 * Ask a USB-connected signer to scan for nearby WiFi networks. This proves what
 * the signer's own radio can actually see — the surest way to pick a 2.4 GHz
 * SSID it can reach (5 GHz-only, out-of-range or WPA3-only networks simply do
 * not appear, or appear flagged). Returns:
 *   - an array (possibly empty) on a successful scan,
 *   - `null` when the signer can't scan: not on USB, older firmware (NACK), or
 *     it's busy serving a live relay connection (also NACK) — callers keep the
 *     manual SSID field in that case.
 * The device brings its radio up only for the scan and powers it down again; it
 * never connects. Allow generous time: bringing the radio up plus a full-band
 * scan is a few seconds, more on a slow laptop.
 */
export async function scanWifi(): Promise<WifiNetwork[] | null> {
  if (device.mode !== 'serial') return null
  try {
    const resp = await serialTransport.sendAndReceive(
      buildWifiScan(),
      [FrameType.WIFI_SCAN_RESPONSE, FrameType.NACK],
      20_000,
    )
    if (resp.type !== FrameType.WIFI_SCAN_RESPONSE) return null // NACK: can't scan now
    const raw = JSON.parse(new TextDecoder().decode(resp.payload))
    if (!Array.isArray(raw)) return null
    const nets: WifiNetwork[] = raw
      .filter((n): n is Record<string, unknown> => !!n && typeof n === 'object' && typeof n.ssid === 'string' && !!n.ssid)
      .map((n) => ({
        ssid: n.ssid as string,
        rssi: typeof n.rssi === 'number' ? n.rssi : -100,
        channel: typeof n.channel === 'number' ? n.channel : 0,
        auth: typeof n.auth === 'string' ? n.auth : 'unknown',
        band24: n.band24 !== false,
      }))
    // Strongest first (the device already sorts, but don't rely on it).
    nets.sort((a, b) => b.rssi - a.rssi)
    return nets
  } catch {
    return null // no response — treat as "scan unavailable", keep manual entry
  }
}

/**
 * On a fresh USB connection, work out whether the device actually answers
 * frames. A USB-reachable signer replies to PROVISION_LIST with either the
 * master list (provisioned) or a NACK (brand-new, still in the first-provision
 * loop). Firmware v0.9.10+ answers the cable in every mode (including WiFi);
 * older WiFi firmware booted straight into its relay loop and stayed silent.
 * Detecting silence lets Home offer retry / WiFi management / the old-firmware
 * PRG hatch instead of a "create an identity" flow that can only time out.
 *
 * Patience matters here: a WiFi signer on current firmware only starts polling
 * the cable once its relay session is up — measured at ~20-35s after reset on a
 * T-Display (v0.9.10), on top of the ~6s boot animation. The old 3x5s probe
 * gave up inside that window and wrongly declared provisioned WiFi signers
 * silent, which is why we now keep trying for a full minute. Queued probes are
 * all answered in a burst the moment the device starts draining USB; if a
 * PROVISION_LIST_RESPONSE lands, handleFrame populates device.masters as a
 * side effect.
 */
async function probeSerial() {
  device.usbProbing = true
  device.usbSilent = false
  try {
    for (let attempt = 0; attempt < 12; attempt++) {
      try {
        await serialTransport.sendAndReceive(
          buildProvisionList(),
          [FrameType.PROVISION_LIST_RESPONSE, FrameType.NACK],
          5_000,
        )
        void refreshUsbNetworkState()
        return // answered → reachable
      } catch { /* timed out this round — the board may still be booting or joining WiFi */ }
      if (device.masters.length > 0) return // a late list reply arrived via handleFrame
    }
    device.usbSilent = true
  } finally {
    device.usbProbing = false
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
  } else if (device.mode === 'relay') {
    await relayRefresh()
  }
}

export async function refreshSlots(slot?: number) {
  if (!device.connected) return
  if (device.mode === 'relay') {
    await relayRefresh()
    return
  }
  const s = slot ?? device.selectedSlot
  if (device.mode === 'serial') {
    // CONNSLOT_LIST needs no bridge auth (secrets redacted). The 0x43 response
    // is parsed into device.slots by handleFrame.
    try { await serialTransport.write(buildConnSlotList(s)) } catch (e) {
      device.error = e instanceof Error ? e.message : 'Failed to fetch slots'
    }
  } else if (device.mode === 'http') {
    await httpTransport.fetchSlots(s)
  }
}

// --- USB-direct client management (CONNSLOT_* frames, behind bridge auth) ---

const BRIDGE_SECRET_KEY = 'heartwood.bridgeSecret'

function bridgeSecret(): string {
  let s = localStorage.getItem(BRIDGE_SECRET_KEY) ?? ''
  if (!/^[0-9a-f]{64}$/.test(s)) {
    const bytes = crypto.getRandomValues(new Uint8Array(32))
    s = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
    localStorage.setItem(BRIDGE_SECRET_KEY, s)
  }
  return s
}

/**
 * Authenticate the bridge session so CONNSLOT create/update/revoke/uri are
 * accepted. SESSION_ACK payload: 0x00 ok, 0x01 wrong secret, 0x02 no secret set.
 * On 0x02 we set our secret (button-confirmed) then re-auth — so a fresh device
 * pairs to this browser on first management action.
 */
export async function ensureBridgeAuth(): Promise<void> {
  if (device.mode !== 'serial') return
  if (device.bridgeAuthed) return
  const secret = bridgeSecret()
  const ack = await serialTransport.sendAndReceive(buildSessionAuth(secret), [FrameType.SESSION_ACK], SERIAL_RTT_MS)
  const code = ack.payload[0]
  if (code === 0x00) { device.bridgeAuthed = true; return }
  if (code === 0x02) {
    // No secret on the device yet: this browser pairs itself so only it can
    // manage the signer over USB. Gated by a physical button hold (Web Serial
    // access alone must not be enough), so tell the operator to hold it — this
    // is the one-time pairing they otherwise meet as a silent, mystifying wait.
    device.awaitingButton = 'First time on this browser: hold the button on your signer for 2 seconds to pair it. The signer shows “Set bridge secret?” with a countdown.'
    try {
      const resp = await serialTransport.sendAndReceive(buildSetBridgeSecret(secret), [FrameType.ACK, FrameType.NACK], 35_000)
      if (resp.type !== FrameType.ACK) {
        throw new Error('Pairing was not approved on the signer. Hold its button for a full 2 seconds when it shows “Set bridge secret?”, then try again.')
      }
      const ack2 = await serialTransport.sendAndReceive(buildSessionAuth(secret), [FrameType.SESSION_ACK], SERIAL_RTT_MS)
      if (ack2.payload[0] !== 0x00) throw new Error('Pairing did not complete. Try the action again.')
      device.bridgeAuthed = true
    } catch (e) {
      // The generic serial timeout tells people to press RESET — wrong here: the
      // signer is waiting for the pairing hold, not a reboot. Rewrite it.
      if (e instanceof Error && /No response from the device/i.test(e.message)) {
        throw new Error('The signer is waiting for you to pair. Hold its button for 2 seconds when it shows “Set bridge secret?”, then try again.')
      }
      throw e
    } finally {
      device.awaitingButton = null
    }
    return
  }
  throw new Error('This signer is paired to a different USB browser or bridge. Do not factory-reset it: reconnect with that pairing, or deliberately replace the USB pairing with physical confirmation.')
}

// Which relays to embed in a bunker link built over USB. The firmware puts in
// exactly what the host hands it (there is no read-back of the signer's own
// config), so an empty list yields a relayless link a remote app can't use.
// Current firmware proves its own exact relays over USB. Browser-global
// fallbacks exist only for old firmware that cannot answer GET_NET_CONFIG.
// USB round-trip budget for a management request that expects a reply. Set
// generously: on a slow or busy laptop the signer answers promptly but the
// browser is late to read the serial reply and run reactivity, so a tight
// timeout fires on a device that in fact replied. Physical-button operations
// (provisioning, net config, PIN, bridge secret) keep their own longer,
// human-paced timeouts — those wait on a person, not the cable.
const SERIAL_RTT_MS = 30_000

function lastRelays(): string[] {
  // During a staged/trying boot the redacted `relays` field is committed A,
  // not proof of the route currently serving candidate B. Never fall through
  // to browser-global guesses and embed either stale route in a client URI.
  if (device.mode === 'serial' && device.usbNetworkState?.trial) return []
  const exact = device.mode === 'serial' && device.usbNetworkState?.configured
    && device.usbNetworkState.mode === 'wifi' && device.usbNetworkState.trial === null
    ? device.usbNetworkState.relays
    : null
  if (exact?.length) return [...exact]
  try {
    const saved = JSON.parse(localStorage.getItem('heartwood.lastRelays') ?? '[]')
    const list = Array.isArray(saved) ? saved.filter((r): r is string => typeof r === 'string' && !!r) : []
    if (list.length) return list
  } catch { /* fall through to defaults */ }
  return [...DEFAULT_SIGNER_RELAYS]
}

/**
 * Derive a named child identity on the signer itself (USB, frame 0x60). The
 * device already holds the tree root, so no secret enters or leaves the
 * browser. Returns the new (or pre-existing, when re-derived) identity.
 */
export async function serialDeriveIdentity(
  parentSlot: number,
  name: string,
): Promise<{ slot: number; label: string; npub: string; existing: boolean }> {
  const resp = await serialTransport.sendAndReceive(
    buildDeriveIdentity(parentSlot, name),
    [FrameType.DERIVE_IDENTITY_RESPONSE, FrameType.NACK],
    SERIAL_RTT_MS,
  )
  if (resp.type !== FrameType.DERIVE_IDENTITY_RESPONSE) {
    const reason = new TextDecoder().decode(resp.payload)
    // An older firmware replies NACK to any unknown frame type with no reason.
    throw new Error(reason || 'This firmware cannot derive identities on-device. Update the signer, or enter the phrase or nsec instead.')
  }
  const info = JSON.parse(new TextDecoder().decode(resp.payload)) as {
    slot: number; label: string; npub: string; existing: boolean
  }
  // Best-effort: a wifi-standalone signer reboots shortly after replying (to
  // re-subscribe with the new master set), so the list refresh may not land.
  try { await refreshMasters() } catch { /* device rebooting */ }
  return info
}

/**
 * Provision a new identity over the relay (mgmt `provision_identity`). The
 * secret travels NIP-44 encrypted end-to-end under the operator⇄signer
 * conversation key — relays and every network hop carry only ciphertext. The
 * signer restarts about two seconds after replying to serve the new identity.
 */
export async function relayProvisionIdentity(
  secret: Uint8Array,
  label: string,
  mode: 'tree-mnemonic' | 'tree-nsec' | 'bunker' | 'named-child',
): Promise<{ slot: number; label: string; npub: string; existing: boolean }> {
  if (!relayTransport) throw new Error('Not connected over the relay')
  const modeByte = mode === 'bunker' || mode === 'named-child' ? 0 : mode === 'tree-mnemonic' ? 1 : 2
  const secretHex = Array.from(secret, (b) => b.toString(16).padStart(2, '0')).join('')
  const res = await relayTransport.request(
    'provision_identity',
    { mode: modeByte, label, secret_hex: secretHex },
    MGMT_WRITE_TIMEOUT_MS,
  )
  const hex = String(res.npub_hex ?? '')
  let npub = hex
  try { npub = nip19.npubEncode(hex) } catch { /* keep hex */ }
  const info = {
    slot: Number(res.slot ?? -1),
    label: String(res.label ?? label),
    npub,
    existing: res.existing === true,
  }
  if (!info.existing) {
    rememberDevice(hex, device.relays.length ? device.relays : [...DEFAULT_SIGNER_RELAYS], info.label)
  }
  return info
}

/**
 * Derive a named child identity over the relay (mgmt `derive_identity`). Safe
 * over WiFi: no key material crosses the wire, only the name — the signer
 * already holds the tree root. The parent is the ADDRESSED identity, so
 * `parentHex` selects which master derives; omitted, the session's primary.
 * The signer restarts about two seconds after replying to serve the new one.
 */
export async function relayDeriveIdentity(
  name: string,
  parentHex?: string,
): Promise<{ slot: number; label: string; npub: string; existing: boolean }> {
  if (!relayTransport) throw new Error('Not connected over the relay')
  const res = await relayTransport.request('derive_identity', { name }, MGMT_WRITE_TIMEOUT_MS, parentHex)
  const hex = String(res.npub_hex ?? '')
  let npub = hex
  try { npub = nip19.npubEncode(hex) } catch { /* keep hex */ }
  const info = {
    slot: Number(res.slot ?? -1),
    label: String(res.label ?? name),
    npub,
    existing: res.existing === true,
  }
  if (!info.existing) {
    // Make the new identity one-tap connectable once the signer is back.
    rememberDevice(hex, device.relays.length ? device.relays : [...DEFAULT_SIGNER_RELAYS], info.label)
  }
  return info
}

/** Create a client slot over USB. Returns the bunker URI + secret (shown once). */
export async function serialCreateClient(
  label: string,
): Promise<{ bunker_uri: string; secret: string; signing_approved: boolean; slot_index: number }> {
  await ensureBridgeAuth()
  const ms = device.selectedSlot
  const resp = await serialTransport.sendAndReceive(buildConnSlotCreate(ms, label), [FrameType.CONNSLOT_CREATE_RESP, FrameType.NACK], SERIAL_RTT_MS)
  if (resp.type !== FrameType.CONNSLOT_CREATE_RESP) throw new Error('Create rejected (slots full?)')
  const info = JSON.parse(new TextDecoder().decode(resp.payload)) as { slot_index: number; secret: string }
  const bunker_uri = await serialGetUri(info.slot_index).catch(() => '')
  await refreshSlots()
  return { bunker_uri, secret: info.secret, signing_approved: false, slot_index: info.slot_index }
}

/** Revoke a client slot over USB. */
export async function serialRevokeClient(slotIndex: number): Promise<void> {
  await ensureBridgeAuth()
  const resp = await serialTransport.sendAndReceive(buildConnSlotRevoke(device.selectedSlot, slotIndex), [FrameType.CONNSLOT_REVOKE_RESP, FrameType.NACK], SERIAL_RTT_MS)
  if (resp.type !== FrameType.CONNSLOT_REVOKE_RESP) throw new Error('Revoke rejected')
  await refreshSlots()
}

/** Update a client slot (label / kinds / auto-approve) over USB. Button-confirmed on device. */
export async function serialUpdateClient(slotIndex: number, changes: { label?: string; allowed_methods?: string[]; allowed_kinds?: number[]; auto_approve?: boolean }): Promise<void> {
  await ensureBridgeAuth()
  const resp = await serialTransport.sendAndReceive(buildConnSlotUpdate(device.selectedSlot, { slot_index: slotIndex, ...changes }), [FrameType.CONNSLOT_UPDATE_RESP, FrameType.NACK], 35_000)
  if (resp.type !== FrameType.CONNSLOT_UPDATE_RESP) throw new Error('Update denied on the device')
  await refreshSlots()
}

/** Fetch the bunker URI for a slot over USB (relays from the last wifi flash). */
export async function serialGetUri(slotIndex: number): Promise<string> {
  await ensureBridgeAuth()
  const resp = await serialTransport.sendAndReceive(buildConnSlotUri(device.selectedSlot, slotIndex, lastRelays()), [FrameType.CONNSLOT_URI_RESP, FrameType.NACK], SERIAL_RTT_MS)
  if (resp.type !== FrameType.CONNSLOT_URI_RESP) throw new Error('URI fetch failed')
  return new TextDecoder().decode(resp.payload)
}

// --- Mode-dispatching client management (serial OR relay) ---
// One Clients view drives both transports; the ESP32 supports the same set over
// USB (CONNSLOT_*) and over relays (kind 24134). The one asymmetry: signing
// approval is a software op over relays (operator authority) but a physical
// button press over USB — so `mgmtCanApproveSigning` is relay-only.

export function mgmtCanApproveSigning(): boolean {
  return device.mode === 'relay'
}

export async function mgmtCreateClient(
  label: string,
  policy: ExactClientPolicy,
): Promise<{ bunker_uri: string; secret: string; signing_approved: boolean; slot_index: number; secret_fingerprint?: string }> {
  let res: { bunker_uri: string; secret: string; signing_approved: boolean; slot_index: number; secret_fingerprint?: string }
  if (device.mode === 'relay') {
    res = await relayCreateClient(label, policy)
  } else if (device.mode === 'serial') {
    res = await serialCreateClient(label)
    try {
      // USB remains legacy TOFU: install the non-signing ceiling and kinds now;
      // the first sign_event still needs the device button.
      await serialUpdateClient(res.slot_index, policy)
    } catch (error) {
      try { await serialRevokeClient(res.slot_index) } catch { /* leave no visible credential */ }
      throw error
    }
  }
  else throw new Error('not connected')
  // USB can use its same-session cache as a compatibility fallback. Relay URI
  // reissue must always round-trip with a current credential fingerprint; never
  // cache a bearer URI under a compactable numeric slot index.
  if (device.mode !== 'relay' && res.bunker_uri && res.slot_index >= 0) {
    device.slotUris[res.slot_index] = res.bunker_uri
  }
  return res
}

/**
 * Pair a nostrconnect app: bind a slot to the app's pubkey and have the signer
 * publish the connect ACK on the relay the app listens on. Relay-only — the
 * signer must be online to publish. When the app's relay is not one the signer
 * already serves, pass it as `relay` and the signer dials and keeps it as a
 * pinned session (capacity permitting; it answers `relay_capacity` when full).
 * The device has no clock, so we hand it our current time for the ACK's created_at.
 */
export async function mgmtNostrconnect(params: {
  clientPubkey: string
  secret: string
  label: string
  policy: ExactClientPolicy
  /** The app's relay, when it is not already in the signer's relay set. */
  relay?: string
}): Promise<{ slot_index: number; joined_relay: boolean }> {
  if (device.mode !== 'relay' || !relayTransport) {
    throw new Error('Pairing a nostrconnect app needs the signer connected over WiFi, so it can publish the connect reply. Connect over WiFi and try again.')
  }
  let res: Record<string, unknown>
  try {
    res = await relayTransport.request('nostrconnect_v2', {
      client_pubkey: params.clientPubkey,
      secret: params.secret,
      created_at: Math.floor(Date.now() / 1000),
      label: params.label,
      policy: params.policy,
      ...(params.relay ? { relay: params.relay } : {}),
    }, MGMT_DIAL_TIMEOUT_MS, relayMgmtTarget())
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (/unknown method.*nostrconnect_v2/i.test(message)) {
      throw new Error('This signer firmware is too old to pair this app with exact permissions. Update the signer over USB, then try again.')
    }
    return rethrowAfterManagementConflict(error)
  }
  const slotIndex = Number(res.slot_index ?? -1)
  const fingerprint = typeof res.secret_fingerprint === 'string'
    ? res.secret_fingerprint.toLowerCase()
    : ''
  const validSlot = Number.isSafeInteger(slotIndex) && slotIndex >= 0 && slotIndex <= 255
  const validFingerprint = SLOT_FINGERPRINT_RE.test(fingerprint)
  if (Number(res.policy_version) !== 2 || !policiesEqual(params.policy, res) || !validSlot || !validFingerprint) {
    if (validSlot && validFingerprint) {
      try {
        await relayTransport.request('revoke_client', {
          slot_index: slotIndex,
          expected_secret_fingerprint: fingerprint,
        }, MGMT_WRITE_TIMEOUT_MS)
      }
      catch { /* fail closed in the UI even if cleanup cannot be confirmed */ }
    }
    await relayRefresh()
    throw new Error('The signer did not confirm the app’s exact requested permissions and slot credential, so pairing was revoked.')
  }
  await relayRefresh()
  return {
    slot_index: slotIndex,
    joined_relay: Boolean(res.joined_relay ?? false),
  }
}

/**
 * Re-fetch a slot's bunker link. Over USB/HTTP the signer or bridge re-issues it
 * directly. Over WiFi, always ask firmware with a current credential
 * fingerprint; a numeric slot index can be compacted/reused by another phone.
 * A slot URI is reusable and the signer remembers multiple client keys for it.
 */
export async function mgmtClientUri(slotIndex: number, expectedFingerprint?: string): Promise<string> {
  try {
    if (device.mode === 'serial') return await serialGetUri(slotIndex)
    if (device.mode === 'http') return await httpTransport.getSlotUri(device.selectedSlot, slotIndex)
  } catch { /* fall through to the cached copy */ }
  if (device.mode === 'relay' && relayTransport) {
    const fingerprint = requireExpectedSlotFingerprint(slotIndex, expectedFingerprint)
    let res: Record<string, unknown>
    try {
      res = await relayTransport.request('client_uri', {
        slot_index: slotIndex,
        expected_secret_fingerprint: fingerprint,
      }, MGMT_WRITE_TIMEOUT_MS, relayMgmtTarget())
    } catch (error) {
      return rethrowAfterManagementConflict(error)
    }
    if (Number(res.slot_index) !== slotIndex
      || typeof res.secret_fingerprint !== 'string'
      || res.secret_fingerprint.toLowerCase() !== fingerprint) {
      await relayRefresh()
      throw new Error('The signer did not reissue the expected app credential; the link was not shown.')
    }
    const uri = String(res.bunker_uri ?? '')
    if (uri) {
      return uri
    }
  }
  const cached = device.slotUris[slotIndex]
  if (cached) return cached
  throw new Error('Could not fetch this connection link from the signer. Refresh the signer or create a fresh connection.')
}

export async function mgmtRevokeClient(slotIndex: number, expectedFingerprint?: string): Promise<void> {
  if (device.mode === 'relay') return relayRevokeClient(slotIndex, expectedFingerprint)
  if (device.mode === 'serial') return serialRevokeClient(slotIndex)
  throw new Error('not connected')
}

export async function mgmtUpdateClient(slotIndex: number, changes: { label?: string; allowed_methods?: string[]; allowed_kinds?: number[]; auto_approve?: boolean }, expectedFingerprint?: string): Promise<void> {
  if (device.mode === 'relay') return relayUpdateClient(slotIndex, changes, expectedFingerprint)
  if (device.mode === 'serial') return serialUpdateClient(slotIndex, changes)
  throw new Error('not connected')
}

export async function mgmtApproveSigning(slotIndex: number, expectedFingerprint?: string): Promise<void> {
  if (device.mode === 'relay') return relayApproveSigning(slotIndex, expectedFingerprint)
  throw new Error('Over USB, approve signing with a physical PRG press on the next sign.')
}

export async function bridgeRestart() {
  if (device.mode !== 'http') return
  await httpTransport.bridgeRestart()
}

export async function configureNetwork(cfg: NetConfig): Promise<boolean> {
  // SET_NET_CONFIG is a USB-only frame (button-confirmed on the device) — over
  // http/relay there is no serial port open, so fail with guidance, not a hang.
  if (device.mode !== 'serial') {
    throw new Error('Network settings are changed over USB. Connect the signer by cable first.')
  }
  const frame = buildSetNetConfig(cfg)
  // 60s: must exceed the device's 30s button-approval window so a late confirm isn't lost.
  const resp = await serialTransport.sendAndReceive(frame, [FrameType.ACK, FrameType.NACK], 60_000)
  return resp.type === FrameType.ACK
}

export { serialTransport, httpTransport, HttpTransport }

// --- E2E test seam -------------------------------------------------------
// Lets Playwright put the UI in a "connected" state without a real device or
// relay, so the connected admin surfaces (Home, Advanced) can be regression
// tested. Inert in normal use: the hook is only installed when the harness sets
// `window.__sapwoodE2E` before load — it is never set in production, makes no
// network calls, and touches no secrets. Mirrors `__sapwoodFlashBackend`.
if (typeof window !== 'undefined' && (window as unknown as { __sapwoodE2E?: boolean }).__sapwoodE2E) {
  ;(window as unknown as { __sapwoodConnect?: unknown }).__sapwoodConnect = (
    opts: {
      masters?: MasterInfo[]
      slots?: ConnectSlot[]
      mode?: TransportMode
      portInfo?: string
      operatorPub?: string
      relayDevicePub?: string
      relays?: string[]
      relayConfiguredRelays?: string[] | null
      relayStatus?: RelayStatus | null
      error?: string | null
    } = {},
  ) => {
    device.connected = true
    device.connectionGeneration += 1
    device.mode = opts.mode ?? 'relay'
    device.portInfo = opts.portInfo ?? 'test-device'
    device.masters = opts.masters ?? []
    device.slots = opts.slots ?? []
    device.operatorPub = opts.operatorPub ?? device.operatorPub
    device.relays = opts.relays ?? (device.mode === 'relay' ? device.relays : [])
    device.relayConfiguredRelays = device.mode === 'relay'
      ? (opts.relayConfiguredRelays !== undefined
        ? opts.relayConfiguredRelays
        : (opts.relayStatus && opts.relays ? [...opts.relays] : null))
      : null
    device.relayDevicePub = device.mode === 'relay'
      ? (opts.relayDevicePub
        ?? opts.masters?.map((master) => master.npub).find((npub) => /^[0-9a-f]{64}$/i.test(npub))?.toLowerCase()
        ?? '')
      : ''
    device.relayStatus = opts.relayStatus ?? null
    device.error = opts.error ?? null
  }
}
