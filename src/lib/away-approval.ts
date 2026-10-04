// Away approval: the owner's per-app opt-in to answer a button request from
// their phone. On the signer it is the slot's `escalate` flag: a request that
// would draw the approval card is held instead (up to 10 minutes), a notice
// goes to the identity's natural-person key, and the phone answers it with
// `resolve_approval` over the operator channel. Off by default; it trades the
// button for whoever holds the phone's operator key, so turning it on needs an
// explicit acknowledgement and (over USB) a press on the board.

import { MANAGER_SLOT_LABEL } from './client-policy.js'

/** What the panel needs to know about where the signer is. */
export interface AwayApprovalContext {
  /** How Sapwood is talking to the signer. */
  transport: 'serial' | 'relay' | 'http' | null
  /** The signer's own network mode, when Sapwood has read it over USB. */
  boardMode: 'usb' | 'wifi' | null
}

export type AwayApprovalAvailability =
  | { available: true }
  | { available: false; reason: string }

/**
 * Whether the switch can be offered. A held request is answered over the
 * relay, so the board itself must be in WiFi mode: a USB-mode board has no
 * relay to hear the phone on, and a request held there could never be
 * answered. Over the relay the board is necessarily in WiFi mode.
 */
export function awayApprovalAvailability(ctx: AwayApprovalContext): AwayApprovalAvailability {
  if (ctx.transport === 'relay') return { available: true }
  if (ctx.transport === 'serial') {
    if (ctx.boardMode === 'usb') {
      return {
        available: false,
        reason: 'Approving from your phone needs the signer in WiFi mode. In USB mode it has no way to hear your phone.',
      }
    }
    return { available: true }
  }
  return { available: false, reason: 'Connect over USB or WiFi to change this.' }
}

/**
 * Whether the switch belongs on this pairing at all. Sapwood's own manager
 * pairing is bookkeeping, used only with Sapwood open beside the signer, so
 * sending its requests to a phone would make no sense. A manager pairing
 * already switched on (by another tool) still shows, so it can be turned off.
 */
export function awayApprovalOffered(slot: { label?: string | null; escalate?: boolean }): boolean {
  return slot.label !== MANAGER_SLOT_LABEL || Boolean(slot.escalate)
}

/** The risk the owner accepts by turning it on. Shown before the switch saves. */
export const AWAY_APPROVAL_RISKS: readonly string[] = [
  'Whoever holds your phone\'s operator key can approve signatures for this app without touching the board.',
  'Approving once also lets this app sign the same kind of event again for up to 10 minutes without asking.',
  'Requests that must be approved at the board (wallet pairing, rendezvous keys, login codes) still need the button.',
]

/**
 * What the phone needs before a held request can be answered. The signer
 * sends its notice to the identity's natural-person key, which Signet only
 * listens on once it is paired to this signer, and Signet can only answer
 * with the operator key. Sapwood cannot see the phone, so it says this
 * rather than checking it.
 */
export const AWAY_APPROVAL_PHONE_SETUP: readonly string[] = [
  'Signet on your phone is paired with this signer (Heartwood connect), not set up with its own recovery phrase.',
  'Signet holds the operator key: Settings, Advanced, Heartwood operator key.',
  'Held requests appear in Signet\'s signer panel under Family asks, even when they are your own apps.',
]

/** The error when the signer answered but the flag did not move. */
export function awayApprovalNotApplied(on: boolean, transport: string | null): string {
  if (transport === 'relay') {
    return on
      ? 'The signer did not turn on approval from your phone. Its firmware may be too old for this app\'s pairing over WiFi. Update the firmware, or change this over USB.'
      : 'The signer did not turn off approval from your phone. Its firmware may be too old to change this over WiFi. Connect over USB and turn it off there.'
  }
  return on
    ? 'The signer did not turn on approval from your phone.'
    : 'The signer did not turn off approval from your phone.'
}
