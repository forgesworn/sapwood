// Pure state + validation for the "connect an app" guided flow (admin Home).
//
// Mirrors wizard.ts (the flasher): every decision is a pure function so it can
// be exhaustively unit-tested without a browser or a device. The Svelte
// component holds the reactive `$state` and delegates here.
//
// Tone: calm and plain, no jargon, no exclamation marks (house voice).

/** Linear steps the operator walks to connect an app. */
export type ConnectStep = 'name' | 'permissions' | 'result'

export const CONNECT_STEPS: readonly ConnectStep[] = ['name', 'permissions', 'result'] as const

/** App name: required, trimmed, and a sensible upper bound. */
export function nameError(name: string): string | null {
  const s = name.trim()
  if (!s) return 'Give this app a name so you can recognise it later.'
  if (s.length > 48) return 'That name is a little long. Keep it under 48 characters.'
  return null
}

/** Can we leave the name step / create the connection? */
export function canCreate(name: string): boolean {
  return nameError(name) === null
}

export function stepIndex(step: ConnectStep): number {
  return CONNECT_STEPS.indexOf(step)
}

/** Next step in the linear flow (clamped at the end). */
export function nextStep(step: ConnectStep): ConnectStep {
  const i = stepIndex(step)
  return CONNECT_STEPS[Math.min(i + 1, CONNECT_STEPS.length - 1)]!
}

/** Previous step in the linear flow (clamped at the start). */
export function prevStep(step: ConnectStep): ConnectStep {
  const i = stepIndex(step)
  return CONNECT_STEPS[Math.max(i - 1, 0)]!
}
