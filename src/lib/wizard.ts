// Pure state + validation for the first-run flashing wizard (the /flash surface).
//
// All logic lives here as pure functions so it can be exhaustively unit-tested
// without a browser or hardware. The Svelte components hold the reactive `$state`
// and delegate every decision (can I advance? is this wifi valid? what does this
// flash stage mean in plain language?) to the functions below.
//
// Tone: calm and plain, no jargon, no exclamation marks (house voice).

/** Linear steps of the happy-path flow. `flashing` and `done` are driven by the
 *  flash itself, not by the user clicking "next". */
export type WizardStep = 'welcome' | 'board' | 'network' | 'review' | 'flashing' | 'done'

export const WIZARD_STEPS: readonly WizardStep[] = [
  'welcome', 'board', 'network', 'review', 'flashing', 'done',
] as const

/** Steps the user actively walks (shown in the "step X of Y" indicator). */
export const USER_STEPS: readonly WizardStep[] = ['welcome', 'board', 'network', 'review'] as const

/** How the signer will live on a network.
 *  - `wifi` (the standard setup): the signer joins your WiFi and serves NIP-46
 *    over relays itself — manageable from anywhere, no extra software.
 *  - `usb` (the hardened tier): the radio stays off, so the key-holding chip
 *    runs no network stack at all. It signs over the cable; remote apps reach
 *    it only through a bridge daemon on the computer it is plugged into. */
export type NetMode = 'wifi' | 'usb'

/** Default relays for a new WiFi signer, drawn from the set the wider
 *  forgesworn/pallasite ecosystem publishes to. Deliberately a small subset:
 *  each listed relay is a live TLS websocket the ESP32 keeps open, so the
 *  default stays light and the editor offers the rest one tap away. */
export const DEFAULT_SIGNER_RELAYS: readonly string[] = [
  'wss://relay.trotters.cc',
  'wss://nos.lol',
  'wss://relay.damus.io',
]

/** The full ecosystem set (pallasite's DEFAULT_RELAYS), offered as one-tap
 *  additions. nostr.wine is deliberately absent: paid, rejected our writes. */
export const SUGGESTED_SIGNER_RELAYS: readonly string[] = [
  ...DEFAULT_SIGNER_RELAYS,
  'wss://relay.nostr.band',
  'wss://relay.primal.net',
  'wss://relay.ditto.pub',
]

export interface WizardData {
  /** BoardSpec.id of the chosen board. */
  boardId: string
  /** WiFi-standalone (default) or USB-only hardened. */
  netMode: NetMode
  ssid: string
  /** WPA2 passphrase; empty means an open network. */
  password: string
  /** Relays the signer will serve NIP-46 over (WiFi mode only). */
  relays: string[]
  /** Wipe the whole flash first (clean slate, destroys any existing master). */
  fullErase: boolean
}

export function initialData(overrides: Partial<WizardData> = {}): WizardData {
  return {
    boardId: '',
    netMode: 'wifi',
    ssid: '',
    password: '',
    relays: [...DEFAULT_SIGNER_RELAYS],
    fullErase: false,
    ...overrides,
  }
}

// --- Relays --------------------------------------------------------------

/** Split a comma/newline-separated relay field into trimmed, non-empty URLs. */
export function parseRelays(text: string): string[] {
  return text.split(/[\n,]/).map((s) => s.trim()).filter(Boolean)
}

/** Validate a relay list. Returns a message, or null when valid. */
export function relayError(relays: string[]): string | null {
  if (relays.length === 0) return 'Add at least one relay so the device can be reached.'
  const bad = relays.find((r) => !/^wss?:\/\/.+/i.test(r))
  if (bad) return `"${bad}" is not a relay address. It should start with wss:// or ws://.`
  return null
}

// --- Wi-Fi ---------------------------------------------------------------

/** SSID: required, at most 32 bytes (the 802.11 limit). */
export function ssidError(ssid: string): string | null {
  const s = ssid.trim()
  if (!s) return 'Enter the name of your Wi-Fi network.'
  if (new TextEncoder().encode(s).length > 32) return 'That Wi-Fi name is too long (max 32 characters).'
  return null
}

/** WPA2 passphrase: empty (open network) or 8–63 characters. */
export function passwordError(password: string): string | null {
  if (password.length === 0) return null // open network
  if (password.length < 8) return 'A Wi-Fi password is at least 8 characters.'
  if (password.length > 63) return 'A Wi-Fi password is at most 63 characters.'
  return null
}

/** First problem with the whole network step, or null when it is ready.
 *  A USB-only signer needs no WiFi and no relays (the bridge daemon carries
 *  its own relay config), so that mode always validates. */
export function networkError(d: WizardData): string | null {
  if (d.netMode === 'usb') return null
  return ssidError(d.ssid) ?? passwordError(d.password) ?? relayError(d.relays)
}

// --- Step gating ---------------------------------------------------------

export function stepIndex(step: WizardStep): number {
  return WIZARD_STEPS.indexOf(step)
}

export function isTerminal(step: WizardStep): boolean {
  return step === 'done'
}

/** Can the user move on from `step` given the data entered so far? */
export function canAdvance(step: WizardStep, d: WizardData): boolean {
  switch (step) {
    case 'welcome': return true
    case 'board': return d.boardId.trim() !== ''
    case 'network': return networkError(d) === null
    case 'review': return networkError(d) === null && d.boardId.trim() !== ''
    case 'flashing': return false // advances itself when the flash completes
    case 'done': return false
  }
}

/** Next step in the linear flow (clamped at the end). */
export function nextStep(step: WizardStep): WizardStep {
  const i = stepIndex(step)
  return WIZARD_STEPS[Math.min(i + 1, WIZARD_STEPS.length - 1)]
}

/** Previous step in the linear flow (clamped at the start). */
export function prevStep(step: WizardStep): WizardStep {
  const i = stepIndex(step)
  return WIZARD_STEPS[Math.max(i - 1, 0)]
}

// --- Friendly progress ---------------------------------------------------

/** Translate a technical flash stage into one plain-language line. */
export function friendlyStage(stage: string): string {
  switch (stage) {
    case 'starting': return 'Getting ready'
    case 'erasing flash': return 'Wiping the device clean'
    case 'bootloader':
    case 'partition table':
    case 'firmware': return 'Installing the firmware'
    case 'config': return 'Saving your settings'
    case 'done': return 'All done'
    default: return 'Working'
  }
}
