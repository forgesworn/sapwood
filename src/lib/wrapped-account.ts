// USB owner recovery. Never decrypt in the browser or fall back to NIP-44.
import { nip19 } from 'nostr-tools'
import { FrameType, type Frame } from './frame.js'

export interface WrappedSlot { slot: number; npub: string; mode: number }
export type WrappedCommand =
  | { op: 'wrap'; root: WrappedSlot; target: WrappedSlot }
  | { op: 'check'; root: WrappedSlot; record: string; expected_npub: string }
  | { op: 'restore'; root: WrappedSlot; record: string; expected_npub: string; destination: number; label: string }
export interface WrappedReceipt { op: WrappedCommand['op']; npub: string; record?: string; slot?: number }
export interface WrappedConnection {
  mode: string | null
  connected: boolean
  masters: Array<{ slot: number; npub: string; mode?: number; label: string; persona?: boolean }>
  firmware(): Promise<{ capabilities?: string[] } | null>
  authenticate(): Promise<void>
  exchange(command: WrappedCommand): Promise<Frame>
}

export function validWrappedRecord(record: string): boolean {
  return /^nstw1:[A-Za-z0-9_-]{175}$/.test(record)
}
function validNpub(npub: string): boolean {
  try {
    const value = nip19.decode(npub)
    return value.type === 'npub' && nip19.npubEncode(value.data) === npub
  } catch { return false }
}
function validate(c: WrappedConnection, command: WrappedCommand): void {
  if (!c.connected || c.mode !== 'serial') throw new Error('Connect directly by USB for wrapped account recovery.')
  const selected = (reference: WrappedSlot) => c.masters.some(m => !m.persona && m.slot === reference.slot && m.npub === reference.npub && m.mode === reference.mode)
  if (!selected(command.root) || !validNpub(command.root.npub)) throw new Error('The root identity changed. Refresh the signer.')
  if (command.op === 'wrap') {
    if (!selected(command.target) || command.target.mode !== 0 || command.target.slot === command.root.slot || command.target.npub === command.root.npub) {
      throw new Error('Choose a separate raw-key identity held on this signer.')
    }
  } else {
    if (!validWrappedRecord(command.record)) throw new Error('Choose an unmodified 181-byte .nstw file.')
    if (!validNpub(command.expected_npub)) throw new Error('Enter the exact expected account npub.')
    if (command.op === 'restore') {
      const slots = c.masters.filter(m => !m.persona).map(m => m.slot)
      const next = slots.length ? Math.max(...slots) + 1 : 0
      if (!Number.isInteger(command.destination) || command.destination !== next || next >= 8) throw new Error('Choose the next empty identity slot.')
      if (!command.label.trim() || new TextEncoder().encode(command.label).length > 32 || /[\x00-\x1f\x7f]/.test(command.label)) throw new Error('Give the restored account a name of at most 32 bytes.')
      if (c.masters.some(m => m.npub === command.expected_npub)) throw new Error('This identity already exists. No slot was overwritten.')
    }
  }
}

export async function wrappedRequest(c: WrappedConnection, command: WrappedCommand): Promise<WrappedReceipt> {
  validate(c, command)
  const firmware = await c.firmware()
  if (!firmware?.capabilities?.includes('wrapped_nsec_usb_v1')) throw new Error('This firmware does not support wrapped account recovery. Update the signer.')
  await c.authenticate()
  validate(c, command)
  // Send once. On a lost restore reply, refresh identities before retrying.
  const reply = await c.exchange(command)
  if (reply.type !== FrameType.WRAPPED_NSEC_RESP) {
    throw new Error(new TextDecoder().decode(reply.payload).slice(0, 256) || 'The signer refused the wrapped account operation.')
  }
  if (reply.payload.length > 512) throw new Error('The signer returned an invalid recovery receipt.')
  const receipt: unknown = JSON.parse(new TextDecoder().decode(reply.payload))
  if (!receipt || typeof receipt !== 'object') throw new Error('The signer returned an invalid recovery receipt.')
  const value = receipt as Record<string, unknown> // Narrow the untrusted JSON receipt before reading fields.
  const expected = command.op === 'wrap' ? command.target.npub : command.expected_npub
  if (value.op !== command.op || value.npub !== expected) throw new Error('The signer returned a different identity. Nothing is confirmed.')
  if (command.op === 'wrap' && (typeof value.record !== 'string' || !validWrappedRecord(value.record))) throw new Error('The signer returned an invalid wrapped file.')
  if (command.op === 'restore' && (value.slot !== command.destination || value.mode !== 0 || value.derivation_version !== 0)) throw new Error('The signer did not confirm the new raw-key slot. Refresh identities.')
  return { op: command.op, npub: expected, ...(command.op === 'wrap' ? { record: String(value.record) } : {}), ...(command.op === 'restore' ? { slot: command.destination } : {}) }
}
