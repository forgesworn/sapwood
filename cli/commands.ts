// Command implementations for the Sapwood CLI.
//
// Each command takes the transport's request surface and returns both a
// machine shape (for --json) and human lines, so tests can drive them with a
// fake transport and no hardware.

import {
  FrameType,
  buildConnSlotList,
  buildConnSlotRevoke,
  buildDeriveIdentity,
  buildFirmwareInfo,
  buildProvisionList,
  buildProvisionRemove,
} from '../src/lib/frame.js'
import type { Frame, FrameTypeValue } from '../src/lib/frame.js'
import type { ConnectSlot, MasterInfo } from '../src/lib/types.js'
import { formatBytes } from '../src/lib/reset-reason.js'
import {
  isValidNsec,
  isValidNcryptsec,
  isValidPhrase,
  isKeyBackupCandidate,
  keyToWords,
  decryptNcryptsec,
} from '../src/lib/restore.js'
import { decodeNsec, zeroize } from '../src/lib/provision.js'
import {
  generateOperatorMnemonic,
  isValidOperatorMnemonic,
  normaliseMnemonic,
  operatorFromMnemonic,
} from '../src/lib/operator-key.js'
import { nip19 } from 'nostr-tools'
import type { DeviceMaster } from '../src/lib/backup.js'

/** The backup and restore guide, printed so CLI users can find the full story. */
export const BACKUP_GUIDE_URL =
  'https://github.com/forgesworn/sapwood/blob/main/docs/backup-and-restore.md'

/** The slice of the transport commands need (NodeSerialTransport satisfies it). */
export interface CommandTransport {
  sendAndReceive(
    frame: Uint8Array,
    expectedTypes: FrameTypeValue[],
    timeoutMs?: number,
  ): Promise<Frame>
}

export interface CommandResult {
  data: unknown
  lines: string[]
}

export class CommandError extends Error {}

export interface CommandOptions {
  timeoutMs: number
}

const decoder = new TextDecoder()

function nackReason(frame: Frame): string {
  return decoder.decode(frame.payload).trim()
}

/** Interpret a signature file's bytes: 64 raw bytes, or 128 hex chars. */
export function parseSignature(raw: Uint8Array, source: string): Uint8Array {
  if (raw.length === 64) return raw
  const hex = decoder.decode(raw).trim()
  if (/^[0-9a-fA-F]{128}$/.test(hex)) {
    return new Uint8Array(hex.match(/.{2}/g)!.map((b) => parseInt(b, 16)))
  }
  throw new CommandError(`${source} is not a 64-byte signature or 128-char hex file.`)
}

interface FirmwareInfo {
  version: string
  board?: string
  uptime_s?: number
  last_reset?: string
  crashed_during?: string
  /** Largest event content this signer will sign, in bytes. */
  max_sign_bytes?: number
  max_sign_bytes_object?: number
  free_heap?: number
  /** Largest contiguous free block: what a big signature actually needs. */
  largest_block?: number
}

async function fetchFirmwareInfo(t: CommandTransport): Promise<FirmwareInfo | null> {
  try {
    const resp = await t.sendAndReceive(
      buildFirmwareInfo(),
      [FrameType.FIRMWARE_INFO_RESPONSE, FrameType.NACK],
      4_000,
    )
    if (resp.type !== FrameType.FIRMWARE_INFO_RESPONSE) return null
    const info = JSON.parse(decoder.decode(resp.payload)) as FirmwareInfo
    return typeof info?.version === 'string' ? info : null
  } catch {
    return null // older firmware, or no response — treat as unknown
  }
}

async function fetchMasters(t: CommandTransport, o: CommandOptions): Promise<MasterInfo[]> {
  const resp = await t.sendAndReceive(
    buildProvisionList(),
    [FrameType.PROVISION_LIST_RESPONSE, FrameType.NACK],
    o.timeoutMs,
  )
  if (resp.type !== FrameType.PROVISION_LIST_RESPONSE) {
    throw new CommandError(nackReason(resp) || 'The signer rejected the identity list request.')
  }
  return JSON.parse(decoder.decode(resp.payload)) as MasterInfo[]
}

