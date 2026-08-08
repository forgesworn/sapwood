// Shared types for the Sapwood management UI.
// These mirror the Heartwood ESP32 data model.

/** A named connection slot (matches common/src/policy.rs::ConnectSlot). */
export interface ConnectSlot {
  slot_index: number
  label: string
  // secret is redacted in list responses (empty string)
  secret: string
  current_pubkey: string | null
  authorized_pubkeys?: string[]
  allowed_methods: string[]
  allowed_kinds: number[]
  auto_approve: boolean
  signing_approved: boolean
  /** New exact-policy slots deny requests outside their method/kind ceiling. */
  strict_permissions?: boolean
  /** Non-secret SHA-256 commitment to this slot's credential. Relay management
   * binds every index-sensitive request to it so a compacted/reused numeric slot
   * cannot be edited or reissued from a stale phone screen. */
  secret_fingerprint?: string
}

/** Complete automatic authority sent to Heartwood's versioned management API. */
export interface ExactClientPolicy {
  allowed_methods: string[]
  allowed_kinds: number[]
  auto_approve: boolean
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
  /** Absent on persona entries — they have no wire mode of their own. */
  mode?: number
  npub: string
  /** True for a derived persona entry; `slot` is then the OWNING master's slot,
   *  so persona rows must not be offered where a distinct slot is required. */
  persona?: boolean
  /** Relay sessions only: whether this master is the one the management
   *  session is addressed to. Only the addressed master is manageable;
   *  the others are connectable from the front page. */
  addressed?: boolean
  /** Number of app connections under this master (absent on older firmware
   *  and on persona rows, which share their owner's slot table). */
  apps?: number
  /** Display override for the mode tag (e.g. 'WIFI-STANDALONE' over relay). */
  modeLabel?: string
  /** True while this identity's seed is encrypted at rest and the signer is
   *  waiting for its vault key (PROVISION_LIST rows, firmware with vault
   *  support). Absent/false on plaintext or unlocked identities. */
  locked?: boolean
  /** Bunker URI for this identity (Pi multi-instance mode). */
  bunkerUri?: string
  /** Heartwood instance name (Pi mode, e.g. 'personal', 'forgesworn'). */
  instanceName?: string
}
