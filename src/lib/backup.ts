// Connection-slot backup and restore over the frame protocol, plus the
// encrypted envelope the backup is stored in. Factored out of the UI so the
// device round-trip and the crypto can be exercised against a fake transport.
//
// A signer's connection slots (the app pairings, with their random secrets) and
// its bridge secret live only in device NVS. A factory reset or a reflash wipes
// them, so every app has to re-pair. This module reads them out (BACKUP_EXPORT,
// 0x50 → 0x51) and writes them back after re-provisioning the masters
// (BACKUP_IMPORT, 0x52 → 0x53). Both directions are button-gated on the device;
// import only restores slots for masters the device still holds (matched by
// pubkey), and the firmware verifies that match again on its side.
//
// The exported payload carries slot secrets and the bridge secret IN PLAINTEXT.
// It must never touch disk unencrypted, so the only serialised form here is the
// encrypted envelope: Argon2id (from the user's passphrase) + XChaCha20-Poly1305,
// the same scheme heartwoodd uses at rest, so the two are interchangeable.

import { argon2id } from '@noble/hashes/argon2.js'
import { xchacha20poly1305 } from '@noble/ciphers/chacha.js'
import {
  FrameType,
  buildBackupExportRequest,
  buildBackupImportRequest,
  type FrameTypeValue,
} from './frame.js'
import type { ConnectSlot } from './types.js'

/** A master's metadata and connection slots, mirroring heartwood_common's
 *  BackupMaster. Carries the pubkey (hex x-only) for matching, not the secret. */
export interface BackupMaster {
  slot: number
  label: string
  mode: number
  /** Absent in historical backup files; new firmware exports 0 (raw) or 1. */
  derivation_version?: number
  /** Hex x-only public key (64 chars); how a master is matched on restore. */
  pubkey: string
  connection_slots: ConnectSlot[]
}

/** A non-spendable record of one note held when the backup was exported.
 * `commitment` is never a bearer secret: for an ordinary note (`key_index`
 * null) it is `sha256(k1)`, the mint's own ledger key; for a key note
 * (`key_index` a number) it is an x-only public key. Neither can restore or
 * spend anything -- this is a loss record, not a recovery path. */
export interface NoteBackupInventory {
  id: string
  commitment: string
  state: 'pending' | 'confirmed' | 'spent'
  amount_msat: number
  host: string
  key_index: number | null
  created_at: number
  updated_at: number
}

/** The plaintext backup payload (mirrors heartwood_common's BackupPayload).
 *  Contains the bridge secret in the clear — only ever hold it in memory or
 *  inside a {@link BackupEnvelope}. */
export interface BackupPayload {
  created_at: number
  device_id: string
  masters: BackupMaster[]
  bridge_secret: string
  /** Absent from historical backups and when leniently-parsed input had no
   *  usable inventory (wrong type, oversized, or every entry malformed --
   *  see {@link inventoryReportFor} for what was dropped). At most 16 entries. */
  note_inventory?: NoteBackupInventory[]
  /** Notes the exporting board could not read (e.g. it was locked), so the
   *  inventory above is known incomplete. Omitted when zero. */
  note_inventory_unreadable?: number
}

/** What happened while leniently parsing a backup's note inventory: how many
 *  entries survived, how many were malformed and dropped, how many the board
 *  itself could not read, and whether the whole field was ignored (wrong type
 *  or oversized). Use {@link inventoryReportFor} to read it back for a payload
 *  returned by {@link parseBackupPayload} (or anything that routes through it,
 *  such as {@link exportBackup} and {@link decryptBackup}). */
export interface NoteInventoryReport {
  entries: number
  dropped: number
  unreadable: number
  ignored: boolean
}

// Keyed on the parsed payload object itself, not the wire data: this never
// becomes an enumerable property of BackupPayload, so it is invisible to
// JSON.stringify, spreads (e.g. the import filter) and toEqual comparisons.
const inventoryReports = new WeakMap<BackupPayload, NoteInventoryReport>()

const EMPTY_REPORT: NoteInventoryReport = { entries: 0, dropped: 0, unreadable: 0, ignored: false }

/** The inventory outcome for a payload parsed by this module. Falls back to a
 *  quiet "nothing to report" shape for a payload built by hand (e.g. in a
 *  test) rather than parsed from JSON. */
export function inventoryReportFor(payload: BackupPayload): NoteInventoryReport {
  return inventoryReports.get(payload) ?? EMPTY_REPORT
}

