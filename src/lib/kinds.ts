// Common Nostr event kind labels for display.

const KIND_LABELS: Record<number, string> = {
  0: 'Profile',
  1: 'Note',
  3: 'Contacts',
  4: 'DM (NIP-04)',
  5: 'Delete',
  6: 'Repost',
  7: 'Reaction',
  8: 'Badge Award',
  9: 'Group Chat',
  10: 'Group Chat Thread',
  16: 'Repost (Generic)',
  1063: 'File Metadata',
  1984: 'Report',
  6969: 'Zap Goal',
  7000: 'Job Feedback',
  9734: 'Zap Request',
  9735: 'Zap Receipt',
  10000: 'Mute List',
  10001: 'Pin List',
  10002: 'Relay List (NIP-65)',
  13194: 'Wallet Info',
  22242: 'Relay Auth',
  23194: 'Wallet Request',
  23195: 'Wallet Response',
  24133: 'NIP-46 (Nostr Connect)',
  27235: 'HTTP Auth',
  30000: 'Categorised People',
  30001: 'Categorised Bookmarks',
  30008: 'Profile Badges',
  30009: 'Badge Definition',
  30023: 'Long-form Article',
  30078: 'App-specific Data',
  30311: 'Live Event',
}

export function kindLabel(kind: number): string {
  return KIND_LABELS[kind] ?? `kind ${kind}`
}
