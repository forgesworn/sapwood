<script lang="ts">
  // The admin Home — the warm, guided surface you land on once connected.
  // Shows your signer in plain language, makes "connect an app" the obvious
  // next step, lists what is connected, and offers the phone handoff. The full
  // 9-tab cockpit is one tap away via `onadvanced` (the Advanced toggle).
  import {
    device, refreshSlots, refreshMasters, disconnect, connectSerial, connectRelay,
    mgmtRevokeClient, mgmtApproveSigning, mgmtCanApproveSigning,
  } from '../lib/device.svelte.js'
  import {
    npubShort, npubToHex, getDeviceLabel, setDeviceLabel,
    listKnownDevices, type KnownDevice,
  } from '../lib/known-devices.js'
  import ConnectApp from './ConnectApp.svelte'
  import FirstIdentity from './FirstIdentity.svelte'
  import PhoneHandoff from './PhoneHandoff.svelte'

  interface Props {
    /** Switch to the advanced cockpit. */
    onadvanced?: () => void
  }
  let { onadvanced }: Props = $props()

  // A brand-new device (just flashed) has no master until it's provisioned.
  // Until then the signer has no identity, so Home leads with the guided setup.
  const hasIdentity = $derived(device.masters.length > 0)
  const master = $derived(device.masters[0] ?? null)
  const pubHex = $derived(master ? npubToHex(master.npub) : null)
  const address = $derived(pubHex ? npubShort(pubHex) : (master?.npub ?? ''))
  const canApprove = $derived(mgmtCanApproveSigning())

  // How this signer is reached, in plain words — folded into the signer card so
  // Home shows one connection panel, not two.
  const transportLabel = $derived(
    device.mode === 'serial' ? 'USB cable' : device.mode === 'relay' ? 'WiFi' : 'a bridge',
  )

  // Friendly name: a saved label wins; otherwise a gentle default.
  let customLabel = $state<string | null>(null)
  let editing = $state(false)
  let nameInput = $state('')
  let busySlot = $state<number | null>(null)
  // Which app card is asking to confirm a disconnect (inline, not a native dialog).
  let confirmingSlot = $state<number | null>(null)

  // Re-read the saved label whenever the connected device changes.
  $effect(() => {
    customLabel = pubHex ? getDeviceLabel(pubHex) : null
  })
  const displayName = $derived(customLabel ?? 'Your signer')

  // Keep the connected-apps list fresh (relay/http also poll in device state).
  $effect(() => { if (device.connected) refreshSlots() })

  function startRename() {
    nameInput = customLabel ?? ''
    editing = true
  }
  function saveRename() {
    if (pubHex && nameInput.trim()) {
      setDeviceLabel(pubHex, nameInput)
      customLabel = nameInput.trim()
    }
    editing = false
  }

  async function approve(slotIndex: number) {
    busySlot = slotIndex
    try { await mgmtApproveSigning(slotIndex) }
    catch (e) { device.error = e instanceof Error ? e.message : 'Approve failed' }
    finally { busySlot = null }
  }

  async function revoke(slotIndex: number) {
    confirmingSlot = null
    busySlot = slotIndex
    try { await mgmtRevokeClient(slotIndex) }
    catch (e) { device.error = e instanceof Error ? e.message : 'Disconnect failed' }
    finally { busySlot = null }
  }

  // One-click recovery from a USB hiccup (e.g. after pressing RESET): re-pick the
  // port. connectSerial requests the port first, so this single click carries the
  // user gesture Chrome needs.
  let reconnecting = $state(false)
  async function reconnect() {
    reconnecting = true
    try { await connectSerial() }
    finally { reconnecting = false }
  }

  // --- Signer silent on USB ---
  // Since firmware v0.9.10 a WiFi signer answers the cable in every mode, so
  // device.usbSilent now means older WiFi firmware (whose relay loop ignored
  // USB), a device still mid-boot, or a port that isn't a signer at all. We
  // remember WiFi devices (npub + relays) from when they were provisioned, so
  // we can offer a one-click hop to WiFi management. localStorage isn't
  // reactive, so read it once here.
  const knownWifi = $derived(listKnownDevices().filter((d) => d.relays.length))
  let wifiBusy = $state(false)
  let wifiErr = $state('')
  async function manageOverWifi(d: KnownDevice) {
    wifiBusy = true
    wifiErr = ''
    try {
      await connectRelay(d.pubHex, d.relays, d.label)
    } catch (e) {
      wifiErr = e instanceof Error ? e.message
        : 'Could not reach it over WiFi yet — give it ~10s to join the network, then retry.'
    } finally {
      wifiBusy = false
    }
  }