/** msat to sats, integer maths only (floor -- a partial sat is not a sat). */
export function msatToSats(amountMsat: number): number {
  return Math.floor(amountMsat / 1000)
}

/** Argon2id cost parameters recorded in (and read back from) the envelope. */
export interface KdfParams {
  m_cost: number
  t_cost: number
  p_cost: number
}

/** The encrypted-at-rest form of a backup. This is the only shape that is safe
 *  to write to disk or hand to a user. */
export interface BackupEnvelope {
  version: 1
  kdf: 'argon2id'
  kdf_params: KdfParams
  /** base64, 24 bytes. */
  salt: string
  /** base64, 24 bytes (XChaCha20 nonce). */
  nonce: string
  /** base64 ciphertext (XChaCha20-Poly1305 over the payload JSON). */
  ciphertext: string
}

/** heartwoodd's parameters: 64 MiB, 3 passes, 1 lane. */
export const DEFAULT_KDF_PARAMS: KdfParams = { m_cost: 65_536, t_cost: 3, p_cost: 1 }

// Bounds on a decrypted envelope's KDF params, so a crafted file cannot make us
// allocate gigabytes or hang deriving the key.
const KDF_BOUNDS = { m_cost: [1_024, 262_144], t_cost: [1, 10], p_cost: [1, 4] } as const

// The device gives the owner 30s at the OLED to press the button; allow headroom.
const BUTTON_TIMEOUT_MS = 35_000

/** The slice of a transport the backup round-trip needs. Kept minimal so tests
 *  can fake it; both the Web Serial transport and the CLI transport satisfy it. */
export interface BackupTransport {
  sendAndReceive(
    frame: Uint8Array,
    expectedTypes: FrameTypeValue[],
    timeoutMs?: number,
  ): Promise<{ type: number; payload: Uint8Array }>
}

/** A backup operation that failed, with a message fit to show the owner. */
export class BackupError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'BackupError'
  }
}

const encoder = new TextEncoder()
const decoder = new TextDecoder()

// --- base64 (standard, padded) — btoa/atob are global in browsers and Node 18+ ---

function toBase64(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

function fromBase64(text: string): Uint8Array {
  const binary = atob(text)
  const out = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i)
  return out
}

function randomBytes(length: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(length))
}

// --- payload parsing ---
//
// Masters and connection slots are the fields a restore actually needs, and
// are validated exactly as strictly as before (shape-checked, nothing more).
// The note inventory is cosmetic to a restore -- nobody needs it back to
// recover their identities and app pairings -- so it is parsed leniently: a
// malformed entry is dropped and counted rather than failing the payload, and
// a wrong-typed or oversized note_inventory is ignored outright. A bad
// inventory must never block a restore.

const MAX_INVENTORY_ENTRIES = 16

function isNoteEntry(value: unknown): value is NoteBackupInventory {
  if (!value || typeof value !== 'object') return false
  const note = value as Record<string, unknown>
  return typeof note.id === 'string'
    && /^[0-9a-f]{8}$/.test(note.id)
    && typeof note.commitment === 'string'
    && /^[0-9a-f]{64}$/.test(note.commitment)
    && (note.state === 'pending' || note.state === 'confirmed' || note.state === 'spent')
    && typeof note.amount_msat === 'number'
    && Number.isSafeInteger(note.amount_msat)
    && note.amount_msat >= 0
    && typeof note.host === 'string'
    && note.host.length <= 64
    && (note.key_index === null || (typeof note.key_index === 'number' && Number.isSafeInteger(note.key_index) && note.key_index >= 0))
    && typeof note.created_at === 'number'
    && Number.isSafeInteger(note.created_at)
    && note.created_at >= 0
    && typeof note.updated_at === 'number'
    && Number.isSafeInteger(note.updated_at)
    && note.updated_at >= 0
}

/** Lenient parse of the raw `note_inventory` field: keeps valid entries,
 *  drops (and counts) malformed ones, and ignores the field outright if it is
 *  not an array or has more than {@link MAX_INVENTORY_ENTRIES} entries. */
function parseNoteInventory(raw: unknown): { entries: NoteBackupInventory[]; dropped: number; ignored: boolean } {
  if (raw === undefined) return { entries: [], dropped: 0, ignored: false }
  if (!Array.isArray(raw) || raw.length > MAX_INVENTORY_ENTRIES) {
    return { entries: [], dropped: 0, ignored: true }
  }
  const entries: NoteBackupInventory[] = []
  let dropped = 0
  for (const item of raw) {
    if (isNoteEntry(item)) entries.push(item)
    else dropped++
  }
  return { entries, dropped, ignored: false }
}

