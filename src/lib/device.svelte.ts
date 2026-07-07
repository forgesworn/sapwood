// Reactive device state shared across all components.
// Supports two transport modes: Web Serial (direct USB) and HTTP (bridge API).

import { transport as serialTransport, type SerialEvent } from './serial.js'
import { httpTransport, HttpTransport, type HttpEvent } from './http.js'
import {
  buildSetNetConfig, FrameType, buildProvisionList, type NetConfig,
  buildSessionAuth, buildSetBridgeSecret, buildGenerateIdentity, buildRestoreIdentity,
  buildFirmwareInfo, buildWifiScan,
  buildConnSlotCreate, buildConnSlotList, buildConnSlotRevoke, buildConnSlotUpdate, buildConnSlotUri,
} from './frame.js'
import type { ConnectSlot, MasterInfo } from './types.js'
import { loadAvatar, placeholderAvatar, buildSetIdentityMeta, type Avatar } from './avatar.js'
import { buildProvisionFrame, type ProvisionMode } from './provision.js'
import { resolveProfiles, profileDisplayName } from './profiles.js'
import { RelayTransport } from './relay-transport.js'
import { getOperatorCandidates } from './op-mgmt.js'
import { rememberDevice, npubShort } from './known-devices.js'
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
  /** Relay: the operator pubkey Sapwood signs management with (must match the device's baked op_mgmt). */
  operatorPub: '',
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
})

const MAX_LOG_LINES = 500
const MAX_ACTIVITY_LINES = 100
let signerActivitySeq = 0

// --- Serial transport listener ---

