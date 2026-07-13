// Remembered wifi-standalone devices.
//
// A wifi device is addressed over relays by its MASTER pubkey (v1 uses the
// master pubkey as the kind-24134 management address). The browser can't
// discover that pubkey — there is no announcement, by design — so we remember
// each device the moment we learn its pubkey: at provision time (the Provision
// tab derives the master pubkey) or when the operator types it in to connect.
// Persisted in localStorage; the operator secret lives separately in op-mgmt.ts.

import { nip19 } from 'nostr-tools'

const LS_KEY = 'heartwood.knownDevices'
const NETWORK_HANDOFF_KEY = 'heartwood.pendingNetworkHandoffs.v1'

export interface KnownDevice {
  /** Master x-only pubkey (hex) — the kind-24134 management address. */
  pubHex: string
  /** Relays the device connects out to. */
  relays: string[]
  /** Human label (defaults to the provision label or a short npub). */
  label: string
  /** ISO timestamp this device was last remembered/seen. */
  lastSeen: string
}

/** Password-free crash-recovery journal for one activated network handoff.
 * It is written before activation so a killed mobile tab can still reach both
 * A and B, then collapse to the terminal route after reconnecting. */
export interface PendingNetworkHandoff {
  version: 1
  devicePubHex: string
  transactionId: string
  revision: number
  oldRelays: string[]
  candidateRelays: string[]
}

function load(): KnownDevice[] {
  try {
    const raw = localStorage.getItem(LS_KEY)
    if (!raw) return []
    const arr = JSON.parse(raw) as KnownDevice[]
    return Array.isArray(arr) ? arr.filter((d) => /^[0-9a-f]{64}$/i.test(d.pubHex)) : []
  } catch {
    return []
  }
}

function save(devices: KnownDevice[]): void {
  localStorage.setItem(LS_KEY, JSON.stringify(devices))
}

function mergeRelays(preferred: string[], existing: string[] = []): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const relay of [...preferred, ...existing]) {
    const clean = relay.trim()
    if (!clean || seen.has(clean)) continue
    seen.add(clean)
    out.push(clean)
  }
  return out
}

function validHandoffRelays(value: unknown): value is string[] {
  return Array.isArray(value)
    && value.length > 0
    && value.length <= 8
    && value.every((relay) => typeof relay === 'string' && /^wss:\/\/.+/i.test(relay))
}

function loadNetworkHandoffs(): Record<string, PendingNetworkHandoff> {
  try {
    const parsed = JSON.parse(localStorage.getItem(NETWORK_HANDOFF_KEY) ?? '{}') as Record<string, unknown>
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const valid: Record<string, PendingNetworkHandoff> = {}
    for (const [key, value] of Object.entries(parsed)) {
      const entry = value as Partial<PendingNetworkHandoff>
      if (!/^[0-9a-f]{64}$/.test(key)
        || entry.version !== 1
        || entry.devicePubHex?.toLowerCase() !== key
        || !/^[0-9a-f]{32}$/i.test(entry.transactionId ?? '')
        || !Number.isSafeInteger(entry.revision) || Number(entry.revision) < 1
        || !validHandoffRelays(entry.oldRelays)
        || !validHandoffRelays(entry.candidateRelays)) continue
      valid[key] = {
        version: 1,
        devicePubHex: key,
        transactionId: entry.transactionId!.toLowerCase(),
        revision: Number(entry.revision),
        oldRelays: mergeRelays(entry.oldRelays),
        candidateRelays: mergeRelays(entry.candidateRelays),
      }
    }
    return valid
  } catch {
    return {}
  }
}

export function pendingNetworkHandoff(pubHex: string): PendingNetworkHandoff | null {
  return loadNetworkHandoffs()[pubHex.toLowerCase()] ?? null
}

/** Persist and read back the recovery route before firmware is activated. */
export function savePendingNetworkHandoff(
  value: Omit<PendingNetworkHandoff, 'version' | 'devicePubHex'> & { devicePubHex: string },
): boolean {
  const key = value.devicePubHex.toLowerCase()
  if (!/^[0-9a-f]{64}$/.test(key)
    || !/^[0-9a-f]{32}$/i.test(value.transactionId)
    || !Number.isSafeInteger(value.revision) || value.revision < 1
    || !validHandoffRelays(value.oldRelays)
    || !validHandoffRelays(value.candidateRelays)) return false
  const entry: PendingNetworkHandoff = {
    version: 1,
    devicePubHex: key,
    transactionId: value.transactionId.toLowerCase(),
    revision: value.revision,
    oldRelays: mergeRelays(value.oldRelays),
    candidateRelays: mergeRelays(value.candidateRelays),
  }
  try {
    const all = loadNetworkHandoffs()
    all[key] = entry
    localStorage.setItem(NETWORK_HANDOFF_KEY, JSON.stringify(all))
    return JSON.stringify(pendingNetworkHandoff(key)) === JSON.stringify(entry)
  } catch {
    return false
  }
}

