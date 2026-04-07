// Shared types for the Sapwood management UI.
// These mirror the Heartwood ESP32 data model.

/** A named connection slot (matches common/src/policy.rs::ConnectSlot). */
export interface ConnectSlot {
  slot_index: number
  label: string
  // secret is redacted in list responses (empty string)
  secret: string
  current_pubkey: string | null
  allowed_methods: string[]
  allowed_kinds: number[]
  auto_approve: boolean
  signing_approved: boolean
}

/**
 * @deprecated Use ConnectSlot instead. Kept for any remaining serial-mode
 * code that references the old per-client pubkey policy model.
 */
export interface ClientPolicy {
  client_pubkey: string
  label: string
  allowed_methods: string[]
  allowed_kinds: number[]
  auto_approve: boolean
}

/** Public metadata for a provisioned master (matches common/src/types.rs::MasterInfo). */
export interface MasterInfo {
  slot: number
  label: string
  mode: number
  npub: string
  /** Bunker URI for this identity (Pi multi-instance mode). */
  bunkerUri?: string
  /** Heartwood instance name (Pi mode, e.g. 'personal', 'forgesworn'). */
  instanceName?: string
}
