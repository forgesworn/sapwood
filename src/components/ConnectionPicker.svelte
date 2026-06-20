<script lang="ts">
  import { device, connectSerial, connectHttp, connectRelay, disconnect, HttpTransport } from '../lib/device.svelte.js'
  import { listKnownDevices, type KnownDevice } from '../lib/known-devices.js'
  import { nip19 } from 'nostr-tools'

  let showHttpForm = $state(false)
  let httpAddress = $state(HttpTransport.savedAddress() ?? '')
  let connecting = $state(false)

  // --- WiFi (relay) connect ---
  let showRelayForm = $state(false)
  let knownDevices = $state<KnownDevice[]>([])
  let relayPubInput = $state('')
  let relayUrlInput = $state('wss://relay.trotters.cc')
  let relayError = $state('')

  function openRelayForm() {
    knownDevices = listKnownDevices()
    if (knownDevices.length) {
      relayPubInput = knownDevices[0].pubHex
      relayUrlInput = knownDevices[0].relays[0] ?? relayUrlInput
    }
    relayError = ''
    showRelayForm = true
  }

  function pickKnown(e: Event) {
    const hex = (e.target as HTMLSelectElement).value
    const d = knownDevices.find((k) => k.pubHex === hex)
    if (d) { relayPubInput = d.pubHex; relayUrlInput = d.relays[0] ?? relayUrlInput }
  }

  /** Accept an npub or 64-char hex; return x-only hex or null. */
  function toHex(input: string): string | null {
    const s = input.trim()
    if (/^[0-9a-f]{64}$/i.test(s)) return s.toLowerCase()
    try {
      const d = nip19.decode(s)
      if (d.type === 'npub') return d.data as string
    } catch { /* fall through */ }
    return null
  }

  async function handleConnectRelay() {
    const hex = toHex(relayPubInput)
    if (!hex) { relayError = 'Enter a valid device npub or 64-char hex pubkey.'; return }
    const relays = relayUrlInput.split(/[\n,]/).map((r) => r.trim()).filter(Boolean)
    if (!relays.length) { relayError = 'Enter at least one relay URL.'; return }
    relayError = ''
    connecting = true
    try {
      const label = knownDevices.find((k) => k.pubHex === hex)?.label
      await connectRelay(hex, relays, label)
      showRelayForm = false
    } catch (e) {
      relayError = e instanceof Error ? e.message : 'Relay connect failed'
    } finally {
      connecting = false
    }
  }

  // If Sapwood is loaded from the bridge itself (e.g. http://bitcoin5.local:3100/),
  // auto-connect to the same origin. When loaded from GitHub Pages or localhost dev,
  // the probe 404s and we fall through to the manual USB / bridge-address picker.
  $effect(() => {
    if (device.connected || connecting) return
    const origin = window.location.origin
    if (!origin.startsWith('http')) return
    void (async () => {
      try {
        // Try heartwoodd (/api/info) first, then ESP32 bridge (/api/bridge/info).
        // Skip auto-connect on localhost dev servers.
        if (origin.includes('localhost')) return

        let res = await fetch(`${origin}/api/info`, { cache: 'no-store' }).catch(() => null)
        if (!res?.ok) res = await fetch(`${origin}/api/bridge/info`, { cache: 'no-store' }).catch(() => null)
        if (!res?.ok) return
        connecting = true
        try { await connectHttp(origin) } catch { /* emitted via listener */ }
        finally { connecting = false }
      } catch { /* not a bridge origin -- fall through to picker */ }
    })()
  })

  async function handleConnectSerial() {
    connecting = true
    try { await connectSerial() } finally { connecting = false }
  }

  async function handleConnectHttp() {
    if (!httpAddress.trim()) return
    connecting = true
    try {
      await connectHttp(httpAddress.trim())
      showHttpForm = false
    } catch { /* emitted via listener */ }
    finally { connecting = false }
  }
</script>

