// "Connect your phone" deep link. The flasher's done screen shows a QR encoding
//   <origin>/#/import?op=<operator-secret-hex>
// The secret rides in the URL *fragment*, so it is never sent to any server
// (no logging). On the phone, consumeImportLink() reads it at startup, loads the
// operator key, then strips it from the address bar. The operator key is the
// device's management authority — NOT the master seed.

import { importOperator } from './op-mgmt.js'

/** One-shot banner state: set when a deep-linked operator key has been loaded. */
export const importNotice = $state<{ shown: boolean }>({ shown: false })

/** Extract a 64-hex operator secret from an `#/import?op=…` hash. Pure/testable. */
export function parseImportOp(hash: string): string | null {
  if (!/^#\/import\b/.test(hash)) return null
  const m = hash.match(/[?&]op=([0-9a-fA-F]{64})(?:&|$)/)
  return m ? m[1].toLowerCase() : null
}

/**
 * If the current URL is an import deep link, load the operator key and clean the
 * URL (so the secret does not linger in the address bar or history). Returns
 * true if a key was imported. Call once at startup, before mount.
 */
export function consumeImportLink(): boolean {
  if (typeof location === 'undefined') return false
  const op = parseImportOp(location.hash)
  if (!op) return false
  try {
    importOperator(op)
  } catch {
    return false
  }
  try {
    history.replaceState(null, '', `${location.pathname}${location.search}#/`)
  } catch {
    location.hash = '#/'
  }
  importNotice.shown = true
  return true
}