/** Lenient parse of `note_inventory_unreadable`: anything other than a
 *  non-negative integer is treated as unreported (0), never as a reason to
 *  reject the payload. */
function parseUnreadable(raw: unknown): number {
  return typeof raw === 'number' && Number.isSafeInteger(raw) && raw >= 0 ? raw : 0
}

/** Parse and shape-check a backup payload from raw JSON bytes. Masters and
 *  slots must match the known shape or the whole payload is rejected; the
 *  note inventory is parsed leniently (see above) and never blocks a
 *  restore. Read {@link inventoryReportFor} on the result to see what the
 *  inventory parse dropped, ignored or reported unreadable. */
export function parseBackupPayload(bytes: Uint8Array): BackupPayload {
  let parsed: unknown
  try {
    parsed = JSON.parse(decoder.decode(bytes))
  } catch {
    throw new BackupError('The backup data is not valid JSON.')
  }
  if (!parsed || typeof parsed !== 'object') {
    throw new BackupError('The backup data is missing expected fields.')
  }
  const p = parsed as Record<string, unknown>
  if (
    typeof p.created_at !== 'number'
    || typeof p.device_id !== 'string'
    || typeof p.bridge_secret !== 'string'
    || !Array.isArray(p.masters)
  ) {
    throw new BackupError('The backup data is missing expected fields.')
  }

  const { entries, dropped, ignored } = parseNoteInventory(p.note_inventory)
  const unreadable = parseUnreadable(p.note_inventory_unreadable)

  const payload: BackupPayload = {
    created_at: p.created_at,
    device_id: p.device_id,
    bridge_secret: p.bridge_secret,
    masters: p.masters as BackupMaster[],
  }
  // Only set note_inventory when the field was usably shaped at all (an
  // array within bounds), even if every entry in it was malformed -- that
  // still tells the UI "an inventory was attempted, nothing survived it",
  // which is different from an old backup that never had the field.
  if (Array.isArray(p.note_inventory) && p.note_inventory.length <= MAX_INVENTORY_ENTRIES) {
    payload.note_inventory = entries
  }
  if (unreadable > 0) {
    payload.note_inventory_unreadable = unreadable
  }

  inventoryReports.set(payload, { entries: payload.note_inventory?.length ?? 0, dropped, unreadable, ignored })
  return payload
}

// --- device round-trip ---

/**
 * Read the full backup from the device. Sends BACKUP_EXPORT_REQUEST and waits
 * for the owner to confirm on the button; resolves with the plaintext payload,
 * or throws {@link BackupError} if the signer declines or nothing comes back.
 */
export async function exportBackup(t: BackupTransport): Promise<BackupPayload> {
  const resp = await t.sendAndReceive(
    buildBackupExportRequest(),
    [FrameType.BACKUP_EXPORT_RESPONSE, FrameType.NACK],
    BUTTON_TIMEOUT_MS,
  )
  if (resp.type !== FrameType.BACKUP_EXPORT_RESPONSE) {
    throw new BackupError(exportRefusalMessage(resp.payload))
  }
  return parseBackupPayload(resp.payload)
}

/** How a backup master lines up against the device on restore. */
export interface MasterMatch {
  pubkey: string
  label: string
  slots: number
  matched: boolean
}

/** A provisioned master, as needed to match a backup against the device. */
export interface DeviceMaster {
  pubkeyHex: string
  label: string
}

/**
 * Line a backup up against the masters the device currently holds. Only slots
 * for a master whose pubkey is still provisioned can be restored; the rest are
 * reported as skipped so the UI can say why. Pure — no device involved.
 */
export function matchBackup(
  payload: BackupPayload,
  deviceMasters: DeviceMaster[],
): { matched: BackupMaster[]; report: MasterMatch[] } {
  const present = new Set(deviceMasters.map((m) => m.pubkeyHex.toLowerCase()))
  const matched: BackupMaster[] = []
  const report: MasterMatch[] = []
  for (const master of payload.masters) {
    const isMatched = present.has(master.pubkey.toLowerCase())
    report.push({
      pubkey: master.pubkey,
      label: master.label,
      slots: master.connection_slots.length,
      matched: isMatched,
    })
    if (isMatched) matched.push(master)
  }
  return { matched, report }
}

// --- refusal reasons ---

