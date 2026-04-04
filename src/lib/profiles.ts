// Profile resolver -- fetches kind 0 (metadata) events from a Nostr relay
// to resolve hex pubkeys to human-readable names.

const DEFAULT_RELAY = 'wss://relay.damus.io'
const TIMEOUT_MS = 5000

export interface Profile {
  name: string
  display_name?: string
  picture?: string
  nip05?: string
}

/** Fetch profiles for a list of hex pubkeys from a Nostr relay. */
export async function resolveProfiles(
  pubkeys: string[],
  relay = DEFAULT_RELAY,
): Promise<Map<string, Profile>> {
  if (pubkeys.length === 0) return new Map()

  const profiles = new Map<string, Profile>()

  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      ws.close()
      resolve(profiles)
    }, TIMEOUT_MS)

    const subId = 'sapwood-profiles-' + Math.random().toString(36).slice(2, 8)
    const ws = new WebSocket(relay)

    ws.onopen = () => {
      // REQ for kind 0 events from the given pubkeys.
      const req = JSON.stringify(['REQ', subId, { kinds: [0], authors: pubkeys }])
      ws.send(req)
    }

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data as string)
        if (msg[0] === 'EVENT' && msg[1] === subId && msg[2]) {
          const nostrEvent = msg[2]
          if (nostrEvent.kind === 0 && nostrEvent.pubkey) {
            const content = JSON.parse(nostrEvent.content)
            profiles.set(nostrEvent.pubkey, {
              name: content.name || content.display_name || '',
              display_name: content.display_name,
              picture: content.picture,
              nip05: content.nip05,
            })
          }
        } else if (msg[0] === 'EOSE' && msg[1] === subId) {
          // All events received.
          clearTimeout(timer)
          ws.send(JSON.stringify(['CLOSE', subId]))
          ws.close()
          resolve(profiles)
        }
      } catch {
        // Ignore parse errors.
      }
    }

    ws.onerror = () => {
      clearTimeout(timer)
      resolve(profiles)
    }
  })
}
