// Path B recovery: rebuild a family onto a fresh signer from words only.
//
// My Signet publishes the guardian's roster to its sync relay as a kind-30078
// parameterised-replaceable event (d-tag `signet:dependants`), NIP-44
// self-encrypted to the guardian's natural-person key. That key derives from
// the guardian's recovery words, so a signer holding the words can decrypt the
// roster without any phone: derive the natural person, fetch the ciphertext,
// ask the signer to decrypt it, then re-derive every family identity and check
// each result against the expected pubkey the manifest carries.
//
// This module is the pure half of the wizard: manifest parsing (read-only
// consumer of the My Signet wire format, schema v1), enrolment planning, npub
// verification, and the enrolment loop with injected device effects so the
// hardware harness drives the identical code path the UI does. The wire
// format is a frozen contract (family-bunker C1): parse tolerantly, never
// write it.

import { nip19 } from 'nostr-tools'
import { SimplePool } from 'nostr-tools/pool'
import { relayPoolCompatibilityOptions } from './relay-transport.js'

export const MANIFEST_KIND = 30078
export const MANIFEST_D_TAG = 'signet:dependants'
export const MANIFEST_SCHEMA_V = 1

// Mirrors the publisher's own parser caps so both consumers agree on what a
// valid payload is.
const MAX_DEPENDANTS = 200
const MAX_EXTRAS = 50
const NAME_CAP = 200

/** Relays the wizard offers by default, user-editable. My Signet's sync rails
 * write to exactly one relay (the user's primary, `relay.trotters.cc` unless
 * changed), so that goes first; the rest are the ecosystem defaults in case
 * the roster was published from an edited preference. */
export const DEFAULT_MANIFEST_RELAYS: readonly string[] = [
  'wss://relay.trotters.cc',
  'wss://nos.lol',
  'wss://relay.damus.io',
  'wss://relay.primal.net',
]

/** The derivation name the natural person lives at. The signer prepends the
 * reserved `nostr:persona:` namespace itself, matching nsec-tree
 * `derivePersona` and therefore every My Signet key byte-for-byte. */
export const NATURAL_PERSON_NAME = 'natural-person'

/** The guardian's own deterministic personas. These appear in no manifest
 * (nothing needs to: the names are fixed by the protocol), so the wizard
 * derives them blind — there is no expected pubkey to check against. */
export const GUARDIAN_PERSONA_NAMES: readonly string[] = ['persona', 'professional']

// --- Manifest (read-only consumer of the sync wire, schema v1) ------------

export interface ManifestIdentity {
  publicKey: string
  displayName: string
}

export interface ManifestExtra {
  derivationName: string
  publicKey: string
  displayName: string
}

export interface ManifestDependant {
  /** The dependant's natural-person pubkey (doubles as its id). */
  id: string
  guardianPubkey: string
  displayName: string
  /** `dependant-N` for derived records; `imported-view-*` for view-only. */
  derivationPath: string
  autonomyStage: string
  createdAt: number
  np: ManifestIdentity
  persona: ManifestIdentity
  extras: ManifestExtra[]
  /** No private keys exist anywhere for this record; it cannot be enrolled. */
  viewOnly: boolean
}

export interface DependantsManifest {
  v: number
  dependants: ManifestDependant[]
}

function asIdentity(value: unknown): ManifestIdentity | null {
  if (typeof value !== 'object' || value === null) return null
  const record = value as Record<string, unknown>
  if (typeof record.publicKey !== 'string' || typeof record.displayName !== 'string') return null
  return { publicKey: record.publicKey.toLowerCase(), displayName: record.displayName.slice(0, NAME_CAP) }
}

/** Parse the decrypted `signet:dependants` payload. Tolerance mirrors the
 * publisher's own reader: newer schema versions are rejected whole, malformed
 * records are skipped individually, unknown fields are ignored. Throws with a
 * plain-language reason when nothing can be recovered from the payload. */