/**
 * Why the signer refused a restore: the byte after 0x00 in
 * BACKUP_IMPORT_RESPONSE (heartwood_common::backup::ImportRefusal). Firmware
 * before these sent the 0x00 alone. Every refusal used to read as "confirm the
 * prompt", including a restore the owner had approved that then ran out of
 * storage.
 */
const IMPORT_REFUSALS: Record<number, string> = {
  1: 'The signer could not read this backup. Update its firmware, then try again.',
  2: 'This backup holds no app pairings to restore.',
  3: 'This backup holds more app pairings for one identity than the signer can store (16).',
  4: 'The signer refused a pairing in this backup that fails its safety checks. Nothing was changed.',
  5: 'This backup lists the same identity twice, so the signer refused it. Nothing was changed.',
  6: 'None of the backup’s identities are on this signer. Re-provision them first, then import.',
  7: 'The restore was declined on the signer, or its prompt timed out. Nothing was changed.',
  8: 'The signer ran out of storage writing the pairings and put everything back as it was. Remove app pairings or identities it no longer needs, then import again.',
  9: 'The signer could not store the pairings, and could not confirm the old ones were put back. Restart it, check its app pairings, and import again.',
}

/** The owner-facing reason for a refused BACKUP_IMPORT_RESPONSE payload. */
export function importRefusalMessage(payload: Uint8Array): string {
  const reason = payload.length > 1 ? IMPORT_REFUSALS[payload[1]!] : undefined
  return reason ?? 'The signer did not restore the backup. If it showed a prompt, it was declined or timed out; if its screen flashed red, it could not store the pairings.'
}

const NOT_PAIRED = 'This browser is not paired to the signer over USB, so it refused. Reconnect and try again.'

/** A NACK's reason text, mapped to what the owner should do. */
function nackRefusalMessage(payload: Uint8Array, action: 'export' | 'restore'): string {
  const reason = decoder.decode(payload).trim()
  if (/bridge auth required/i.test(reason)) return NOT_PAIRED
  if (/approval on screen/i.test(reason)) return `The signer is showing another approval. Answer it on the signer, then try the ${action} again.`
  if (/declined/i.test(reason)) return `The ${action} was declined on the signer, or its prompt timed out. Nothing was changed.`
  if (reason) return `The signer refused the ${action}: ${reason}.`
  return ''
}

/** The owner-facing reason for a NACKed BACKUP_EXPORT_REQUEST. */
export function exportRefusalMessage(payload: Uint8Array): string {
  // Firmware before reason texts NACKed empty both for "not paired" and for
  // "declined", so the old two-way message is the fallback.
  return nackRefusalMessage(payload, 'export')
    || 'The signer refused the export. If it showed a prompt, confirm it with the button; if it showed nothing, this browser is not paired to it over USB (the export needs an authenticated bridge session).'
}

/** How to restore. */
export interface ImportOptions {
  /** False sends the backup without its bridge secret, so the signer keeps
   *  its current USB pairing and skips the "Replace bridge secret?" prompt.
   *  Default true. */
  keepBridgeSecret?: boolean
}

/** The result of a restore: how many slots were sent, and the per-master report. */
export interface ImportResult {
  restored: number
  masters: MasterMatch[]
}

/**
 * Restore a backup onto the device. Filters to masters the device still holds,
 * sends BACKUP_IMPORT_REQUEST, and waits for the owner to confirm on the button.
 * Throws {@link BackupError} if nothing matches, or the signer refuses.
 */
export async function importBackup(
  t: BackupTransport,
  payload: BackupPayload,
  deviceMasters: DeviceMaster[],
  options: ImportOptions = {},
): Promise<ImportResult> {
  const { matched, report } = matchBackup(payload, deviceMasters)
  if (matched.length === 0) {
    throw new BackupError('None of the backup’s identities are on this signer. Re-provision them first, then import.')
  }
  // The device drops the note inventory on import anyway (it is exported by
  // the board, not restored to it), and BACKUP_IMPORT_REQUEST has a 32 KB
  // frame budget the inventory would eat into for nothing. Strip it here so
  // masters and slots are the only thing sent.
  const { note_inventory: _inventory, note_inventory_unreadable: _unreadable, ...withoutInventory } = payload
  // Without the bridge secret the signer skips its second prompt
  // ("Replace bridge secret?") and keeps the USB pairing it has.
  const filtered: BackupPayload = {
    ...withoutInventory,
    masters: matched,
    bridge_secret: options.keepBridgeSecret === false ? '' : withoutInventory.bridge_secret,
  }
  const resp = await t.sendAndReceive(
    buildBackupImportRequest(JSON.stringify(filtered)),
    [FrameType.BACKUP_IMPORT_RESPONSE, FrameType.NACK],
    BUTTON_TIMEOUT_MS,
  )
  if (resp.type === FrameType.NACK) {
    throw new BackupError(nackRefusalMessage(resp.payload, 'restore'))
  }
  if (resp.payload[0] !== 0x01) {
    throw new BackupError(importRefusalMessage(resp.payload))
  }
  const restored = matched.reduce((total, master) => total + master.connection_slots.length, 0)
  return { restored, masters: report }
}

