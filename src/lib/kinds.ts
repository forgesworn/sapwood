// Common Nostr event kind labels and risk categories.

export interface KindInfo {
  kind: number
  label: string
  risk: 'low' | 'medium' | 'high'
  category: 'signing' | 'crypto' | 'identity' | 'social' | 'payment' | 'relay'
}

// Kinds that users are most likely to encounter and want to control.
export const COMMON_KINDS: KindInfo[] = [
  // Identity -- high risk
  { kind: 0,     label: 'Profile',      risk: 'high',   category: 'identity' },
  { kind: 3,     label: 'Contacts',     risk: 'high',   category: 'identity' },
  { kind: 10002, label: 'Relay List',   risk: 'high',   category: 'relay' },

  // Social -- medium risk
  { kind: 1,     label: 'Note',         risk: 'medium', category: 'social' },
  { kind: 6,     label: 'Repost',       risk: 'low',    category: 'social' },
  { kind: 7,     label: 'Reaction',     risk: 'low',    category: 'social' },
  { kind: 5,     label: 'Delete',       risk: 'medium', category: 'social' },
  { kind: 30023, label: 'Article',      risk: 'medium', category: 'social' },

  // Encrypted messages
  { kind: 4,     label: 'DM (NIP-04)',  risk: 'medium', category: 'crypto' },
  { kind: 1059,  label: 'Gift Wrap',    risk: 'medium', category: 'crypto' },

  // Payments -- high risk
  { kind: 9734,  label: 'Zap Request',  risk: 'high',   category: 'payment' },
  { kind: 9735,  label: 'Zap Receipt',  risk: 'medium', category: 'payment' },

  // Auth
  { kind: 22242, label: 'Relay Auth',   risk: 'low',    category: 'relay' },
  { kind: 24133, label: 'NIP-46',       risk: 'low',    category: 'relay' },
  { kind: 27235, label: 'HTTP Auth',    risk: 'low',    category: 'relay' },
]

const LABEL_MAP = new Map(COMMON_KINDS.map(k => [k.kind, k]))

const ALL_LABELS: Record<number, string> = {
  0: 'Profile', 1: 'Note', 3: 'Contacts', 4: 'DM (NIP-04)', 5: 'Delete',
  6: 'Repost', 7: 'Reaction', 8: 'Badge Award', 9: 'Group Chat',
  16: 'Repost (Generic)', 1059: 'Gift Wrap', 1063: 'File Metadata',
  1984: 'Report', 6969: 'Zap Goal', 7000: 'Job Feedback',
  9734: 'Zap Request', 9735: 'Zap Receipt', 10000: 'Mute List',
  10001: 'Pin List', 10002: 'Relay List', 13194: 'Wallet Info',
  22242: 'Relay Auth', 23194: 'Wallet Request', 23195: 'Wallet Response',
  24133: 'NIP-46', 27235: 'HTTP Auth', 30000: 'People List',
  30001: 'Bookmarks', 30008: 'Profile Badges', 30009: 'Badge Definition',
  30023: 'Article', 30078: 'App Data', 30311: 'Live Event',
}

export function kindLabel(kind: number): string {
  const label = ALL_LABELS[kind]
  return label ? `${label} (${kind})` : `kind ${kind}`
}

export function kindInfo(kind: number): KindInfo | undefined {
  return LABEL_MAP.get(kind)
}

export function riskColour(risk: 'low' | 'medium' | 'high'): string {
  switch (risk) {
    case 'low': return 'var(--green)'
    case 'medium': return 'var(--amber)'
    case 'high': return 'var(--red)'
  }
}