export function parseDependantsManifest(raw: string): DependantsManifest {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error('The decrypted roster is not valid JSON. The relay event may be corrupt.')
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error('The decrypted roster has an unexpected shape.')
  }
  const payload = parsed as Record<string, unknown>
  if (typeof payload.v !== 'number' || payload.v > MANIFEST_SCHEMA_V) {
    throw new Error('This roster was written by a newer My Signet than Sapwood understands. Update Sapwood, then try again.')
  }
  if (!Array.isArray(payload.dependants) || payload.dependants.length > MAX_DEPENDANTS) {
    throw new Error('The decrypted roster has an unexpected shape.')
  }

  const dependants: ManifestDependant[] = []
  for (const item of payload.dependants) {
    if (typeof item !== 'object' || item === null) continue
    const d = item as Record<string, unknown>
    if (typeof d.id !== 'string') continue
    if (typeof d.derivationPath !== 'string') continue
    if (typeof d.displayName !== 'string') continue
    if (typeof d.guardianPubkey !== 'string') continue
    if (typeof d.createdAt !== 'number') continue
    if (typeof d.autonomyStage !== 'string') continue
    const np = asIdentity(d.np)
    const persona = asIdentity(d.persona)
    if (!np || !persona) continue

    const extras: ManifestExtra[] = []
    if (Array.isArray(d.extras)) {
      for (const raw of d.extras.slice(0, MAX_EXTRAS)) {
        if (typeof raw !== 'object' || raw === null) continue
        const e = raw as Record<string, unknown>
        if (typeof e.derivationName !== 'string') continue
        if (typeof e.publicKey !== 'string') continue
        if (typeof e.displayName !== 'string') continue
        extras.push({
          derivationName: e.derivationName,
          publicKey: e.publicKey.toLowerCase(),
          displayName: e.displayName.slice(0, NAME_CAP),
        })
      }
    }

    dependants.push({
      id: d.id.toLowerCase(),
      guardianPubkey: d.guardianPubkey.toLowerCase(),
      displayName: d.displayName.slice(0, NAME_CAP),
      derivationPath: d.derivationPath,
      autonomyStage: d.autonomyStage,
      createdAt: d.createdAt,
      np,
      persona,
      extras,
      viewOnly: d.viewOnly === true,
    })
  }
  return { v: payload.v, dependants }
}

// --- Manifest event selection ---------------------------------------------

export interface ManifestEventLike {
  pubkey: string
  content: string
  created_at: number
  kind: number
  tags: string[][]
}

/** Newest matching manifest event, or null. Pure so relay behaviour (dupes,
 * stale replaceable copies, foreign events) is unit-testable. */
export function pickLatestManifest(
  events: ManifestEventLike[],
  authorHex: string,
): ManifestEventLike | null {
  const author = authorHex.toLowerCase()
  const matching = events.filter((event) =>
    event.kind === MANIFEST_KIND
    && event.pubkey.toLowerCase() === author
    && event.tags.some((tag) => tag[0] === 'd' && tag[1] === MANIFEST_D_TAG),
  )
  if (matching.length === 0) return null
  return matching.sort((a, b) => b.created_at - a.created_at)[0]
}

/** Fetch the newest roster ciphertext for `authorHex` from `relays`. Returns
 * null when no relay has one (published elsewhere, or never published). */
export async function fetchDependantsManifest(
  relays: string[],
  authorHex: string,
): Promise<ManifestEventLike | null> {
  const pool = new SimplePool(relayPoolCompatibilityOptions())
  try {
    const events = await pool.querySync(
      relays,
      { kinds: [MANIFEST_KIND], authors: [authorHex.toLowerCase()], '#d': [MANIFEST_D_TAG] },
      { maxWait: 8000 },
    )
    return pickLatestManifest(events, authorHex)
  } finally {
    pool.destroy()
  }
}

// --- Enrolment plan --------------------------------------------------------

export type EntryOutcome = 'pending' | 'verified' | 'mismatch' | 'failed'

export interface EnrolmentEntry {
  /** Name passed to the signer's derive (it prepends `nostr:persona:`). */
  derivationName: string
  /** Friendly label applied to the registry after a verified derive. */
  displayName: string
  /** Expected x-only pubkey, lowercase hex; empty means derive blind (the
   * guardian's own deterministic personas have nothing to check against). */
  expectedPubkey: string
  /** Whose identity this is, for grouping in the roster. */
  belongsTo: string
}

export interface SkippedEntry {
  displayName: string
  reason: string
}

export interface EnrolmentPlan {
  entries: EnrolmentEntry[]
  skipped: SkippedEntry[]
}

/** Derivation index from a `dependant-N` path, or null for anything else. */
export function dependantIndex(derivationPath: string): number | null {
  const match = /^dependant-(\d+)$/.exec(derivationPath)
  return match ? Number(match[1]) : null
}

function derivationNameError(name: string): string | null {
  if (!name.trim()) return 'empty derivation name'
  if (name.includes('\0') || name.includes('|')) return 'invalid characters in derivation name'
  if (new TextEncoder().encode(name).length > 128) return 'derivation name too long'
  return null
}

/** Turn a parsed manifest into the ordered derive list: the guardian's own
 * personas first (blind), then each derived dependant's np + persona + extras
 * in index order, every one carrying its expected pubkey as a checksum.
 * View-only records and keyless rows are reported as skipped, not silently
 * dropped: what the wizard cannot recover, the guardian must see. */
