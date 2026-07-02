// Reactive device state shared across all components.
// Supports two transport modes: Web Serial (direct USB) and HTTP (bridge API).

import { transport as serialTransport, type SerialEvent } from './serial.js'
import { httpTransport, HttpTransport, type HttpEvent } from './http.js'
import {
  buildSetNetConfig, FrameType, buildProvisionList, type NetConfig,
  buildSessionAuth, buildSetBridgeSecret, buildGenerateIdentity, buildRestoreIdentity,
  buildFirmwareInfo,
  buildConnSlotCreate, buildConnSlotList, buildConnSlotRevoke, buildConnSlotUpdate, buildConnSlotUri,
} from './frame.js'
import type { ConnectSlot, MasterInfo } from './types.js'
import { loadAvatar, placeholderAvatar, buildSetIdentityMeta, type Avatar } from './avatar.js'
import { resolveProfiles, profileDisplayName } from './profiles.js'
import { RelayTransport } from './relay-transport.js'
import { getOrCreateOperator } from './op-mgmt.js'
import { rememberDevice, npubShort } from './known-devices.js'
import { nip19 } from 'nostr-tools'

// --- Reactive state ---

export type TransportMode = 'none' | 'serial' | 'http' | 'relay'

/** Live device status reported by a wifi device over the relay (kind 24134). */
export interface RelayStatus {
  master_count: number
  slots: number
  mode: string
  relay: string
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
  pendingClients: [] as PendingClient[],
  approvals: [] as Record<string, unknown>[],
  selectedSlot: 0,
  logs: [] as string[],
  error: null as string | null,
  bridgeInfo: null as Record<string, unknown> | null,
  relayStatus: null as RelayStatus | null,
  /** Relay: the operator pubkey Sapwood signs management with (must match the device's baked op_mgmt). */
  operatorPub: '',
  /** USB-direct: true once the bridge session is authenticated (client mgmt allowed). */
  bridgeAuthed: false,
  /** USB-direct: probing whether the freshly-connected device answers frames. */
  usbProbing: false,
  /** USB-direct: device is connected at the port level but answers no frames —
   *  almost always a provisioned WiFi signer that booted into its relay loop and
   *  never reads USB. Drives the "manage over WiFi instead" guidance. */
  usbSilent: false,
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
}

// --- Actions ---

export async function connectSerial(baudRate = 115200) {
  await serialTransport.connect(baudRate)
}

/**
 * Fetch the master's kind-0 profile, resize its avatar in-browser to a small
 * Rgb565 bitmap, and push the name + avatar to the signer over USB
 * (SET_IDENTITY_META, 0x5b). The signer stores it and shows it on its identity
 * card; it never fetches or decodes images itself. If the picture is missing or
 * its host refuses the fetch (CORS), an initial-on-disc placeholder is pushed so
 * the card still carries the name. Returns the synced name, or null when there
 * is no master / no resolvable profile.
 */
export async function syncIdentityMeta(): Promise<string | null> {
  if (device.mode !== 'serial') return null
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

  let avatar: Avatar
  try {
    avatar = profile.picture ? await loadAvatar(profile.picture, 64) : placeholderAvatar(name)
  } catch {
    avatar = placeholderAvatar(name) // image host refused — name + disc beats nothing
  }
  const frame = buildSetIdentityMeta(pubHex, name, avatar)
  const reply = await serialTransport.sendAndReceive(frame, [FrameType.ACK, FrameType.NACK], 30_000)
  if (reply.type === FrameType.NACK) throw new Error('device rejected identity metadata')
  return name
}

// One auto-push per npub per page load: reconnects within a session don't
// rewrite device NVS, while a fresh page load re-syncs (self-healing after a
// factory reset or a profile change).
const idMetaSynced = new Set<string>()

/**
 * Push the identity card to the signer as soon as we know who it is — fired
 * whenever a serial master list lands, so plugging a device in is enough and
 * no manual sync step is needed. Quiet best-effort: failures (and "no profile
 * yet") release the guard so a later master-list refresh retries.
 */