</script>

<div class="home">
  {#if device.error}
    <div class="home-error" role="status">
      <span class="home-error-msg">⚠ {device.error}</span>
      {#if device.mode === 'serial' && 'serial' in navigator}
        <button class="home-error-reconnect" onclick={reconnect} disabled={reconnecting}>
          {reconnecting ? 'Reconnecting…' : 'Reconnect'}
        </button>
      {/if}
    </div>
  {/if}

  {#if device.mode === 'serial' && device.usbProbing && !hasIdentity}
    <!-- Just connected over USB; find out if the device actually answers before
         deciding what to show (older WiFi firmware won't, and we must not offer
         it a create flow that can only time out). -->
    <section class="checking">
      <span class="checking-spin"></span>
      <div>
        <h2 class="checking-title">Checking your signer…</h2>
        <p class="checking-body">Talking to the device over the cable. If it was just reset,
          it may take a few seconds to start up.</p>
      </div>
    </section>

  {:else if device.mode === 'serial' && device.usbSilent && !hasIdentity}
    <!-- Connected at the port level but no frames come back. Current firmware
         (v0.9.10+) answers USB in every mode, so this is older WiFi firmware
         ignoring the cable, a device still booting, or not a signer. Offer every
         way out: retry, hop to WiFi, and the old-firmware PRG hatch. -->
    <section class="wifi-usb">
      <h2 class="wifi-usb-title">This signer isn't answering over the cable</h2>
      <p class="wifi-usb-body">
        It connected, but nothing came back. If it was just plugged in or reset, give it a few
        seconds and retry. If it's a WiFi signer on older firmware, it ignores the cable while
        serving WiFi — manage it over the network instead.
      </p>

      <button class="btn-reconnect-inline" onclick={reconnect} disabled={reconnecting}>
        {reconnecting ? 'Retrying…' : 'Retry over USB'}
      </button>

      {#if knownWifi.length}
        <div class="wifi-usb-known">
          {#each knownWifi as d (d.pubHex)}
            <button class="btn-wifi" disabled={wifiBusy} onclick={() => manageOverWifi(d)}>
              {wifiBusy ? 'Connecting…' : `Manage “${d.label}” over WiFi`}
            </button>
          {/each}
        </div>
        {#if wifiErr}<p class="wifi-usb-err">{wifiErr}</p>{/if}
      {:else}
        <p class="wifi-usb-body">
          To reach a WiFi signer: disconnect, choose <strong>“Connect over your network”</strong>,
          and enter the signer's <code>npub1…</code> address (shown on its screen) and relay.
        </p>
        <button class="btn-wifi" onclick={() => disconnect()}>Disconnect and connect over WiFi</button>
      {/if}

      <details class="wifi-usb-more">
        <summary>On older firmware and need the cable?</summary>
        <p>
          Firmware v0.9.10 and newer always answers the cable, so a signer that's up to date just
          needs the retry above. On older WiFi firmware, press <strong>RESET</strong> on the board
          and watch the screen — if it offers <strong>“Hold PRG = USB”</strong>, press and hold the
          other button (<strong>PRG</strong>) for ~3 seconds until it says <strong>“USB mode”</strong>,
          reconnect here, then update its firmware so this step isn't needed again.
        </p>
      </details>

      <button class="wifi-usb-disconnect" onclick={() => disconnect()}>Disconnect</button>
    </section>

  {:else if !hasIdentity}
    <!-- No master yet — the just-flashed first-run state. Lead with setup. A slim
         connection line stands in for the signer card (there's no identity yet). -->
    <div class="conn-line">
      <span class="conn-dot"></span>
      <span class="conn-text">Connected over {transportLabel}</span>
      <button class="conn-disconnect" onclick={() => disconnect()}>Disconnect</button>
    </div>
    {#if device.mode === 'serial'}
      <FirstIdentity onadvanced={() => onadvanced?.()} ondone={() => refreshMasters()} />
    {:else}
      <section class="needs-usb">
        <h2 class="needs-usb-title">This signer needs an identity</h2>
        <p class="needs-usb-body">
          It doesn't have one yet. Creating it hands over the master key, so it only happens down a
          cable you can hold — never over the network. Plug the device into a computer with a USB
          cable, connect over USB, and the setup step appears here.
        </p>
      </section>
    {/if}
  {:else}
  <!-- Your signer -->
  <section class="signer">
    <span class="live-dot"></span>
    <div class="signer-body">
      <p class="signer-lead">Your signer is live</p>
      {#if editing}
        <div class="rename">
          <input
            class="rename-input"
            bind:value={nameInput}
            placeholder="Name this signer"
            maxlength="48"
            onkeydown={(e) => { if (e.key === 'Enter') saveRename(); if (e.key === 'Escape') editing = false }}
          />
          <button class="link-btn" onclick={saveRename}>Save</button>
        </div>
      {:else}
        <h2 class="signer-name">
          {displayName}
          {#if pubHex}<button class="rename-pencil" title="Rename" aria-label="Rename signer" onclick={startRename}>✎</button>{/if}
        </h2>
      {/if}
      {#if address}
        <p class="signer-addr"><span class="addr-tag">address</span>{address}</p>
        <p class="signer-hint">This is your signer's public address — safe to share.</p>
      {/if}
      <div class="signer-foot">
        <span class="signer-conn">Connected over {transportLabel}</span>
        <button class="signer-disconnect" onclick={() => disconnect()}>Disconnect</button>
      </div>
    </div>
  </section>

  <!-- The one thing most people come here to do -->
  <ConnectApp ondone={() => refreshSlots()} />

  <!-- What is connected -->
  <section class="apps">
    <div class="apps-head">
      <h3 class="apps-title">Connected apps</h3>
      {#if device.slots.length > 0}
        <span class="apps-count">{device.slots.length}</span>
      {/if}
    </div>

    {#if device.slots.length === 0}
      <p class="apps-empty">No apps connected yet. Use “Connect an app” above to add your first.</p>
    {:else}
      {#each device.slots as slot (slot.slot_index)}
        <div class="app-card">
          <div class="app-info">
            <span class="app-name">{slot.label || `app ${slot.slot_index}`}</span>
            <span class="app-state">
              {#if !slot.current_pubkey}
                waiting to connect
              {:else if slot.signing_approved}
                can sign
              {:else}
                connected · not yet allowed to sign
              {/if}
            </span>
          </div>
          <div class="app-actions">
            {#if confirmingSlot === slot.slot_index}
              <span class="confirm-q">Disconnect this app?</span>
              <button class="btn-revoke confirm-yes" disabled={busySlot === slot.slot_index} onclick={() => revoke(slot.slot_index)}>
                {busySlot === slot.slot_index ? 'Disconnecting…' : 'Yes, disconnect'}
              </button>
              <button class="link-btn" onclick={() => (confirmingSlot = null)}>Cancel</button>
            {:else}
              {#if slot.current_pubkey && !slot.signing_approved && canApprove}
                <button class="btn-allow" disabled={busySlot === slot.slot_index} onclick={() => approve(slot.slot_index)}>
                  {busySlot === slot.slot_index ? 'Allowing…' : 'Allow signing'}
                </button>
              {/if}
              <button class="btn-revoke" onclick={() => (confirmingSlot = slot.slot_index)}>
                Disconnect
              </button>
            {/if}
          </div>
        </div>
      {/each}
      <button class="link-btn manage-link" onclick={() => onadvanced?.()}>
        Fine-tune what each app can sign in Advanced →
      </button>
    {/if}
  </section>

  <!-- Manage from your phone -->
  <PhoneHandoff />
  {/if}

  <!-- Footer: the escape hatch + the safety net -->
  <section class="footer">
    <button class="footer-link" onclick={() => onadvanced?.()}>Advanced ⚙ — every setting and tool</button>
    <p class="footer-note">
      This browser holds the key that lets you manage this signer. Make a backup so you
      do not get locked out — under
      <button class="inline-link" onclick={() => onadvanced?.()}>Advanced › Settings</button>.
    </p>
  </section>
</div>

<style>
  .home { display: flex; flex-direction: column; gap: 1.6rem; }

  .home-error {
    margin: 0;
    padding: 0.6rem 0.9rem;
    font-size: 0.85rem;
    color: var(--amber);
    background: #160c0a;
    border: 1px solid #3a2320;
    border-radius: 6px;
    display: flex;
    align-items: center;
    gap: 0.75rem;
  }
  .home-error-msg { flex: 1; word-break: break-word; }
  .home-error-reconnect {
    flex-shrink: 0;
    background: #2a1a08; border: 1px solid var(--amber); color: var(--amber);
    border-radius: 4px; padding: 0.35rem 0.9rem; font-family: inherit; font-size: 0.82rem;
    font-weight: 600; cursor: pointer;
  }
  .home-error-reconnect:hover:not(:disabled) { background: #3a2410; }
  .home-error-reconnect:disabled { opacity: 0.5; cursor: not-allowed; }

  .needs-usb {
    background: #120f06;
    border: 1px solid #3a3320;
    border-radius: 8px;
    padding: 1.4rem;
  }
  .needs-usb-title { font-size: 1.2rem; font-weight: 700; color: #cba24a; margin: 0 0 0.6rem; }
  .needs-usb-body { font-size: 0.9rem; color: var(--text-dim); line-height: 1.6; margin: 0; }

  /* USB connect: still checking whether the device answers. */
  .checking {
    display: flex; align-items: center; gap: 1rem;
    background: var(--surface-raised); border: 1px solid var(--border-bright);
    border-radius: 8px; padding: 1.3rem 1.4rem;
  }
  .checking-spin {
    width: 22px; height: 22px; flex-shrink: 0; border-radius: 50%;
    border: 3px solid var(--border-bright); border-top-color: var(--green);
    animation: spin 0.8s linear infinite;
  }
  @keyframes spin { to { transform: rotate(360deg); } }
  .checking-title { font-size: 1.1rem; font-weight: 700; color: #fff; margin: 0 0 0.3rem; }
  .checking-body { font-size: 0.88rem; color: var(--text-dim); line-height: 1.55; margin: 0; }

  /* A provisioned WiFi signer plugged into USB — won't answer the cable. */
  .wifi-usb {
    background: #06120e; border: 1px solid var(--green-dim);
    border-radius: 8px; padding: 1.4rem;
  }
  .wifi-usb-title { font-size: 1.2rem; font-weight: 700; color: #fff; margin: 0 0 0.6rem; }
  .wifi-usb-body { font-size: 0.9rem; color: var(--text-dim); line-height: 1.6; margin: 0 0 1rem; }
  .wifi-usb-body strong { color: var(--text); }
  .wifi-usb-body code {
    color: var(--green-dim); background: #0a0a0a; padding: 0.05rem 0.3rem; border-radius: 3px;
  }
  .wifi-usb-known { display: flex; flex-direction: column; gap: 0.6rem; margin-bottom: 0.5rem; }
  .btn-wifi {
    background: var(--green); color: #050505; border: 1px solid var(--green); font-weight: 600;
    font-family: inherit; font-size: 0.95rem; padding: 0.75rem 1.2rem; border-radius: 5px; cursor: pointer;
  }
  .btn-wifi:hover:not(:disabled) { background: #00ff88; box-shadow: var(--green-glow); }
  .btn-wifi:disabled { opacity: 0.5; cursor: not-allowed; }
  .wifi-usb-err { font-size: 0.85rem; color: var(--amber); margin: 0.6rem 0 0; line-height: 1.5; }

  .wifi-usb-more { margin-top: 1.1rem; }
  .wifi-usb-more summary {
    cursor: pointer; font-size: 0.85rem; color: var(--text-dim); padding: 0.2rem 0;
  }
  .wifi-usb-more summary:hover { color: var(--text); }
  .wifi-usb-more p { font-size: 0.85rem; color: var(--text-dim); line-height: 1.6; margin: 0.6rem 0 0.8rem; }
  .wifi-usb-more strong { color: var(--text); }
  .btn-reconnect-inline {
    background: #2a1a08; border: 1px solid var(--amber); color: var(--amber);
    border-radius: 4px; padding: 0.45rem 1rem; font-family: inherit; font-size: 0.85rem;
    font-weight: 600; cursor: pointer;
  }
  .btn-reconnect-inline:hover:not(:disabled) { background: #3a2410; }
  .btn-reconnect-inline:disabled { opacity: 0.5; cursor: not-allowed; }
  .wifi-usb-disconnect {
    display: block; margin-top: 1.2rem; background: none; border: 1px solid #442222;
    color: var(--red); cursor: pointer; font-family: inherit; font-size: 0.8rem;
    padding: 0.4rem 0.9rem; border-radius: 4px;
  }
  .wifi-usb-disconnect:hover { background: #1a0808; }

  .signer {
    display: flex;
    align-items: flex-start;
    gap: 0.85rem;
    background: #06120e;
    border: 1px solid var(--green-dim);
    border-radius: 8px;
    padding: 1.2rem 1.4rem;
  }
  .live-dot {
    width: 11px; height: 11px; border-radius: 50%; flex-shrink: 0; margin-top: 0.45rem;
    background: var(--green); box-shadow: var(--green-glow);
    animation: pulse 2.4s ease-in-out infinite;
  }
  @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.45; } }
  .signer-body { min-width: 0; flex: 1; }
  .signer-lead { font-size: 0.78rem; letter-spacing: 0.12em; text-transform: uppercase; color: var(--green-dim); margin: 0 0 0.2rem; }
  .signer-name { font-size: 1.4rem; font-weight: 700; color: #fff; margin: 0; display: flex; align-items: center; gap: 0.5rem; }
  .signer-addr { font-size: 0.82rem; color: var(--text-dim); margin: 0.4rem 0 0; word-break: break-all; }
  .addr-tag {
    display: inline-block; font-size: 0.62rem; letter-spacing: 0.1em; text-transform: uppercase;
    color: var(--text-muted); border: 1px solid var(--border-bright); border-radius: 3px;
    padding: 0.05rem 0.35rem; margin-right: 0.5rem; vertical-align: middle;
  }
  .signer-hint { font-size: 0.75rem; color: var(--text-muted); margin: 0.3rem 0 0; }
  .signer-foot {
    display: flex; align-items: center; justify-content: space-between; gap: 1rem;
    margin-top: 0.9rem; padding-top: 0.8rem; border-top: 1px solid #0e2c1f;
  }
  .signer-conn { font-size: 0.78rem; color: var(--text-dim); }
  .signer-disconnect {
    background: none; border: 1px solid #442222; color: var(--red); cursor: pointer;
    font-family: inherit; font-size: 0.78rem; padding: 0.3rem 0.8rem; border-radius: 4px; flex-shrink: 0;
  }
  .signer-disconnect:hover { background: #1a0808; }

  /* The no-identity stand-in for the signer card. */
  .conn-line { display: flex; align-items: center; gap: 0.6rem; padding: 0.2rem 0.1rem; }
  .conn-dot {
    width: 9px; height: 9px; border-radius: 50%; flex-shrink: 0;
    background: var(--green); box-shadow: var(--green-glow);
  }
  .conn-text { font-size: 0.82rem; color: var(--text-dim); flex: 1; }
  .conn-disconnect {
    background: none; border: 1px solid #442222; color: var(--red); cursor: pointer;
    font-family: inherit; font-size: 0.78rem; padding: 0.3rem 0.8rem; border-radius: 4px;
  }
  .conn-disconnect:hover { background: #1a0808; }

  .confirm-q { font-size: 0.8rem; color: var(--text-dim); }
  .confirm-yes { border: 1px solid #442222; border-radius: 4px; padding: 0.35rem 0.7rem; }

  .rename-pencil {
    background: none; border: none; color: var(--text-muted); cursor: pointer;
    font-size: 0.9rem; padding: 0.1rem 0.3rem; border-radius: 3px;
  }
  .rename-pencil:hover { color: var(--green); }
  .rename { display: flex; gap: 0.5rem; align-items: center; }
  .rename-input {
    background: #0e0e0e; border: 1px solid var(--green-dim); color: #fff;
    padding: 0.4rem 0.6rem; border-radius: 4px; font-family: inherit; font-size: 1.1rem; flex: 1; min-width: 0;
  }
  .rename-input:focus { outline: none; border-color: var(--green); }

  .link-btn {
    background: none; border: none; color: var(--green-dim); cursor: pointer;
    font-family: inherit; font-size: 0.85rem; padding: 0.2rem 0.3rem;
  }
  .link-btn:hover { color: var(--green); }

  .apps-head { display: flex; align-items: center; gap: 0.6rem; margin-bottom: 0.8rem; }
  .apps-title { font-size: 1.05rem; font-weight: 600; color: #fff; margin: 0; }
  .apps-count {
    font-size: 0.72rem; font-weight: 600; color: var(--green); background: #08130d;
    border: 1px solid var(--green-dim); border-radius: 999px; padding: 0.05rem 0.5rem;
  }
  .apps-empty { font-size: 0.88rem; color: var(--text-muted); margin: 0; line-height: 1.5; }

  .app-card {
    display: flex; align-items: center; justify-content: space-between; gap: 1rem;
    background: var(--surface); border: 1px solid var(--border); border-radius: 6px;
    padding: 0.85rem 1.1rem; margin-bottom: 0.5rem;
  }
  .app-info { display: flex; flex-direction: column; gap: 0.2rem; min-width: 0; }
  .app-name { font-size: 0.98rem; font-weight: 600; color: #fff; }
  .app-state { font-size: 0.78rem; color: var(--text-muted); }
  .app-actions { display: flex; gap: 0.4rem; flex-shrink: 0; align-items: center; }

  .btn-allow {
    background: #001a0a; border: 1px solid var(--green-dim); color: var(--green);
    border-radius: 4px; padding: 0.35rem 0.85rem; font-family: inherit; font-size: 0.8rem;
    font-weight: 600; cursor: pointer; transition: all 0.12s;
  }
  .btn-allow:hover:not(:disabled) { background: #002a12; border-color: var(--green); }
  .btn-allow:disabled { opacity: 0.5; cursor: not-allowed; }

  .btn-revoke {
    background: none; border: none; color: var(--red); font-family: inherit;
    font-size: 0.8rem; cursor: pointer; padding: 0.35rem 0.6rem; border-radius: 4px;
  }
  .btn-revoke:hover:not(:disabled) { background: #1a0808; }
  .btn-revoke:disabled { opacity: 0.5; cursor: not-allowed; }

  .manage-link { margin-top: 0.4rem; display: inline-block; }

  .footer { border-top: 1px solid var(--border); padding-top: 1.2rem; }
  .footer-link {
    background: none; border: none; color: var(--text-dim); cursor: pointer;
    font-family: inherit; font-size: 0.9rem; padding: 0;
  }
  .footer-link:hover { color: #fff; }
  .footer-note { font-size: 0.78rem; color: var(--text-muted); margin: 0.6rem 0 0; line-height: 1.5; }
  .inline-link {
    background: none; border: none; color: var(--green-dim); cursor: pointer;
    font-family: inherit; font-size: inherit; padding: 0; text-decoration: underline;
  }
  .inline-link:hover { color: var(--green); }

  @media (max-width: 640px) {
    .app-card { flex-wrap: wrap; }
    .app-actions { width: 100%; justify-content: flex-end; }
  }
</style>
