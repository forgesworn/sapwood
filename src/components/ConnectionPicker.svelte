<script lang="ts">
  import { device, connectSerial, connectHttp, connectRelay, disconnect, HttpTransport } from '../lib/device.svelte.js'
  import { listKnownDevices, type KnownDevice } from '../lib/known-devices.js'
  import { findAttachedGrantedPort } from '../lib/serial-ports.js'
  import { probeBridge } from '../lib/bridge-probe.js'
  import { navigate } from '../lib/route.svelte.js'
  import { nip05, nip19 } from 'nostr-tools'

  const canUseUsb = $derived(typeof navigator !== 'undefined' && 'serial' in navigator)
  const MOBILE_QUERY = '(max-width: 640px), ((max-width: 1024px) and (pointer: coarse))'
  let mobile = $state(
    typeof window !== 'undefined'
      && (window.matchMedia?.(MOBILE_QUERY).matches ?? window.innerWidth <= 640),
  )

  $effect(() => {
    const query = window.matchMedia?.(MOBILE_QUERY)
    if (!query) return
    const update = () => { mobile = query.matches }
    query.addEventListener('change', update)
    return () => query.removeEventListener('change', update)
  })

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

  // --- Smart connect ---
  // One button that works out how to reach your signer: a signer physically on
  // the USB cable wins (a previously-granted port that reports attached —
  // connects silently, no chooser); otherwise the signer you used last, over
  // its relay. The explicit cable/network buttons stay one click away.
  // (listKnownDevices is most-recent-first; localStorage isn't reactive, so
  // read once at mount.)
  const smartDevice: KnownDevice | null = listKnownDevices().find((d) => d.relays.length) ?? null
  let attachedPort = $state<SerialPort | null>(null)
  let smartError = $state('')

  // Track the cable live: re-check when a granted device is plugged/unplugged.
  $effect(() => {
    if (!canUseUsb) return
    const refresh = () => { void findAttachedGrantedPort().then((p) => (attachedPort = p)) }
    refresh()
    navigator.serial.addEventListener('connect', refresh)
    navigator.serial.addEventListener('disconnect', refresh)
    return () => {
      navigator.serial.removeEventListener('connect', refresh)
      navigator.serial.removeEventListener('disconnect', refresh)
    }
  })

  async function handleSmartConnect() {
    smartError = ''
    connecting = true
    try {
      // Cable first — it's the faster, quieter path and needs no relay.
      if (attachedPort) {
        try {
          await connectSerial(115200, attachedPort)
          return
        } catch {
          // Cable didn't answer (stale grant, busy port) — fall through to the
          // relay if we know one; the explicit buttons remain either way.
          attachedPort = null
        }
      }
      if (smartDevice) {
        await connectRelay(smartDevice.pubHex, smartDevice.relays, smartDevice.label)
      } else {
        smartError = 'The cable did not answer. Unplug the signer, plug it back in, then try “Connect by USB cable”.'
      }
    } catch (e) {
      smartError = e instanceof Error
        ? e.message
        : 'Could not reach it over the network: is it powered on?'
    } finally {
      connecting = false
    }
  }

  /** A phone never detours through USB detection: its remembered signer route
   * is the primary path whether the phone itself uses Wi-Fi or cellular. */
  async function handleRemoteSmartConnect() {
    if (!smartDevice) { openRelayForm(); return }
    smartError = ''
    connecting = true
    try {
      await connectRelay(smartDevice.pubHex, smartDevice.relays, smartDevice.label)
    } catch (e) {
      smartError = e instanceof Error
        ? e.message
        : 'Could not reach the signer over the internet.'
    } finally {
      connecting = false
    }
  }

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
      relayUrlInput = knownDevices[0].relays.join(', ') || relayUrlInput
    }
    relayError = ''
    showRelayForm = true
  }

  function pickKnown(e: Event) {
    const hex = (e.target as HTMLSelectElement).value
    const d = knownDevices.find((k) => k.pubHex === hex)
    if (d) { relayPubInput = nip19.npubEncode(d.pubHex); relayUrlInput = d.relays.join(', ') || relayUrlInput }
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
        relayError = "That doesn't look like a device: use its npub1… address or a name like you@example.com."
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
  // auto-connect to the same origin. A co-hosted bridge lives on the LAN, never on
  // a public HTTPS site, so only LAN-ish / http origins are probed. A static host
  // (GitHub Pages, sapwood.forgesworn.dev) and localhost dev are skipped outright,
  // sparing them two dead /api/info 404s on every load that only clutter the
  // console — and mislead anyone debugging a connection there.
  $effect(() => {
    if (device.connected || connecting) return
    const { origin, protocol, hostname } = window.location
    if (!origin.startsWith('http')) return
    const isLoopback = hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]'
    const isLan = hostname.endsWith('.local')
      || /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(hostname)
    if (isLoopback) return
    if (protocol === 'https:' && !isLan) return
    void (async () => {
      try {
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
        {device.mode === 'serial' ? 'USB' : device.mode === 'relay' ? 'REMOTE' : 'BRIDGE'} · {device.portInfo}
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
        <h3 class="section-title relay-title">Connect remotely</h3>
        <p class="hint relay-lead">
          Your signer can be in another country. Enter its public address and internet relays,
          or scan the protected pairing QR shown by a browser that already manages it.
        </p>
        <form class="relay-form" onsubmit={(e) => { e.preventDefault(); handleConnectRelay() }}>
          {#if knownDevices.length}
            <div class="field">
              <label class="field-label" for="known-device">A device you've used before</label>
              <select
                id="known-device"
                class="field-input"
                onchange={pickKnown}
                disabled={connecting}
                aria-describedby="known-device-hint"
              >
                {#each knownDevices as d (d.pubHex)}
                  <option value={d.pubHex}>{d.label}</option>
                {/each}
              </select>
              <span id="known-device-hint" class="field-hint">Pick one to fill in both boxes, or type a new device below.</span>
            </div>
          {/if}

          <div class="field">
            <label class="field-label" for="relay-pub-input">1 · Your device's address</label>
            <input
              id="relay-pub-input"
              class="field-input"
              type="text"
              bind:value={relayPubInput}
              placeholder="npub1… or you@example.com"
              disabled={connecting}
              aria-describedby="relay-pub-hint"
              autocapitalize="off"
              autocorrect="off"
              spellcheck="false"
            />
            <span id="relay-pub-hint" class="field-hint">
              Its <code>npub1…</code> address, or a name like <code>you@example.com</code> if it has
              one, both are safe to share. You chose this when setting the device up, so if that was
              on this computer it's already filled in.
            </span>
          </div>

          <div class="field">
            <label class="field-label" for="relay-url-input">2 · The relays it uses</label>
            <input
              id="relay-url-input"
              class="field-input"
              type="text"
              bind:value={relayUrlInput}
              placeholder="wss://relay.trotters.cc, wss://nos.lol"
              disabled={connecting}
              aria-describedby="relay-url-hint"
              autocapitalize="off"
              autocorrect="off"
              spellcheck="false"
            />
            <span id="relay-url-hint" class="field-hint">
              A relay is a shared postbox on the internet: your browser drops off a message and the
              device picks it up. Use every relay you configured during setup; commas or new lines are fine.
            </span>
          </div>

          {#if relayError}<p class="error-text error">{relayError}</p>{/if}

          <div class="relay-actions">
            <button type="submit" class="btn btn-primary" disabled={connecting || !relayPubInput.trim()}>
              {connecting ? 'Connecting…' : 'Connect remotely'}
            </button>
            <button type="button" class="btn btn-ghost" onclick={() => showRelayForm = false}>
              Cancel
            </button>
          </div>
        </form>
      </div>
    {:else if mobile}
      <section class="mobile-remote" aria-labelledby="mobile-remote-title">
        <h2 id="mobile-remote-title">Manage your signer remotely</h2>
        <p>
          Your signer can stay powered on anywhere. This phone reaches it through internet
          relays over Wi-Fi or cellular.
        </p>
        {#if smartDevice}
          <button class="btn btn-primary btn-block btn-setup" onclick={handleRemoteSmartConnect} disabled={connecting}>
            {connecting ? 'Connecting…' : `Connect to “${smartDevice.label}” →`}
          </button>
          <button class="btn btn-ghost btn-block mobile-another" onclick={openRelayForm} disabled={connecting}>
            Connect another signer
          </button>
        {:else}
          <button class="btn btn-primary btn-block btn-setup" onclick={openRelayForm} disabled={connecting}>
            Connect remotely →
          </button>
        {/if}
        {#if smartError}<p class="warn-text notice">{smartError}</p>{/if}
      </section>
    {:else if justFlashed}
      <div class="card card--raised card--live finish-setup">
        <h3 class="finish-title">✓ Flashed: now let's finish your signer</h3>
        <p class="finish-lead">
          Tap to connect to your new signer, then we'll name it and make its keys.
          <br /><strong>If it isn't found, press the RESET button on the board first</strong> (it needs a
          restart to start the new firmware), then tap again.
        </p>
        <button
          class="btn btn-primary btn-block finish-btn"
          onclick={handleConnectSerial}
          disabled={connecting || !canUseUsb}
        >
          {connecting ? 'Connecting…' : 'Connect to my new signer →'}
        </button>
        {#if !canUseUsb}
          <p class="warn-text notice">This needs Chrome or Edge on a computer: it talks over the USB cable.</p>
        {/if}
        <button class="btn btn-ghost finish-other" onclick={clearJustFlashed}>
          Connect a different way
        </button>
        <button class="btn btn-ghost finish-other" onclick={() => navigate('flash')}>
          Set up another device
        </button>
      </div>
    {:else if !showHttpForm}
      {#if attachedPort || smartDevice}
        <!-- Reconnecting is the one thing you're most likely here to do, so it's
             the single primary action — over the cable when one is detected,
             else over the last-used signer's relay. -->
        <button class="btn btn-primary btn-block btn-setup" onclick={handleSmartConnect} disabled={connecting}>
          {connecting ? 'Connecting…'
            : attachedPort ? 'Connect to my signer →'
            : `Connect to “${smartDevice!.label}” →`}
        </button>
        {#if attachedPort}
          <p class="hint-sm smart-sub">Found a signer on the USB cable. This connects straight to it.</p>
        {/if}
        {#if smartError}<p class="warn-text notice">{smartError}</p>{/if}
        <p class="hint connect-hint">Using a cable, another signer, or setting up a new one:</p>
      {:else}
        {#if canUseUsb}
          <button class="btn btn-primary btn-block btn-setup" onclick={() => navigate('flash')}>
            Set up a new device →
          </button>
          <p class="hint-sm setup-sub">
            Needs Chrome or Edge on a computer, your Heartwood, and a USB data cable.
          </p>
          <p class="hint connect-hint">Already have one? Connect to manage it:</p>
        {:else}
          <button class="btn btn-primary btn-block btn-setup" onclick={openRelayForm}>
            Connect by signer address →
          </button>
          <p class="hint-sm setup-sub">
            This browser cannot talk to USB devices. Manage an existing WiFi signer by address,
            or set up a new one from Chrome or Edge on a computer.
          </p>
          <p class="hint connect-hint">Other options:</p>
        {/if}
      {/if}
      <div class="connect-buttons">
        {#if canUseUsb}
          <button
            class="btn btn-secondary"
            onclick={handleConnectSerial}
            disabled={connecting}
          >
            {connecting ? 'Connecting...' : 'Connect by USB cable'}
          </button>
          <button class="btn btn-secondary" onclick={openRelayForm} disabled={connecting}>
            Connect by signer address
          </button>
        {:else}
          <button class="btn btn-secondary" onclick={() => navigate('flash')} disabled={connecting}>
            Setup instructions
          </button>
        {/if}
        {#if canUseUsb && (attachedPort || smartDevice)}
          <button class="btn btn-secondary" onclick={() => navigate('flash')} disabled={connecting}>
            Set up a new device
          </button>
        {/if}
      </div>
      {#if !canUseUsb}
        <p class="warn-text notice">USB setup and USB management need Chrome or Edge on a computer.</p>
      {/if}
      <details class="disclosure more-ways">
        <summary>Other ways to connect</summary>
        <button class="btn btn-secondary more-ways-btn" onclick={() => showHttpForm = true} disabled={connecting}>
          Connect to local bridge
        </button>
        <p class="hint-sm more-ways-note">For a bridge daemon running on your LAN (advanced).</p>
      </details>
    {:else}
      <form class="http-form" onsubmit={(e) => { e.preventDefault(); handleConnectHttp() }}>
        <label class="field-label" for="bridge-address">Local bridge address</label>
        <input
          id="bridge-address"
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

  .mobile-remote {
    padding: 0.35rem 0 0.2rem;
  }
  .mobile-remote h2 {
    margin: 0 0 0.55rem;
    font-size: 1.05rem;
  }
  .mobile-remote p {
    margin: 0 0 1rem;
    color: var(--text-muted);
    line-height: 1.55;
  }
  .mobile-another { margin-top: 0.55rem; }

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

  .setup-sub { margin-top: 0.7rem; text-align: center; }
  .connect-hint { margin: 1.5rem 0 0.6rem; }

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
