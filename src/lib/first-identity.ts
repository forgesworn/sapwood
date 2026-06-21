// Pure state + helpers for the guided "give your signer its first identity"
// flow — the step a brand-new device needs right after flashing, before any
// app can connect. The crypto (generate phrase, derive, build the PROVISION
// frame) lives in provision.ts; sending it over USB lives in device.svelte.ts.
// This module only models the wizard's steps and validates the one input the
// newcomer gives: a name. Keeping it pure makes the whole flow unit-testable.

/** Where the identity comes from. The guided flow only handles 'create'; an
 *  existing key (mnemonic/nsec/bunker) is handled by Advanced › Provision. */
export type IdentitySource = 'create' | 'import'

export type IdentityStep =
  | 'intro' // explain, then choose: create fresh vs "I already have one"
  | 'backup' // show the generated recovery phrase, confirm it's written down + name it
  | 'confirm' // review the derived public address, then write it to the device
  | 'done' // provisioned

/** The device stores a master label of at most 32 bytes. */
export const NAME_MAX = 32

export const IDENTITY_STEPS: IdentityStep[] = ['intro', 'backup', 'confirm', 'done']

/** A name is optional but bounded. Returns an error message, or null if fine. */
export function nameError(name: string): string | null {
  if (name.trim().length > NAME_MAX) return `Keep the name to ${NAME_MAX} characters or fewer.`
  return null
}

/** True when the name (if any) is acceptable — empty is allowed. */
export function nameOk(name: string): boolean {
  return nameError(name) === null
}

/** The label actually written to the device — never empty (the device wants one). */
export function provisionLabel(name: string): string {
  return name.trim() || 'default'
}

/** The friendly label to remember for Home — only when the owner actually named it. */
export function friendlyLabel(name: string): string | undefined {
  return name.trim() || undefined
}

/** Split a recovery phrase into individual words for a numbered grid display. */
export function phraseWords(mnemonic: string): string[] {
  return mnemonic.trim().split(/\s+/).filter(Boolean)
}
