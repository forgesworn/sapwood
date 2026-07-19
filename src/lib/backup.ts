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
  /** Hex x-only public key (64 chars); how a master is matched on restore. */
  pubkey: string
  connection_slots: ConnectSlot[]
}

/** The plaintext backup payload (mirrors heartwood_common's BackupPayload).
 *  Contains the bridge secret in the clear — only ever hold it in memory or
 *  inside a {@link BackupEnvelope}. */
export interface BackupPayload {
  created_at: number
  device_id: string
  masters: BackupMaster[]
  bridge_secret: string
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

function isBackupPayload(value: unknown): value is BackupPayload {
  if (!value || typeof value !== 'object') return false
  const p = value as Record<string, unknown>
  return (
    typeof p.created_at === 'number' &&
    typeof p.device_id === 'string' &&
    typeof p.bridge_secret === 'string' &&
    Array.isArray(p.masters)
  )
}

/** Parse and shape-check a backup payload from raw JSON bytes. */
export function parseBackupPayload(bytes: Uint8Array): BackupPayload {
  let parsed: unknown
  try {
    parsed = JSON.parse(decoder.decode(bytes))
  } catch {
    throw new BackupError('The backup data is not valid JSON.')
  }
  if (!isBackupPayload(parsed)) {
    throw new BackupError('The backup data is missing expected fields.')
  }
  return parsed
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
    throw new BackupError('The signer did not export a backup. Confirm the prompt on its screen with the button.')
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
): Promise<ImportResult> {
  const { matched, report } = matchBackup(payload, deviceMasters)
  if (matched.length === 0) {
    throw new BackupError('None of the backup’s identities are on this signer. Re-provision them first, then import.')
  }
  const filtered: BackupPayload = { ...payload, masters: matched }
  const resp = await t.sendAndReceive(
    buildBackupImportRequest(JSON.stringify(filtered)),
    [FrameType.BACKUP_IMPORT_RESPONSE, FrameType.NACK],
    BUTTON_TIMEOUT_MS,
  )
  if (resp.type !== FrameType.BACKUP_IMPORT_RESPONSE || resp.payload[0] !== 0x01) {
    throw new BackupError('The signer did not restore the backup. Confirm the prompt on its screen with the button.')
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
