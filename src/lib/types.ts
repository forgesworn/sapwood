// Shared types for the Sapwood management UI.
// These mirror the Heartwood ESP32 data model.

/** A TOFU-approved client policy (matches common/src/policy.rs::ClientPolicy). */
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
}