serialTransport.on((event: SerialEvent) => {
  switch (event.kind) {
    case 'connected':
      device.connected = true
      device.mode = 'serial'
      device.portInfo = event.port
      device.error = null
      device.signerActivity = []
      device.usbSilent = false
      void probeSerial()
      break
    case 'disconnected':
      if (device.mode === 'serial') {
        device.connected = false
        device.mode = 'none'
        device.portInfo = ''
        device.masters = []
        device.slots = []
        device.signerActivity = []
        device.bridgeAuthed = false
        device.usbProbing = false
        device.usbSilent = false
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
      device.signerActivity = []
      refreshMasters()
      break
    case 'disconnected':
      if (device.mode === 'http') {
        device.connected = false
        device.mode = 'none'
        device.portInfo = ''
        device.masters = []
        device.slots = []
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
const RELAY_STATUS_TIMEOUT_MS = 75_000
const RELAY_POLL_MS = 4_000
let lastRelayRefreshLog = ''

function relaySummary(relays: string[]): string {
  if (relays.length === 0) return ''
  if (relays.length === 1) return relays[0]
  return `${relays.length} relays`
}

interface RelaySelection {
  transport: RelayTransport
  status?: Record<string, unknown>
}

function closeRelayTransports(transports: RelayTransport[], keep: RelayTransport): void {
  for (const t of transports) {
    if (t !== keep) t.close()
  }
}

async function selectRelayTransport(devicePubHex: string, relays: string[]): Promise<RelaySelection> {
  const operators = getOperatorCandidates()
  if (operators.length === 1) {
    const transport = new RelayTransport(devicePubHex, relays, operators[0]!.skHex)
    console.log(`[hw] relay connect → signer ${devicePubHex.slice(0, 8)}… on [${relays.join(', ')}] as operator ${transport.operatorPub.slice(0, 8)}…`)
    await transport.connect()
    return { transport }
  }

  console.log(`[hw] relay connect → signer ${devicePubHex.slice(0, 8)}… on [${relays.join(', ')}] trying ${operators.length} saved operator keys`)
  const transports = operators.map((op) => new RelayTransport(devicePubHex, relays, op.skHex))
  try {
    const selection = await Promise.any(transports.map(async (transport): Promise<RelaySelection> => {
      await transport.connect()
      const status = await transport.request('get_status', {}, RELAY_STATUS_TIMEOUT_MS)
      return { transport, status }
    }))
    closeRelayTransports(transports, selection.transport)
    console.log(`[hw] relay: signer answered operator ${selection.transport.operatorPub.slice(0, 8)}…`)
    return selection
  } catch (e) {
    transports.forEach((t) => t.close())
    if (e instanceof AggregateError) {
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
  }
  device.relayStatus = status
  const masterHex = String(raw.master_npub_hex ?? '')
  if (masterHex) {
    let npub = masterHex
    try { npub = nip19.npubEncode(masterHex) } catch { /* keep hex */ }
    const known = device.masters[0]
    device.masters = [{
      slot: 0,
      label: known?.label ?? 'master',
      mode: -1,
      modeLabel: status.mode.toUpperCase(),
      npub,
    }]
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
export async function connectRelay(devicePubHex: string, relays: string[], label?: string) {
  resetIdMetaSync() // a reconnect should retry the identity-card push, not stay given-up
  const { transport: t, status } = await selectRelayTransport(devicePubHex, relays)
  relayTransport = t
  device.connected = true
  device.mode = 'relay'
  device.operatorPub = t.operatorPub
  device.portInfo = `${npubShort(devicePubHex)} · ${relaySummary(relays)}`
  device.error = null
  device.masters = []
  device.slots = []
  device.signerActivity = []
  device.relays = relays
  device.relayStatus = null
  lastRelayAuditSeq = 0
  rememberDevice(devicePubHex, relays, label)

  // First load, then poll for live status/clients every 4s while connected.
  await relayRefresh(status)
  if (pollTimer) clearInterval(pollTimer)
  pollTimer = setInterval(() => {
    if (!device.connected || device.mode !== 'relay') {
      if (pollTimer) { clearInterval(pollTimer); pollTimer = null }
      return
    }
    void relayRefresh()
  }, RELAY_POLL_MS)
}

/** Refresh masters (get_status) and clients (list_clients) over the relay.
 *  Guarded against overlap: on a slow link a refresh can outlast the 4s poll,
 *  and piling more requests onto a struggling connection only makes it worse, so
 *  a tick that finds one already in flight simply skips. */
let relayRefreshing = false
async function relayRefresh(prefetchedStatus?: Record<string, unknown>) {
  if (!relayTransport || relayRefreshing) return
  relayRefreshing = true
  try {
    const raw = prefetchedStatus ?? await relayTransport.request('get_status', {}, RELAY_STATUS_TIMEOUT_MS)
    applyRelayStatus(raw)
    const res = await relayTransport.request('list_clients', {}, RELAY_STATUS_TIMEOUT_MS)
    const clients = (res.clients as Array<Record<string, unknown>>) ?? []
    device.slots = clients.map((c) => ({
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
    }))
    device.error = null
    lastRelayRefreshLog = ''
  } catch (e) {
    const message = e instanceof Error ? e.message : 'Relay request failed'
    device.error = message
    logRelayRefreshIssue(message)
  } finally {
    relayRefreshing = false
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
 * Create a client over the relay. Returns the device's bunker URI + secret
 * (the only time the secret is exposed). `approveSigning` pre-authorises
 * sign_event so the client can auto-sign once it connects (operator authority
 * substitutes for the physical button — see relay-mediated-management design).
 */
export async function relayCreateClient(
  label: string,
  approveSigning = false,
): Promise<{ bunker_uri: string; secret: string; signing_approved: boolean; slot_index: number }> {
  if (!relayTransport) throw new Error('not connected over relay')
  const res = await relayTransport.request('create_client', { label, approve_signing: approveSigning }, MGMT_WRITE_TIMEOUT_MS)
  await relayRefresh()
  return {
    bunker_uri: String(res.bunker_uri ?? ''),
    secret: String(res.secret ?? ''),
    signing_approved: Boolean(res.signing_approved),
    slot_index: Number(res.slot_index ?? -1),
  }
}

/** Grant a slot signing authority over the relay (operator-authorised). */
export async function relayApproveSigning(slotIndex: number): Promise<void> {
  if (!relayTransport) throw new Error('not connected over relay')
  await relayTransport.request('approve_signing', { slot_index: slotIndex }, MGMT_WRITE_TIMEOUT_MS)
  await relayRefresh()
}

/** Revoke a client slot over the relay (operator-authorised). */
export async function relayRevokeClient(slotIndex: number): Promise<void> {
  if (!relayTransport) throw new Error('not connected over relay')
  await relayTransport.request('revoke_client', { slot_index: slotIndex }, MGMT_WRITE_TIMEOUT_MS)
  await relayRefresh()
}

/** Update a client slot (label / kind perms / auto-approve) over the relay. */
export async function relayUpdateClient(
  slotIndex: number,
  changes: { label?: string; allowed_kinds?: number[]; auto_approve?: boolean },
): Promise<void> {
  if (!relayTransport) throw new Error('not connected over relay')
  await relayTransport.request('update_client', { slot_index: slotIndex, ...changes }, MGMT_WRITE_TIMEOUT_MS)
  await relayRefresh()
}

export async function refreshRelayAudit(): Promise<void> {
  if (device.mode !== 'relay') throw new Error('Connect over WiFi to refresh signer audit.')
  await relayRefresh()
}

export async function disconnect() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null }
  device.slotUris = {} // session-only links; don't carry them to the next signer
  device.wifiJoinError = null
  if (device.mode === 'serial') {
    await serialTransport.disconnect()
  } else if (device.mode === 'http') {
    await httpTransport.disconnect()
  } else if (device.mode === 'relay') {
    relayTransport?.close()
    relayTransport = null
    relayRefreshing = false // let the next connection's first refresh run
    lastRelayAuditSeq = 0
    lastRelayRefreshLog = ''
    device.connected = false
    device.mode = 'none'
    device.portInfo = ''
    device.masters = []
    device.slots = []
    device.relays = []
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
    return { version: info.version, board: typeof info.board === 'string' ? info.board : '' }
  } catch {
    return null // older firmware, or no response — treat as unknown
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
  throw new Error('This signer is paired to a different browser. To manage it here, factory-reset the signer under Advanced › Device, then pair again.')
}

// Which relays to embed in a bunker link built over USB. The firmware puts in
// exactly what the host hands it (there is no read-back of the signer's own
// config), so an empty list yields a relayless link a remote app can't use.
// Prefer the relays this browser flashed; fall back to the standard defaults so
// the link is never relayless. A WiFi signer flashed with defaults is on these;
// if it was flashed with custom relays, set them under Device > Network (which
// persists here) so the link names the relays it actually serves on.
// USB round-trip budget for a management request that expects a reply. Set
// generously: on a slow or busy laptop the signer answers promptly but the
// browser is late to read the serial reply and run reactivity, so a tight
// timeout fires on a device that in fact replied. Physical-button operations
// (provisioning, net config, PIN, bridge secret) keep their own longer,
// human-paced timeouts — those wait on a person, not the cable.
const SERIAL_RTT_MS = 30_000

function lastRelays(): string[] {
  try {
    const saved = JSON.parse(localStorage.getItem('heartwood.lastRelays') ?? '[]')
    const list = Array.isArray(saved) ? saved.filter((r): r is string => typeof r === 'string' && !!r) : []
    if (list.length) return list
  } catch { /* fall through to defaults */ }
  return [...DEFAULT_SIGNER_RELAYS]
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
export async function serialUpdateClient(slotIndex: number, changes: { label?: string; allowed_kinds?: number[]; auto_approve?: boolean }): Promise<void> {
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
  approveSigning: boolean,
): Promise<{ bunker_uri: string; secret: string; signing_approved: boolean; slot_index: number }> {
  let res: { bunker_uri: string; secret: string; signing_approved: boolean; slot_index: number }
  if (device.mode === 'relay') res = await relayCreateClient(label, approveSigning)
  else if (device.mode === 'serial') res = await serialCreateClient(label)
  else throw new Error('not connected')
  // Stash the link so it can be re-copied from the app's card until it connects.
  if (res.bunker_uri && res.slot_index >= 0) device.slotUris[res.slot_index] = res.bunker_uri
  return res
}

/**
 * Pair a nostrconnect app: bind a slot to the app's pubkey and have the signer
 * publish the connect ACK on its relay. Relay-only — the signer must be on the
 * relay to publish, and the app must share that relay (checked in the UI). The
 * device has no clock, so we hand it our current time for the ACK's created_at.
 */
export async function mgmtNostrconnect(params: {
  clientPubkey: string
  secret: string
  label: string
  approveSigning: boolean
  allowedKinds: number[]
}): Promise<{ slot_index: number }> {
  if (device.mode !== 'relay' || !relayTransport) {
    throw new Error('Pairing a nostrconnect app needs the signer connected over WiFi, so it can publish the connect reply. Connect over WiFi and try again.')
  }
  const res = await relayTransport.request('nostrconnect', {
    client_pubkey: params.clientPubkey,
    secret: params.secret,
    created_at: Math.floor(Date.now() / 1000),
    label: params.label,
    approve_signing: params.approveSigning,
    allowed_kinds: params.allowedKinds,
  })
  await relayRefresh()
  return { slot_index: Number(res.slot_index ?? -1) }
}

/**
 * Re-fetch a slot's bunker link. Over USB/HTTP the signer or bridge re-issues it
 * directly. Over WiFi, use the current-session cache first, then ask firmware
 * to re-issue the slot URI over authenticated management. A slot URI is a
 * reusable credential; the signer remembers multiple client keys for the slot.
 */
export async function mgmtClientUri(slotIndex: number): Promise<string> {
  try {
    if (device.mode === 'serial') return await serialGetUri(slotIndex)
    if (device.mode === 'http') return await httpTransport.getSlotUri(device.selectedSlot, slotIndex)
  } catch { /* fall through to the cached copy */ }
  const cached = device.slotUris[slotIndex]
  if (cached) return cached
  if (device.mode === 'relay' && relayTransport) {
    const res = await relayTransport.request('client_uri', { slot_index: slotIndex }, MGMT_WRITE_TIMEOUT_MS)
    const uri = String(res.bunker_uri ?? '')
    if (uri) {
      device.slotUris[slotIndex] = uri
      return uri
    }
  }
  throw new Error('Could not fetch this connection link from the signer. Refresh the signer or create a fresh connection.')
}

export async function mgmtRevokeClient(slotIndex: number): Promise<void> {
  if (device.mode === 'relay') return relayRevokeClient(slotIndex)
  if (device.mode === 'serial') return serialRevokeClient(slotIndex)
  throw new Error('not connected')
}

export async function mgmtUpdateClient(slotIndex: number, changes: { label?: string; allowed_kinds?: number[]; auto_approve?: boolean }): Promise<void> {
  if (device.mode === 'relay') return relayUpdateClient(slotIndex, changes)
  if (device.mode === 'serial') return serialUpdateClient(slotIndex, changes)
  throw new Error('not connected')
}

export async function mgmtApproveSigning(slotIndex: number): Promise<void> {
  if (device.mode === 'relay') return relayApproveSigning(slotIndex)
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
      relayStatus?: RelayStatus | null
      error?: string | null
    } = {},
  ) => {
    device.connected = true
    device.mode = opts.mode ?? 'relay'
    device.portInfo = opts.portInfo ?? 'test-device'
    device.masters = opts.masters ?? []
    device.slots = opts.slots ?? []
    device.operatorPub = opts.operatorPub ?? device.operatorPub
    device.relayStatus = opts.relayStatus ?? null
    device.error = opts.error ?? null
  }
}
