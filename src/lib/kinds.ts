// Common Nostr event kind labels and risk categories.

export interface KindInfo {
  kind: number
  label: string
  risk: 'low' | 'medium' | 'high'
  category: 'signing' | 'crypto' | 'identity' | 'social' | 'app' | 'payment' | 'relay'
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

  // App-local state -- common Nostr clients use this for settings/feed sync.
  { kind: 30078, label: 'App Data',     risk: 'medium', category: 'app' },

  // Encrypted messages
  { kind: 4,     label: 'DM (NIP-04)',  risk: 'medium', category: 'crypto' },
  { kind: 1059,  label: 'Gift Wrap',    risk: 'medium', category: 'crypto' },

  // Payments -- high risk
  { kind: 9734,  label: 'Zap Request',  risk: 'high',   category: 'payment' },
  { kind: 9735,  label: 'Zap Receipt',  risk: 'medium', category: 'payment' },

  // V4V gated content (Pulsewire). Kind numbers provisional until NIP review.
  // 27117 authorises a paywall key deposit / re-price -- it sets money terms
  // for a release, so it is high risk despite never being published.
  { kind: 27117, label: 'Gated Deposit Auth', risk: 'high',   category: 'payment' },
  { kind: 30808, label: 'Gated Content',      risk: 'medium', category: 'payment' },

  // Auth
  { kind: 22242, label: 'Relay Auth',   risk: 'low',    category: 'relay' },
  { kind: 24133, label: 'NIP-46',       risk: 'low',    category: 'relay' },
  { kind: 27235, label: 'HTTP Auth',    risk: 'low',    category: 'relay' },
]

const LABEL_MAP = new Map(COMMON_KINDS.map(k => [k.kind, k]))

const ALL_LABELS: Record<number, string> = {
  0: 'Profile', 1: 'Note', 3: 'Contacts', 4: 'DM (NIP-04)', 5: 'Delete',
  6: 'Repost', 7: 'Reaction', 8: 'Badge Award', 9: 'Group Chat',
  11: 'Thread', 13: 'Seal', 14: 'Direct Message', 15: 'File Message',
  16: 'Repost (Generic)', 17: 'Website Reaction', 20: 'Picture',
  21: 'Video', 22: 'Portrait Video', 24: 'Public Message',
  40: 'Channel Creation', 41: 'Channel Metadata', 42: 'Channel Message',
  43: 'Channel Hide', 44: 'Channel Mute', 62: 'Request to Vanish',
  64: 'Chess (PGN)', 78: 'App Data', 1018: 'Poll Response',
  1059: 'Gift Wrap', 1063: 'File Metadata', 1068: 'Poll',
  1111: 'Comment', 1311: 'Live Chat', 1337: 'Code Snippet',
  1617: 'Patch', 1618: 'Pull Request', 1619: 'Pull Request Update',
  1621: 'Issue', 1984: 'Report', 1985: 'Label', 2003: 'Torrent',
  2004: 'Torrent Comment', 4550: 'Community Post Approval',
  6969: 'Zap Goal', 7000: 'Job Feedback', 9041: 'Zap Goal',
  9734: 'Zap Request', 9735: 'Zap Receipt', 10000: 'Mute List',
  10001: 'Pin List', 10002: 'Relay List', 10003: 'Bookmarks',
  10004: 'Communities', 10005: 'Public Chats', 10006: 'Blocked Relays',
  10007: 'Search Relays', 10009: 'User Groups',
  10013: 'Private Relay List', 10019: 'Nutzap Mint Recommendation',
  10030: 'Emoji List', 10050: 'DM Relays', 13194: 'Wallet Info',
  17375: 'Cashu Wallet', 22242: 'Relay Auth', 23194: 'Wallet Request',
  23195: 'Wallet Response', 24133: 'NIP-46', 27117: 'Gated Deposit Auth',
  27235: 'HTTP Auth',
  30000: 'Follow Sets', 30001: 'Bookmarks', 30002: 'Relay Sets',
  30003: 'Bookmark Sets', 30007: 'Kind Mute Sets',
  30008: 'Profile Badges', 30009: 'Badge Definition',
  30015: 'Interest Sets', 30023: 'Article', 30024: 'Draft Article',
  30030: 'Emoji Sets', 30078: 'App Data', 30311: 'Live Event',
  30808: 'Gated Content',
  30382: 'User Trusted Assertion', 30383: 'Event Trusted Assertion',
  30384: 'Addressable Trusted Assertion', 31234: 'Draft Event',
  31922: 'Date Calendar', 31923: 'Time Calendar', 31924: 'Calendar',
  31925: 'Calendar RSVP', 31989: 'Handler Recommendation',
  31990: 'Handler Information', 34550: 'Community Definition',
  39000: 'Group Metadata',
}

export function kindLabel(kind: number): string {
  const label = ALL_LABELS[kind]
  return label ? `${label} (${kind})` : `Unknown kind ${kind}`
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