<div class="connection">
  {#if device.connected}
    <div class="status-row">
      <span class="indicator connected"></span>
      <span class="conn-label">CONNECTED</span>
      <span class="conn-detail">
        {device.mode === 'serial' ? 'USB' : device.mode === 'relay' ? 'WIFI' : 'BRIDGE'} &mdash; {device.portInfo}
      </span>
      <button class="btn btn-disconnect" onclick={() => disconnect()}>Disconnect</button>
    </div>
  {:else}
    <div class="status-row">
      <span class="indicator disconnected"></span>
      <span class="conn-label">DISCONNECTED</span>
    </div>
    {#if showRelayForm}
      <form class="http-form" onsubmit={(e) => { e.preventDefault(); handleConnectRelay() }}>
        {#if knownDevices.length}
          <select class="relay-known" onchange={pickKnown}>
            {#each knownDevices as d (d.pubHex)}
              <option value={d.pubHex}>{d.label}</option>
            {/each}
          </select>
        {/if}
        <input
          type="text"
          bind:value={relayPubInput}
          placeholder="device npub or 64-char hex"
          disabled={connecting}
        />
        <input
          type="text"
          bind:value={relayUrlInput}
          placeholder="wss://relay.trotters.cc"
          disabled={connecting}
        />
        <button type="submit" class="btn btn-primary" disabled={connecting || !relayPubInput.trim()}>
          {connecting ? 'Connecting...' : 'Connect'}
        </button>
        <button type="button" class="btn btn-ghost" onclick={() => showRelayForm = false}>
          Cancel
        </button>
      </form>
      {#if relayError}<p class="error">{relayError}</p>{/if}
    {:else if !showHttpForm}
      <div class="connect-buttons">
        <button
          class="btn btn-primary"
          onclick={handleConnectSerial}
          disabled={connecting || !('serial' in navigator)}
        >
          {connecting ? 'Connecting...' : 'Connect USB'}
        </button>
        <button class="btn btn-secondary" onclick={openRelayForm} disabled={connecting}>
          Connect WiFi (relay)
        </button>
        <button class="btn btn-secondary" onclick={() => showHttpForm = true} disabled={connecting}>
          Connect to Bridge
        </button>
      </div>
      {#if !('serial' in navigator)}
        <p class="notice">Web Serial requires Chrome or Edge.</p>
      {/if}
    {:else}
      <form class="http-form" onsubmit={(e) => { e.preventDefault(); handleConnectHttp() }}>
        <input
          type="text"
          bind:value={httpAddress}
          placeholder="192.168.0.107:3100"
          disabled={connecting}
          autofocus
        />
        <button type="submit" class="btn btn-primary" disabled={connecting || !httpAddress.trim()}>
          {connecting ? 'Connecting...' : 'Connect'}
        </button>
        <button type="button" class="btn btn-ghost" onclick={() => showHttpForm = false}>
          Cancel
        </button>
      </form>
    {/if}
  {/if}
  {#if device.error}
    <p class="error">{device.error}</p>
  {/if}
</div>

<style>
  .connection {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 1.25rem 1.5rem;
    margin-bottom: 1rem;
  }

  .status-row {
    display: flex;
    align-items: center;
    gap: 0.75rem;
  }

  .indicator {
    width: 12px;
    height: 12px;
    border-radius: 50%;
    flex-shrink: 0;
  }

  .indicator.connected {
    background: var(--green);
    box-shadow: var(--green-glow);
  }

  .indicator.disconnected {
    background: #333;
    border: 2px solid #444;
  }

  .conn-label {
    font-size: 1rem;
    font-weight: 600;
    letter-spacing: 0.1em;
    color: #fff;
  }

  .conn-detail {
    font-size: 0.9rem;
    color: var(--text-dim);
  }

  .connect-buttons {
    display: flex;
    gap: 0.75rem;
    margin-top: 1.25rem;
  }

  .btn {
    font-family: inherit;
    font-size: 1rem;
    font-weight: 500;
    padding: 0.65rem 1.5rem;
    border-radius: 4px;
    cursor: pointer;
    transition: all 0.15s;
    border: 1px solid transparent;
    letter-spacing: 0.02em;
  }

  .btn:disabled { opacity: 0.35; cursor: not-allowed; }

  .btn-primary {
    background: var(--green);
    color: #050505;
    border-color: var(--green);
    font-weight: 600;
  }
  .btn-primary:hover:not(:disabled) {
    background: #00ff88;
    box-shadow: var(--green-glow);
  }

  .btn-secondary {
    background: transparent;
    color: var(--text);
    border-color: var(--border-bright);
  }
  .btn-secondary:hover:not(:disabled) {
    background: var(--surface-hover);
    border-color: #444;
  }

  .btn-disconnect {
    background: transparent;
    color: var(--red);
    border-color: #442222;
    margin-left: auto;
  }
  .btn-disconnect:hover { background: #1a0808; }

  .btn-ghost {
    background: transparent;
    color: var(--text-muted);
    border: none;
    padding: 0.65rem 1rem;
  }
  .btn-ghost:hover { color: var(--text-dim); }

  .http-form {
    display: flex;
    gap: 0.75rem;
    align-items: center;
    margin-top: 1.25rem;
  }

  .http-form input {
    background: #080808;
    border: 1px solid var(--border-bright);
    color: var(--text);
    padding: 0.65rem 1rem;
    border-radius: 4px;
    font-family: inherit;
    font-size: 1rem;
    width: 240px;
  }
  .http-form input::placeholder { color: #444; }
  .http-form input:focus { outline: none; border-color: var(--green-dim); }
  .http-form { flex-wrap: wrap; }

  .relay-known {
    background: #080808;
    border: 1px solid var(--border-bright);
    color: var(--text);
    padding: 0.65rem 1rem;
    border-radius: 4px;
    font-family: inherit;
    font-size: 0.95rem;
  }
  .relay-known:focus { outline: none; border-color: var(--green-dim); }

  .notice { font-size: 0.85rem; color: var(--amber); margin-top: 0.75rem; }
  .error { font-size: 0.9rem; color: var(--red); margin-top: 0.75rem; }
</style>