export function buildEnrolmentPlan(
  manifest: DependantsManifest,
  guardianLabel = 'Guardian',
): EnrolmentPlan {
  const entries: EnrolmentEntry[] = GUARDIAN_PERSONA_NAMES.map((name) => ({
    derivationName: name,
    displayName: name,
    expectedPubkey: '',
    belongsTo: guardianLabel,
  }))
  const skipped: SkippedEntry[] = []

  const derived = manifest.dependants
    .filter((dep) => {
      if (dep.viewOnly || dependantIndex(dep.derivationPath) === null) {
        skipped.push({
          displayName: dep.displayName || dep.id.slice(0, 12),
          reason: 'view-only: no keys exist for this record anywhere, re-import it from its source instead',
        })
        return false
      }
      return true
    })
    .sort((a, b) => dependantIndex(a.derivationPath)! - dependantIndex(b.derivationPath)!)

  for (const dep of derived) {
    const who = dep.displayName || dep.derivationPath
    const rows: Array<{ name: string; label: string; expected: string }> = [
      { name: `${dep.derivationPath}-np`, label: dep.np.displayName || who, expected: dep.np.publicKey },
      { name: `${dep.derivationPath}-persona`, label: dep.persona.displayName || `${who} persona`, expected: dep.persona.publicKey },
      ...dep.extras.map((extra) => ({
        name: extra.derivationName,
        label: extra.displayName || extra.derivationName,
        expected: extra.publicKey,
      })),
    ]
    for (const row of rows) {
      if (!/^[0-9a-f]{64}$/.test(row.expected)) {
        skipped.push({ displayName: row.label, reason: 'no expected pubkey in the roster' })
        continue
      }
      const invalid = derivationNameError(row.name)
      if (invalid) {
        skipped.push({ displayName: row.label, reason: invalid })
        continue
      }
      entries.push({
        derivationName: row.name,
        displayName: row.label,
        expectedPubkey: row.expected,
        belongsTo: who,
      })
    }
  }
  return { entries, skipped }
}

// --- Verification ----------------------------------------------------------

/** Decode an npub to lowercase hex. Throws on anything that is not an npub. */
export function npubToHex(npub: string): string {
  const decoded = nip19.decode(npub)
  if (decoded.type !== 'npub') throw new Error('Unexpected identity encoding')
  return (decoded.data as string).toLowerCase()
}

/** The manifest's built-in checksum: a derived identity must equal the pubkey
 * the roster promised, or the recovery is wrong (different words, or a
 * derivation drift) and must stop. */
export function verifyDerived(expectedPubkey: string, derivedNpub: string): boolean {
  return npubToHex(derivedNpub) === expectedPubkey.toLowerCase()
}

// --- The enrolment loop ----------------------------------------------------

export interface EnrolmentEffects {
  /** Derive a registry persona on the signer; returns its npub. */
  derive: (name: string) => Promise<{ npub: string }>
  /** Apply a friendly registry label to a derived persona. Failures here are
   * cosmetic and must not abort an otherwise-verified enrolment. */
  rename: (npub: string, label: string) => Promise<void>
}

export interface EnrolmentRowResult extends EnrolmentEntry {
  outcome: EntryOutcome
  npub?: string
  error?: string
}

export interface EnrolmentResult {
  rows: EnrolmentRowResult[]
  /** True when every planned entry verified (blind entries count as verified
   * once derived: they have no checksum to fail). */
  complete: boolean
  /** Set when the loop aborted: a checksum mismatch or a derive failure. */
  abortedOn?: string
}

/** Run the plan against the signer, strictly in order, aborting on the first
 * mismatch or derive failure (a wrong key must never be quietly enrolled
 * alongside right ones). `onProgress` fires after every row settles. */
export async function runEnrolment(
  entries: EnrolmentEntry[],
  fx: EnrolmentEffects,
  onProgress?: (row: EnrolmentRowResult, index: number) => void,
): Promise<EnrolmentResult> {
  const rows: EnrolmentRowResult[] = entries.map((entry) => ({ ...entry, outcome: 'pending' }))
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]
    let npub: string
    try {
      npub = (await fx.derive(row.derivationName)).npub
    } catch (error) {
      row.outcome = 'failed'
      row.error = error instanceof Error ? error.message : String(error)
      onProgress?.(row, i)
      return { rows, complete: false, abortedOn: row.derivationName }
    }
    row.npub = npub
    if (row.expectedPubkey && !verifyDerived(row.expectedPubkey, npub)) {
      row.outcome = 'mismatch'
      row.error = 'The signer derived a different key from the one the roster expects. '
        + 'Check that the recovery words belong to this family, then try again.'
      onProgress?.(row, i)
      return { rows, complete: false, abortedOn: row.derivationName }
    }
    row.outcome = 'verified'
    if (row.displayName && row.displayName !== row.derivationName) {
      try {
        await fx.rename(npub, row.displayName)
      } catch { /* label only; the identity itself is enrolled and verified */ }
    }
    onProgress?.(row, i)
  }
  return { rows, complete: true }
}
