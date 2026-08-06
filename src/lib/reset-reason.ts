// Present the signer's uptime and last reset cause in plain English, so a
// deliberate restart (identity changes, network activation) reads differently
// from a crash. Reason strings come from the firmware's reset_reason_str().

export interface ResetDescription {
  text: string
  /** True for causes worth investigating (panic, watchdog, brownout). */
  crash: boolean
}

const REASONS: Record<string, ResetDescription> = {
  'power-on': { text: 'powered on', crash: false },
  'external-reset': { text: 'reset button', crash: false },
  'software-restart': { text: 'planned restart', crash: false },
  'deep-sleep-wake': { text: 'woke from deep sleep', crash: false },
  'panic': { text: 'crash (panic)', crash: true },
  'interrupt-watchdog': { text: 'crash (interrupt watchdog)', crash: true },
  'task-watchdog': { text: 'crash (task watchdog)', crash: true },
  'watchdog': { text: 'crash (watchdog)', crash: true },
  'brownout': { text: 'power dip (brownout)', crash: true },
  // ESP-IDF 5.x. On a native-USB board (V4, C6) a host re-opening the port is
  // a routine cause, not a fault, so neither counts as a crash.
  'usb-peripheral-reset': { text: 'USB reset by host', crash: false },
  'jtag-reset': { text: 'JTAG reset', crash: false },
}

export function describeReset(reason: string): ResetDescription {
  return REASONS[reason] ?? { text: reason || 'unknown', crash: reason === 'unknown' }
}

/** "3d 4h", "2h 12m", "5m", "42s" — coarse on purpose; it answers "how long
 *  has it been up", not "time a race". */
export function formatUptime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '--'
  const s = Math.floor(seconds)
  const d = Math.floor(s / 86_400)
  const h = Math.floor((s % 86_400) / 3_600)
  const m = Math.floor((s % 3_600) / 60)
  if (d > 0) return `${d}d ${h}h`
  if (h > 0) return `${h}h ${m}m`
  if (m > 0) return `${m}m`
  return `${s}s`
}

/** "20.0 KB", "180 KB", "512 B". KB here is 1024 bytes, matching how the
 *  firmware's own heap figures are reasoned about. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '--'
  if (bytes < 1024) return `${Math.floor(bytes)} B`
  const kb = bytes / 1024
  if (kb < 100) return `${kb.toFixed(1)} KB`
  if (kb < 1024) return `${Math.round(kb)} KB`
  return `${(kb / 1024).toFixed(1)} MB`
}