async function fetchApps(t: CommandTransport, slot: number, o: CommandOptions): Promise<ConnectSlot[]> {
  const resp = await t.sendAndReceive(
    buildConnSlotList(slot),
    [FrameType.CONNSLOT_LIST_RESP, FrameType.NACK],
    o.timeoutMs,
  )
  if (resp.type !== FrameType.CONNSLOT_LIST_RESP) {
    throw new CommandError(nackReason(resp) || `The signer rejected the app list for identity slot ${slot}.`)
  }
  return JSON.parse(decoder.decode(resp.payload)) as ConnectSlot[]
}

/** Resolve which master slot a command targets; `flag` names the picker option. */
function resolveIdentitySlot(
  masters: MasterInfo[],
  requested: number | undefined,
  flag = '--identity',
): MasterInfo {
  const identities = masters.filter((m) => !m.persona)
  if (requested !== undefined) {
    const match = identities.find((m) => m.slot === requested)
    if (!match) {
      throw new CommandError(`No identity in slot ${requested}. Slots: ${identities.map((m) => m.slot).join(', ') || 'none'}.`)
    }
    return match
  }
  if (identities.length === 1) return identities[0]!
  if (identities.length === 0) throw new CommandError('The signer holds no identities. Provision one first.')
  throw new CommandError(
    `The signer holds ${identities.length} identities. Pick one with ${flag} <slot> (${identities.map((m) => `${m.slot}: ${m.label}`).join(', ')}).`,
  )
}

function shortNpub(npub: string): string {
  return npub.length > 16 ? `${npub.slice(0, 9)}…${npub.slice(-4)}` : npub
}

function formatUptime(s: number): string {
  const d = Math.floor(s / 86_400)
  const h = Math.floor((s % 86_400) / 3_600)
  const m = Math.floor((s % 3_600) / 60)
  if (d > 0) return `${d}d ${h}h`
  if (h > 0) return `${h}h ${m}m`
  if (m > 0) return `${m}m ${s % 60}s`
  return `${s}s`
}

/** Align rows into columns, two spaces between them. */
function table(rows: string[][]): string[] {
  const widths: number[] = []
  for (const row of rows) {
    row.forEach((cell, i) => {
      widths[i] = Math.max(widths[i] ?? 0, cell.length)
    })
  }
  return rows.map((row) =>
    row.map((cell, i) => (i === row.length - 1 ? cell : cell.padEnd(widths[i]!))).join('  ').trimEnd(),
  )
}

// --- Commands ---

export async function cmdDevice(t: CommandTransport, o: CommandOptions): Promise<CommandResult> {
  const info = await fetchFirmwareInfo(t)
  const masters = await fetchMasters(t, o)
  const identities = masters.filter((m) => !m.persona)
  const personas = masters.filter((m) => m.persona)

  // Total connected apps: from the list response where the firmware reports
  // it, otherwise counted per identity; null when neither route worked.
  let apps: number | null = 0
  for (const m of identities) {
    if (typeof m.apps === 'number') {
      apps = (apps ?? 0) + m.apps
    } else {
      try {
        apps = (apps ?? 0) + (await fetchApps(t, m.slot, o)).length
      } catch {
        apps = null
        break
      }
    }
  }

  const lines: string[] = []
  if (info) {
    lines.push(`✓ HEARTWOOD v${info.version}${info.board ? ` · ${info.board}` : ''}`)
    const health: string[] = []
    if (typeof info.uptime_s === 'number') health.push(`uptime ${formatUptime(info.uptime_s)}`)
    if (info.last_reset) health.push(`last reset ${info.last_reset}`)
    if (info.crashed_during) health.push(`crashed during ${info.crashed_during}`)
    if (health.length > 0) lines.push(`  ${health.join(' · ')}`)

    // Signing headroom. max_sign_bytes is the structural per-board ceiling;
    // largest_block is what actually binds a big signature, because the
    // response needs one contiguous block a little over its base64-expanded
    // size. Showing both means a refused request is explicable rather than
    // mysterious.
    const capacity: string[] = []
    if (typeof info.max_sign_bytes === 'number') {
      // Two ceilings when the firmware reports one: the second is what a client
      // earns by sending the event as a JSON object and asking for
      // sign_event_compact, which skips the two full-size copies NIP-46's
      // stringified event and echoed-back reply would otherwise cost.
      const compact = info.max_sign_bytes_object
      capacity.push(
        typeof compact === 'number' && compact > info.max_sign_bytes
          ? `max signed message ${formatBytes(info.max_sign_bytes)} (${formatBytes(compact)} compact)`
          : `max signed message ${formatBytes(info.max_sign_bytes)}`,
      )
    }
    if (typeof info.free_heap === 'number') capacity.push(`free heap ${formatBytes(info.free_heap)}`)
    if (typeof info.largest_block === 'number') {
      capacity.push(`largest block ${formatBytes(info.largest_block)}`)
    }
    if (capacity.length > 0) lines.push(`  ${capacity.join(' · ')}`)
  } else {
    lines.push('✓ HEARTWOOD connected (firmware predates the version query)')
  }
  const personaNote = personas.length > 0 ? ` (+${personas.length} persona${personas.length === 1 ? '' : 's'})` : ''
  lines.push(`  identities ${identities.length}${personaNote} · connected apps ${apps ?? 'unknown'}`)

  return {
    data: {
      firmware: info,
      identities: identities.length,
      personas: personas.length,
      apps,
    },
    lines,
  }
}

