<script lang="ts">
  import { device, connectSerial, connectHttp, connectRelay, disconnect, HttpTransport } from '../lib/device.svelte.js'
  import { listKnownDevices, type KnownDevice } from '../lib/known-devices.js'
  import { probeBridge } from '../lib/bridge-probe.js'
  import { navigate } from '../lib/route.svelte.js'
  import { nip05, nip19 } from 'nostr-tools'

  let showHttpForm = $state(false)
  let httpAddress = $state(HttpTransport.savedAddress() ?? '')
  let connecting = $state(false)

  /** Focus an element when it mounts — the a11y-clean alternative to `autofocus`. */
  function focusOnMount(node: HTMLElement) {
    node.focus()
  }

  // --- WiFi (relay) connect ---
  let showRelayForm = $state(false)
  let knownDevices = $state<KnownDevice[]>([])
  let relayPubInput = $state('')
  let relayUrlInput = $state('wss://relay.trotters.cc')
  let relayError = $state('')

  // --- Just-flashed handoff ---
  // Set by the flasher on success: this is a brand-new device, still plugged in.
  // Lead with one obvious "connect and finish" action instead of the full picker.
  let justFlashed = $state(readJustFlashed())
  function readJustFlashed(): boolean {
    try { return sessionStorage.getItem('heartwood.justFlashed') === '1' } catch { return false }
  }
  function clearJustFlashed() {
    justFlashed = false
    try { sessionStorage.removeItem('heartwood.justFlashed') } catch { /* ignore */ }
  }
  // Once connected, the handoff is done — drop the flag so it never reappears.
  $effect(() => { if (device.connected && justFlashed) clearJustFlashed() })

  function openRelayForm() {
    knownDevices = listKnownDevices()
    if (knownDevices.length) {
      relayPubInput = nip19.npubEncode(knownDevices[0].pubHex)
      relayUrlInput = knownDevices[0].relays[0] ?? relayUrlInput
    }
    relayError = ''
    showRelayForm = true
  }

  function pickKnown(e: Event) {
    const hex = (e.target as HTMLSelectElement).value
    const d = knownDevices.find((k) => k.pubHex === hex)
    if (d) { relayPubInput = nip19.npubEncode(d.pubHex); relayUrlInput = d.relays[0] ?? relayUrlInput }
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
    relayError = ''
    connecting = true
    try {
      const raw = relayPubInput.trim()
      let hex = toHex(raw)
      let discoveredRelays: string[] = []
      // A NIP-05 name (you@example.com) is resolved to the device's key here, on
      // submit only — nothing is looked up while you type, so no IP leak.
      if (!hex && nip05.isNip05(raw)) {
        const profile = await nip05.queryProfile(raw)
        if (!profile?.pubkey) {
          relayError = `Couldn't find a device for "${raw}". Check the name, or paste its npub1… address instead.`
          return
        }
        hex = profile.pubkey
        discoveredRelays = profile.relays ?? []
      }
      if (!hex) {
        relayError = "That doesn't look like a device — use its npub1… address or a name like you@example.com."
        return
      }
      // The relay box wins; fall back to any relays the name advertised.
      let relays = relayUrlInput.split(/[\n,]/).map((r) => r.trim()).filter(Boolean)
      if (!relays.length) relays = discoveredRelays
      if (!relays.length) {
        relayError = 'Add at least one relay (or use a name that lists its own).'
        return
      }
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
        // Skip auto-connect on localhost dev servers.
        if (origin.includes('localhost')) return
        // Only auto-connect when this origin actually serves a bridge API. A
        // static host (GitHub Pages, sapwood.forgesworn.dev) answers unknown
        // paths with the SPA's index.html — which must not be taken for a bridge.
        if (!(await probeBridge(origin))) return
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

<div class="connection card">
  {#if device.connected}
    <div class="status-row">
      <span class="indicator connected"></span>
      <span class="conn-label">CONNECTED</span>
      <span class="conn-detail">
        {device.mode === 'serial' ? 'USB' : device.mode === 'relay' ? 'WIFI' : 'BRIDGE'} &mdash; {device.portInfo}
      </span>
      <button class="btn btn-danger btn-disconnect" onclick={() => disconnect()}>Disconnect</button>
    </div>
  {:else}
    {#if !justFlashed}
      <div class="status-row">
        <span class="indicator disconnected"></span>
        <span class="conn-label">DISCONNECTED</span>
      </div>
    {/if}
    {#if showRelayForm}
      <div class="relay-setup">
        <h3 class="section-title relay-title">Connect over your network</h3>
        <p class="hint relay-lead">
          No cable needed — your Heartwood is on your WiFi. To find it, fill in the two boxes
          below. Easiest of all: on the computer where you first set the device up, show its QR
          code and scan it — both boxes then fill themselves in.
        </p>
        <form class="relay-form" onsubmit={(e) => { e.preventDefault(); handleConnectRelay() }}>
          {#if knownDevices.length}
            <label class="field">
              <span class="field-label">A device you've used before</span>
              <select class="field-input" onchange={pickKnown} disabled={connecting}>
                {#each knownDevices as d (d.pubHex)}
                  <option value={d.pubHex}>{d.label}</option>
                {/each}
              </select>
              <span class="field-hint">Pick one to fill in both boxes, or type a new device below.</span>
            </label>
          {/if}

          <label class="field">
            <span class="field-label">1 · Your device's address</span>
            <input
              class="field-input"
              type="text"
              bind:value={relayPubInput}
              placeholder="npub1… or you@example.com"
              disabled={connecting}
            />
            <span class="field-hint">
              Its <code>npub1…</code> address, or a name like <code>you@example.com</code> if it has
              one — both are safe to share. You chose this when setting the device up, so if that was
              on this computer it's already filled in.
            </span>
          </label>

          <label class="field">
            <span class="field-label">2 · The relay it talks through</span>
            <input
              class="field-input"
              type="text"
              bind:value={relayUrlInput}
              placeholder="wss://relay.trotters.cc"
              disabled={connecting}
            />
            <span class="field-hint">
              A relay is a shared postbox on the internet: your browser drops off a message and the
              device picks it up. Use the same one you chose during setup.
            </span>
          </label>

          {#if relayError}<p class="error-text error">{relayError}</p>{/if}

          <div class="relay-actions">
            <button type="submit" class="btn btn-primary" disabled={connecting || !relayPubInput.trim()}>
              {connecting ? 'Connecting…' : 'Connect'}
            </button>
            <button type="button" class="btn btn-ghost" onclick={() => showRelayForm = false}>
              Cancel
            </button>
          </div>
        </form>
      </div>
    {:else if justFlashed}
      <div class="card card--raised card--live finish-setup">
        <h3 class="finish-title">✓ Flashed — now let's finish your signer</h3>
        <p class="finish-lead">
          Tap to connect to your new signer — then we'll name it and make its keys.
          <br /><strong>If it isn't found, press the RESET button on the board first</strong> (it needs a
          restart to start the new firmware), then tap again.
        </p>
        <button
          class="btn btn-primary btn-block finish-btn"
          onclick={handleConnectSerial}
          disabled={connecting || !('serial' in navigator)}
        >
          {connecting ? 'Connecting…' : 'Connect to my new signer →'}
        </button>
        {#if !('serial' in navigator)}
          <p class="warn-text notice">This needs Chrome or Edge on a computer — it talks over the USB cable.</p>
        {/if}
        <button class="btn btn-ghost finish-other" onclick={clearJustFlashed}>
          Connect a different way
        </button>
        <button class="btn btn-ghost finish-other" onclick={() => navigate('flash')}>
          Set up another device
        </button>
      </div>
    {:else if !showHttpForm}
      <button class="btn btn-primary btn-block btn-setup" onclick={() => navigate('flash')}>
        Set up a new device →
      </button>
      <p class="hint connect-hint">Already have one? Connect to manage it:</p>
      <div class="connect-buttons">
        <button
          class="btn btn-secondary"
          onclick={handleConnectSerial}
          disabled={connecting || !('serial' in navigator)}
        >
          {connecting ? 'Connecting...' : 'Connect by USB cable'}
        </button>
        <button class="btn btn-secondary" onclick={openRelayForm} disabled={connecting}>
          Connect over your network
        </button>
      </div>
      {#if !('serial' in navigator)}
        <p class="warn-text notice">Connecting by USB cable needs Chrome or Edge.</p>
      {/if}
      <details class="disclosure more-ways">
        <summary>Other ways to connect</summary>
        <button class="btn btn-secondary more-ways-btn" onclick={() => showHttpForm = true} disabled={connecting}>
          Connect to a bridge
        </button>
        <p class="hint-sm more-ways-note">For a device run through a bridge on your network (advanced).</p>
      </details>
    {:else}
      <form class="http-form" onsubmit={(e) => { e.preventDefault(); handleConnectHttp() }}>
        <input
          type="text"
          class="field-input"
          bind:value={httpAddress}
          placeholder="192.168.0.107:3100"
          disabled={connecting}
          use:focusOnMount
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
    <p class="error-text error">{device.error}</p>
  {/if}
</div>

<style>
  .connection {
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

  .btn-setup {
    margin-top: 1.25rem;
    font-size: 1.05rem;
    padding: 0.85rem 1.5rem;
  }

  .connect-hint {
    margin: 1.5rem 0 0.6rem;
  }

  /* WiFi (relay) connect: a roomy, labelled form that explains itself. */
  .finish-setup {
    margin-top: 1.25rem;
    text-align: center;
  }
  .finish-title {
    font-size: 1.15rem;
    font-weight: 700;
    color: var(--green);
    margin: 0 0 0.6rem;
  }
  .finish-lead {
    font-size: 0.95rem;
    color: var(--text-dim);
    line-height: 1.6;
    margin: 0 auto 1.4rem;
    max-width: 30rem;
  }
  .finish-btn {
    padding: 0.95rem 1rem;
    font-size: 1.05rem;
  }
  .finish-other {
    margin-top: 0.9rem;
    font-size: 0.85rem;
  }

  .relay-setup { margin-top: 1.25rem; }
  .relay-title {
    margin: 0 0 0.5rem;
    letter-spacing: 0.02em;
  }
  .relay-lead {
    font-size: 0.9rem;
    margin: 0 0 1.4rem;
  }
  .relay-form { display: flex; flex-direction: column; gap: 1.2rem; }

  .relay-actions { display: flex; gap: 0.75rem; margin-top: 0.25rem; }
  .relay-actions .btn-primary { flex: 1; }

  .connect-buttons {
    display: flex;
    gap: 0.75rem;
    margin-top: 0;
  }

  .btn-disconnect { margin-left: auto; }

  .http-form {
    display: flex;
    gap: 0.75rem;
    align-items: center;
    margin-top: 1.25rem;
    flex-wrap: wrap;
  }

  .http-form input { width: 240px; }

  .more-ways { margin-top: 1rem; }
  .more-ways summary { letter-spacing: 0.02em; list-style: revert; }
  .more-ways-btn { margin-top: 0.75rem; }
  .more-ways-note { margin: 0.5rem 0 0; line-height: 1.45; }

  .notice { font-size: 0.85rem; margin-top: 0.75rem; }
  .error { font-size: 0.9rem; margin-top: 0.75rem; }

  /* Mobile: stack the connect actions and let forms fill the width. */
  @media (max-width: 640px) {
    .connection { padding: 1rem; }
    .connect-buttons { flex-direction: column; }
    .connect-buttons .btn { width: 100%; }
    .http-form { flex-direction: column; align-items: stretch; }
    .http-form input { width: 100%; }
    .relay-actions { flex-direction: column; }
    .relay-actions .btn { width: 100%; }
    .status-row { flex-wrap: wrap; }
    .btn-disconnect { margin-left: 0; width: 100%; }
  }
</style>
