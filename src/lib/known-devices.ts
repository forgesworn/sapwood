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

export function listKnownDevices(): KnownDevice[] {
  return load().sort((a, b) => b.lastSeen.localeCompare(a.lastSeen))
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
    if (relays.length) existing.relays = relays
    if (label) existing.label = label
    existing.lastSeen = now
    save(devices)
    return existing
  }
  const entry: KnownDevice = {
    pubHex: key,
    relays: relays.length ? relays : ['wss://relay.trotters.cc'],
    label: label || npubShort(key),
    lastSeen: now,
  }
  devices.push(entry)
  save(devices)
  return entry
}

export function forgetDevice(pubHex: string): void {
  save(load().filter((d) => d.pubHex.toLowerCase() !== pubHex.toLowerCase()))
}