export async function cmdIdentities(t: CommandTransport, o: CommandOptions): Promise<CommandResult> {
  const masters = await fetchMasters(t, o)
  if (masters.length === 0) {
    return { data: [], lines: ['The signer holds no identities. Provision one first.'] }
  }
  const rows: string[][] = [['SLOT', 'NAME', 'NPUB', 'TYPE', 'APPS']]
  for (const m of masters) {
    const owner = m.persona ? masters.find((x) => !x.persona && x.slot === m.slot) : undefined
    rows.push([
      String(m.slot),
      m.label,
      shortNpub(m.npub),
      m.persona ? `persona of ${owner?.label ?? `slot ${m.slot}`}` : 'master',
      typeof m.apps === 'number' ? String(m.apps) : '--',
    ])
  }
  return { data: masters, lines: table(rows) }
}

export async function cmdDerive(
  t: CommandTransport,
  name: string,
  parentSlot: number | undefined,
  o: CommandOptions,
): Promise<CommandResult> {
  if (name.length === 0) throw new CommandError('Give the new identity a name.')
  const masters = await fetchMasters(t, o)
  const parent = resolveIdentitySlot(masters, parentSlot, '--parent')

  // Derivation writes flash and may precede a reboot on wifi signers; give it
  // room beyond the standard round trip.
  const resp = await t.sendAndReceive(
    buildDeriveIdentity(parent.slot, name),
    [FrameType.DERIVE_IDENTITY_RESPONSE, FrameType.NACK],
    Math.max(o.timeoutMs, 20_000),
  )
  if (resp.type !== FrameType.DERIVE_IDENTITY_RESPONSE) {
    throw new CommandError(
      nackReason(resp) || 'This firmware cannot derive identities on-device. Update the signer with: sapwood firmware update',
    )
  }
  const derived = JSON.parse(decoder.decode(resp.payload)) as {
    slot: number
    label: string
    npub: string
    existing?: boolean
  }
  const lines = [
    derived.existing
      ? `✓ '${derived.label}' already exists under '${parent.label}'`
      : `✓ derived '${derived.label}' under '${parent.label}'`,
    `  ${derived.npub}`,
    '  The same name always derives the same key. No secret left the device.',
  ]
  // A persona or provisioned identity can share the name without being this
  // derived key. Say so, or two same-named identities look interchangeable.
  const namesakes = masters.filter((m) => m.label === derived.label && m.npub !== derived.npub)
  if (!derived.existing && namesakes.length > 0) {
    lines.push(`  Note: ${namesakes.length === 1 ? 'another identity' : `${namesakes.length} other identities`} named '${derived.label}' already existed with a different npub. This new one is distinct.`)
  }
  return { data: { ...derived, namesakes: namesakes.length }, lines }
}

export async function cmdApps(
  t: CommandTransport,
  identitySlot: number | undefined,
  o: CommandOptions,
): Promise<CommandResult> {
  const masters = await fetchMasters(t, o)
  const identities = identitySlot === undefined
    ? masters.filter((m) => !m.persona)
    : [resolveIdentitySlot(masters, identitySlot)]
  if (identities.length === 0) {
    return { data: [], lines: ['The signer holds no identities. Provision one first.'] }
  }

  const data: Array<{ identity: string; slot: number; apps: ConnectSlot[] }> = []
  const rows: string[][] = [['IDENTITY', 'SLOT', 'APP', 'METHODS', 'KINDS', 'AUTO', 'PAIRED']]
  for (const m of identities) {
    const apps = await fetchApps(t, m.slot, o)
    data.push({ identity: m.label, slot: m.slot, apps })
    for (const app of apps) {
      rows.push([
        m.label,
        String(app.slot_index),
        app.label || '(unnamed)',
        String(app.allowed_methods.length),
        // An empty kind list means every kind is allowed (the strict ceiling
        // applies to methods; kinds fail closed only when listed).
        app.allowed_kinds.length === 0 ? 'all' : app.allowed_kinds.length <= 4 ? app.allowed_kinds.join(',') : String(app.allowed_kinds.length),
        app.auto_approve ? 'yes' : 'no',
        app.current_pubkey ? 'yes' : 'no',
      ])
    }
  }
  if (rows.length === 1) {
    return { data, lines: ['No connected apps.'] }
  }
  return { data, lines: table(rows) }
}