// --- encrypted envelope ---

function assertBound(name: keyof typeof KDF_BOUNDS, value: unknown): number {
  const [min, max] = KDF_BOUNDS[name]
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw new BackupError(`The backup file has an out-of-range ${name}.`)
  }
  return value
}

/**
 * Encrypt a backup payload into an envelope safe to store or download. Derives
 * the key from the passphrase with Argon2id, then seals the payload JSON with
 * XChaCha20-Poly1305. Params default to heartwoodd's; a lighter set can be
 * passed (tests), and they are recorded so decrypt is self-describing.
 */
export function encryptBackup(
  payload: BackupPayload,
  passphrase: string,
  params: KdfParams = DEFAULT_KDF_PARAMS,
): BackupEnvelope {
  if (!passphrase) throw new BackupError('A passphrase is required to encrypt the backup.')
  const salt = randomBytes(24)
  const nonce = randomBytes(24)
  const key = argon2id(encoder.encode(passphrase), salt, {
    t: params.t_cost,
    m: params.m_cost,
    p: params.p_cost,
    dkLen: 32,
  })
  const plaintext = encoder.encode(JSON.stringify(payload))
  const ciphertext = xchacha20poly1305(key, nonce).encrypt(plaintext)
  return {
    version: 1,
    kdf: 'argon2id',
    kdf_params: { ...params },
    salt: toBase64(salt),
    nonce: toBase64(nonce),
    ciphertext: toBase64(ciphertext),
  }
}

/** Parse untrusted JSON into a validated {@link BackupEnvelope}, or throw. */
export function parseBackupEnvelope(text: string): BackupEnvelope {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new BackupError('That is not a valid backup file.')
  }
  const e = parsed as Record<string, unknown>
  if (!e || typeof e !== 'object') throw new BackupError('That is not a valid backup file.')
  if (e.version !== 1) throw new BackupError('Unsupported backup file version.')
  if (e.kdf !== 'argon2id') throw new BackupError('Unsupported backup key-derivation.')
  const params = e.kdf_params as Record<string, unknown> | undefined
  if (!params || typeof params !== 'object') throw new BackupError('The backup file is missing its KDF parameters.')
  const kdf_params: KdfParams = {
    m_cost: assertBound('m_cost', params.m_cost),
    t_cost: assertBound('t_cost', params.t_cost),
    p_cost: assertBound('p_cost', params.p_cost),
  }
  if (typeof e.salt !== 'string' || typeof e.nonce !== 'string' || typeof e.ciphertext !== 'string') {
    throw new BackupError('The backup file is missing its ciphertext.')
  }
  return { version: 1, kdf: 'argon2id', kdf_params, salt: e.salt, nonce: e.nonce, ciphertext: e.ciphertext }
}

/**
 * Decrypt an envelope back to its payload. Reads the KDF params from the
 * envelope (bounded), re-derives the key, and opens the ciphertext. A wrong
 * passphrase or a tampered file fails the Poly1305 tag and throws.
 */
export function decryptBackup(envelope: BackupEnvelope, passphrase: string): BackupPayload {
  const salt = fromBase64(envelope.salt)
  const nonce = fromBase64(envelope.nonce)
  const ciphertext = fromBase64(envelope.ciphertext)
  const key = argon2id(encoder.encode(passphrase), salt, {
    t: envelope.kdf_params.t_cost,
    m: envelope.kdf_params.m_cost,
    p: envelope.kdf_params.p_cost,
    dkLen: 32,
  })
  let plaintext: Uint8Array
  try {
    plaintext = xchacha20poly1305(key, nonce).decrypt(ciphertext)
  } catch {
    throw new BackupError('Wrong passphrase, or the backup file is corrupt.')
  }
  return parseBackupPayload(plaintext)
}