async function autoSyncIdentityMeta() {
  if (device.mode !== 'serial') return
  const npub = device.masters[0]?.npub
  if (!npub || idMetaSynced.has(npub)) return
  idMetaSynced.add(npub) // claim before the await so overlapping triggers no-op
  try {
    const name = await syncIdentityMeta()
    if (name) {
      addLog(`identity card synced to signer: ${name}`)
    } else {
      idMetaSynced.delete(npub) // no profile on the relays yet — retry later
    }
  } catch (e) {
    idMetaSynced.delete(npub)
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

/**
 * Connect to a wifi-standalone device over its relay, as the operator.
 * `devicePubHex` is the device MASTER pubkey (the kind-24134 mgmt address);
 * `relays` is where it listens. Uses the persisted operator secret to sign.
 */
export async function connectRelay(devicePubHex: string, relays: string[], label?: string) {
  const op = getOrCreateOperator()
  const t = new RelayTransport(devicePubHex, relays, op.skHex)
  await t.connect()
  relayTransport = t
  device.connected = true
  device.mode = 'relay'
  device.operatorPub = t.operatorPub
  device.portInfo = `${npubShort(devicePubHex)} · ${relays[0] ?? ''}`
  device.error = null
  device.masters = []
  device.slots = []
  device.relayStatus = null
  rememberDevice(devicePubHex, relays, label)

  // First load, then poll for live status/clients every 4s while connected.
  await relayRefresh()
  if (pollTimer) clearInterval(pollTimer)
  pollTimer = setInterval(() => {
    if (!device.connected || device.mode !== 'relay') {
      if (pollTimer) { clearInterval(pollTimer); pollTimer = null }
      return
    }
    void relayRefresh()
  }, 4000)
}

/** Refresh masters (get_status) and clients (list_clients) over the relay. */
async function relayRefresh() {
  if (!relayTransport) return
  try {
    const raw = await relayTransport.request('get_status')
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
    const res = await relayTransport.request('list_clients')
    const clients = (res.clients as Array<Record<string, unknown>>) ?? []
    device.slots = clients.map((c) => ({
      slot_index: Number(c.slot_index),
      label: String(c.label ?? ''),
      secret: '',
      current_pubkey: (c.current_pubkey as string | null) ?? null,
      allowed_methods: (c.allowed_methods as string[]) ?? [],
      allowed_kinds: (c.allowed_kinds as number[]) ?? [],
      auto_approve: Boolean(c.auto_approve),
      signing_approved: Boolean(c.signing_approved),
    }))
    device.error = null
  } catch (e) {
    device.error = e instanceof Error ? e.message : 'Relay request failed'
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
  const res = await relayTransport.request('create_client', { label, approve_signing: approveSigning })
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
  await relayTransport.request('approve_signing', { slot_index: slotIndex })
  await relayRefresh()
}

/** Revoke a client slot over the relay (operator-authorised). */
export async function relayRevokeClient(slotIndex: number): Promise<void> {
  if (!relayTransport) throw new Error('not connected over relay')
  await relayTransport.request('revoke_client', { slot_index: slotIndex })
  await relayRefresh()
}

/** Update a client slot (label / kind perms / auto-approve) over the relay. */
export async function relayUpdateClient(
  slotIndex: number,
  changes: { label?: string; allowed_kinds?: number[]; auto_approve?: boolean },
): Promise<void> {
  if (!relayTransport) throw new Error('not connected over relay')
  await relayTransport.request('update_client', { slot_index: slotIndex, ...changes })
  await relayRefresh()
}

export async function disconnect() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null }
  if (device.mode === 'serial') {
    await serialTransport.disconnect()
  } else if (device.mode === 'http') {
    await httpTransport.disconnect()
  } else if (device.mode === 'relay') {
    relayTransport?.close()
    relayTransport = null
    device.connected = false
    device.mode = 'none'
    device.portInfo = ''
    device.masters = []
    device.slots = []
    device.relayStatus = null
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

/**
 * On a fresh USB connection, work out whether the device actually answers
 * frames. A USB-reachable signer replies to PROVISION_LIST with either the
 * master list (provisioned) or a NACK (brand-new, still in the first-provision
 * loop). A provisioned WiFi signer, by contrast, boots straight into its relay
 * loop and never reads USB — so it stays silent. Detecting that lets Home steer
 * the operator to WiFi (or the force-USB escape hatch) instead of offering a
 * "create an identity" flow that can only time out.
 *
 * Retries to ride out the ~6s boot animation a just-reset board plays before it
 * services any frame. If a PROVISION_LIST_RESPONSE lands, handleFrame populates
 * device.masters as a side effect.
 */
async function probeSerial() {
  device.usbProbing = true
  device.usbSilent = false
  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await serialTransport.sendAndReceive(
          buildProvisionList(),
          [FrameType.PROVISION_LIST_RESPONSE, FrameType.NACK],
          5_000,
        )
        return // answered → reachable
      } catch { /* timed out this round — the board may still be booting */ }
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
  const ack = await serialTransport.sendAndReceive(buildSessionAuth(secret), [FrameType.SESSION_ACK], 6_000)
  const code = ack.payload[0]
  if (code === 0x00) { device.bridgeAuthed = true; return }
  if (code === 0x02) {
    // No secret on device — set ours (requires a PRG press) then retry.
    const resp = await serialTransport.sendAndReceive(buildSetBridgeSecret(secret), [FrameType.ACK, FrameType.NACK], 35_000)
    if (resp.type !== FrameType.ACK) throw new Error('Pairing rejected on the device')
    const ack2 = await serialTransport.sendAndReceive(buildSessionAuth(secret), [FrameType.SESSION_ACK], 6_000)
    if (ack2.payload[0] !== 0x00) throw new Error('Bridge auth failed after pairing')
    device.bridgeAuthed = true
    return
  }
  throw new Error('Device is paired to a different bridge secret (factory-reset to re-pair).')
}

function lastRelays(): string[] {
  try {
    const saved = JSON.parse(localStorage.getItem('heartwood.lastRelays') ?? '[]')
    if (Array.isArray(saved) && saved.length) return saved
  } catch { /* default */ }
  return []
}

/** Create a client slot over USB. Returns the bunker URI + secret (shown once). */
export async function serialCreateClient(
  label: string,
): Promise<{ bunker_uri: string; secret: string; signing_approved: boolean; slot_index: number }> {
  await ensureBridgeAuth()
  const ms = device.selectedSlot
  const resp = await serialTransport.sendAndReceive(buildConnSlotCreate(ms, label), [FrameType.CONNSLOT_CREATE_RESP, FrameType.NACK], 15_000)
  if (resp.type !== FrameType.CONNSLOT_CREATE_RESP) throw new Error('Create rejected (slots full?)')
  const info = JSON.parse(new TextDecoder().decode(resp.payload)) as { slot_index: number; secret: string }
  const bunker_uri = await serialGetUri(info.slot_index).catch(() => '')
  await refreshSlots()
  return { bunker_uri, secret: info.secret, signing_approved: false, slot_index: info.slot_index }
}

/** Revoke a client slot over USB. */
export async function serialRevokeClient(slotIndex: number): Promise<void> {
  await ensureBridgeAuth()
  const resp = await serialTransport.sendAndReceive(buildConnSlotRevoke(device.selectedSlot, slotIndex), [FrameType.CONNSLOT_REVOKE_RESP, FrameType.NACK], 10_000)
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
  const resp = await serialTransport.sendAndReceive(buildConnSlotUri(device.selectedSlot, slotIndex, lastRelays()), [FrameType.CONNSLOT_URI_RESP, FrameType.NACK], 10_000)
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
  if (device.mode === 'relay') return relayCreateClient(label, approveSigning)
  if (device.mode === 'serial') return serialCreateClient(label)
  throw new Error('not connected')
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
  if (!device.connected) return false
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
    opts: { masters?: MasterInfo[]; slots?: ConnectSlot[]; mode?: TransportMode } = {},
  ) => {
    device.connected = true
    device.mode = opts.mode ?? 'relay'
    device.portInfo = 'test-device'
    device.masters = opts.masters ?? []
    device.slots = opts.slots ?? []
    device.relayStatus = null
    device.error = null
  }
}