/** Look up the removal target so the caller can confirm before sending. */
export async function findRemovalTarget(
  t: CommandTransport,
  slot: number,
  o: CommandOptions,
): Promise<{ target: MasterInfo; personas: number }> {
  const masters = await fetchMasters(t, o)
  const target = masters.find((m) => !m.persona && m.slot === slot)
  if (!target) {
    const slots = masters.filter((m) => !m.persona).map((m) => m.slot).join(', ') || 'none'
    throw new CommandError(`No identity in slot ${slot}. Slots: ${slots}.`)
  }
  return { target, personas: masters.filter((m) => m.persona && m.slot === slot).length }
}

/** Remove a master slot. The device journals, ACKs, then reboots; the caller
 *  is responsible for having confirmed against findRemovalTarget first. */
export async function cmdIdentitiesRemove(
  t: CommandTransport,
  target: MasterInfo,
  o: CommandOptions,
): Promise<CommandResult> {
  const resp = await t.sendAndReceive(
    buildProvisionRemove(target.slot),
    [FrameType.ACK, FrameType.NACK],
    Math.max(o.timeoutMs, 20_000),
  )
  if (resp.type !== FrameType.ACK) {
    throw new CommandError(nackReason(resp) || `The signer refused to remove slot ${target.slot}.`)
  }
  return {
    data: { removed: target.slot, label: target.label, npub: target.npub },
    lines: [
      `✓ removed '${target.label}' (slot ${target.slot})`,
      '  The signer is rebooting to reload its state. Remaining identities renumber to close the gap.',
    ],
  }
}

/** Format a 24-word key backup: numbered words, then the same safety and
 *  restore guidance the web import flow gives. Pure; no device involved. */
function keyBackupResult(words: string): CommandResult {
  const list = words.split(' ')
  const numbered = list.map((w, i) => `  ${String(i + 1).padStart(2)}  ${w}`)
  return {
    data: { words: list },
    lines: [
      '24-word key backup. Write these down in order and keep them offline:',
      '',
      ...numbered,
      '',
      'These words are the key itself, unencrypted: anyone who has them controls the identity.',
      'To restore, paste them into Sapwood (Restore a key I already have, marked as a key',
      'backup) or into heartwood-provision.',
      `Guide: ${BACKUP_GUIDE_URL}`,
    ],
  }
}

/**
 * Make a 24-word BIP-39 key backup of a key you already hold: an `nsec1…`, or a
 * password-encrypted `ncryptsec1…`. Offline and device-free, the same maths the
 * web import screen runs — the words are the key's own bytes, so decoding them
 * later restores the identical npub. A key already on a signer can never be read
 * back out, so this only ever operates on a secret you supply here.
 */
export function cmdKeyBackup(secretInput: string, password?: string): CommandResult {
  const secret = secretInput.trim()
  if (!secret) {
    throw new CommandError('No key given. Pipe an nsec or ncryptsec on stdin, or run it interactively.')
  }
  if (isValidNsec(secret)) {
    const bytes = decodeNsec(secret)
    try {
      return keyBackupResult(keyToWords(bytes))
    } finally {
      zeroize(bytes)
    }
  }
  if (isValidNcryptsec(secret)) {
    if (!password) {
      throw new CommandError('That is an encrypted key (ncryptsec). Provide its password: interactively, or as the second line of stdin.')
    }
    let bytes: Uint8Array
    try {
      bytes = decryptNcryptsec(secret, password)
    } catch {
      throw new CommandError('That password did not unlock the encrypted key. Check it and try again.')
    }
    try {
      return keyBackupResult(keyToWords(bytes))
    } finally {
      zeroize(bytes)
    }
  }
  // Words the owner already holds are already a backup; say so rather than
  // re-encoding or, worse, deriving a different key from them.
  if (isKeyBackupCandidate(secret)) {
    throw new CommandError('That is already a 24-word key backup: it is the key itself, so keep it as is.')
  }
  if (isValidPhrase(secret)) {
    throw new CommandError('That is a recovery phrase, which is already your backup: keep the words safe. This command backs up an nsec or ncryptsec.')
  }
  throw new CommandError('Provide an nsec (nsec1…) or an encrypted key (ncryptsec1…).')
}