export function clearPendingNetworkHandoff(pubHex: string): boolean {
  const key = pubHex.toLowerCase()
  try {
    const all = loadNetworkHandoffs()
    delete all[key]
    if (Object.keys(all).length) localStorage.setItem(NETWORK_HANDOFF_KEY, JSON.stringify(all))
    else localStorage.removeItem(NETWORK_HANDOFF_KEY)
    return pendingNetworkHandoff(key) === null
  } catch {
    return false
  }
}

/** Candidate first, then old A: the safe route set while terminal outcome is
 * unknown after a reload. Does not mutate the committed known-device record. */
export function networkRecoveryRelays(pubHex: string, fallback: string[]): string[] {
  const pending = pendingNetworkHandoff(pubHex)
  return pending
    ? mergeRelays(pending.candidateRelays, mergeRelays(pending.oldRelays, fallback))
    : mergeRelays(fallback)
}

export function listKnownDevices(): KnownDevice[] {
  return load()
    .map((device) => ({
      ...device,
      relays: networkRecoveryRelays(device.pubHex, device.relays),
    }))
    .sort((a, b) => b.lastSeen.localeCompare(a.lastSeen))
}

/** Display npub for a device pubkey (bech32, abbreviated). */
export function npubShort(pubHex: string): string {
  try {
    const npub = nip19.npubEncode(pubHex)
    return npub.slice(0, 12) + '…' + npub.slice(-6)
  } catch {
    return pubHex.slice(0, 10) + '…' + pubHex.slice(-6)
  }
}

/** x-only hex for an npub (or a hex string passed straight through). null if neither. */
export function npubToHex(input: string): string | null {
  const s = input.trim()
  if (/^[0-9a-f]{64}$/i.test(s)) return s.toLowerCase()
  try {
    const d = nip19.decode(s)
    if (d.type === 'npub') return (d.data as string).toLowerCase()
  } catch { /* not an npub */ }
  return null
}

/** The friendly label remembered for a device, or null if none is stored. */
export function getDeviceLabel(pubHex: string): string | null {
  const key = pubHex.toLowerCase()
  return load().find((d) => d.pubHex.toLowerCase() === key)?.label ?? null
}

/**
 * Set the friendly label for a device, keyed by pubkey. Upserts: if the device
 * is not yet remembered (e.g. connected over USB, not relay), a relay-less entry
 * is created so the name persists. A blank label is ignored.
 */
export function setDeviceLabel(pubHex: string, label: string): void {
  const clean = label.trim()
  if (!/^[0-9a-f]{64}$/i.test(pubHex) || !clean) return
  const key = pubHex.toLowerCase()
  const devices = load()
  const existing = devices.find((d) => d.pubHex.toLowerCase() === key)
  if (existing) {
    existing.label = clean
    existing.lastSeen = new Date().toISOString()
  } else {
    devices.push({ pubHex: key, relays: [], label: clean, lastSeen: new Date().toISOString() })
  }
  save(devices)
}

/** Insert or update a device, keyed by pubHex. Relays/label are merged, not lost. */
export function rememberDevice(pubHex: string, relays: string[], label?: string): KnownDevice {
  const key = pubHex.toLowerCase()
  const devices = load()
  const existing = devices.find((d) => d.pubHex.toLowerCase() === key)
  const now = new Date().toISOString()
  if (existing) {
    if (relays.length) existing.relays = mergeRelays(relays, existing.relays)
    if (label) existing.label = label
    existing.lastSeen = now
    save(devices)
    return existing
  }
  const entry: KnownDevice = {
    pubHex: key,
    relays: relays.length ? mergeRelays(relays) : ['wss://relay.trotters.cc'],
    label: label || npubShort(key),
    lastSeen: now,
  }
  devices.push(entry)
  save(devices)
  return entry
}

/**
 * Replace (rather than merge) the relay set for an already-remembered device.
 *
 * This is deliberately stricter than {@link rememberDevice}: it is used only
 * after a staged network change has reconnected and committed successfully.
 * Refusing an empty list and refusing to create a new entry prevents a failed
 * or half-finished migration from erasing the last known route to a signer.
 */
export function replaceDeviceRelays(pubHex: string, relays: string[]): KnownDevice | null {
  if (!/^[0-9a-f]{64}$/i.test(pubHex)) return null
  const next = mergeRelays(relays)
  if (next.length === 0 || next.some((relay) => !/^wss:\/\/.+/i.test(relay))) return null

  const key = pubHex.toLowerCase()
  const devices = load()
  const existing = devices.find((d) => d.pubHex.toLowerCase() === key)
  if (!existing) return null

  existing.relays = next
  existing.lastSeen = new Date().toISOString()
  try {
    save(devices)
  } catch {
    return null
  }
  return existing
}

export function forgetDevice(pubHex: string): void {
  save(load().filter((d) => d.pubHex.toLowerCase() !== pubHex.toLowerCase()))
}