/** The provisioned masters as backup-restore match targets: hex pubkey + label.
 *  Personas share their owner's slot table, so they are excluded. */
export async function deviceMastersForBackup(t: CommandTransport, o: CommandOptions): Promise<DeviceMaster[]> {
  const masters = await fetchMasters(t, o)
  return masters
    .filter((m) => !m.persona)
    .map((m) => {
      const decoded = nip19.decode(m.npub)
      if (decoded.type !== 'npub') throw new CommandError(`Signer returned a non-npub identity: ${m.npub}`)
      return { pubkeyHex: decoded.data, label: m.label }
    })
}

/** Shared tail for the operator commands: where the pubkey and secret go. */
function operatorGuidance(): string[] {
  return [
    'The pubkey is baked into the signer when you flash it. The secret is the',
    'management authority: load it into the bridge daemon as NOSTR_SECRET_KEY.',
    'This is not a signing key and never signs your events.',
    `Guide: ${BACKUP_GUIDE_URL}`,
  ]
}

/** Present a derived operator key. `phrase` is included only when it was just
 *  generated (on restore the owner already holds the words). */
function operatorResult(op: { skHex: string; pubHex: string }, phrase?: string): CommandResult {
  const lines: string[] = []
  if (phrase) {
    lines.push('Operator recovery phrase. Write it down, in order, and keep it offline:', '')
    phrase.split(' ').forEach((w, i) => lines.push(`  ${String(i + 1).padStart(2)}  ${w}`))
    lines.push('')
  }
  lines.push(
    'Operator pubkey (bake into the signer when you flash it):',
    `  ${op.pubHex}`,
    'Operator secret (load into the bridge daemon as NOSTR_SECRET_KEY):',
    `  ${op.skHex}`,
    '',
    ...operatorGuidance(),
  )
  return { data: { ...(phrase ? { mnemonic: phrase } : {}), pubHex: op.pubHex, skHex: op.skHex }, lines }
}

/**
 * `operator new`: mint a fresh operator recovery phrase and show the phrase,
 * pubkey and secret. Offline; the same NIP-06 derivation the browser uses, so a
 * key made here manages a signer flashed with its pubkey, and the phrase
 * restores it anywhere.
 */
export function cmdOperatorNew(): CommandResult {
  const mnemonic = generateOperatorMnemonic()
  return operatorResult(operatorFromMnemonic(mnemonic), mnemonic)
}

/**
 * `operator restore`: derive the operator key from a recovery phrase and show
 * its pubkey and secret. For recovering the key on a new host, or reading the
 * secret to load into the bridge daemon. Offline; never opens a device.
 */
export function cmdOperatorRestore(phrase: string): CommandResult {
  const clean = normaliseMnemonic(phrase)
  if (!clean) throw new CommandError('No phrase given. Pipe the operator recovery phrase on stdin, or run it interactively.')
  if (!isValidOperatorMnemonic(clean)) {
    throw new CommandError('That is not a valid recovery phrase. Check the words and their order.')
  }
  return operatorResult(operatorFromMnemonic(clean))
}

export async function cmdAppsRevoke(
  t: CommandTransport,
  slotIndex: number,
  identitySlot: number | undefined,
  o: CommandOptions,
): Promise<CommandResult> {
  const masters = await fetchMasters(t, o)
  const identity = resolveIdentitySlot(masters, identitySlot)
  const resp = await t.sendAndReceive(
    buildConnSlotRevoke(identity.slot, slotIndex),
    [FrameType.CONNSLOT_REVOKE_RESP, FrameType.NACK],
    o.timeoutMs,
  )
  if (resp.type !== FrameType.CONNSLOT_REVOKE_RESP) {
    throw new CommandError(nackReason(resp) || `The signer refused to revoke app slot ${slotIndex}.`)
  }
  return {
    data: { revoked: slotIndex, identity: identity.label },
    lines: [`✓ revoked app slot ${slotIndex} on '${identity.label}'`],
  }
}
