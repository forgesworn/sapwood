<script lang="ts">
  // The admin Home — the warm, guided surface you land on once connected.
  // Shows your signer in plain language, makes "connect an app" the obvious
  // next step, lists what is connected (with per-app signing permissions
  // inline), nudges the two safety jobs that matter — back up the operator
  // key, update old firmware — and offers the phone handoff. The advanced
  // console is one tap away via `onadvanced`.
  import {
    device, refreshSlots, refreshMasters, disconnect, connectSerial, connectRelay, reconnectRelay,
    mgmtRevokeClient, mgmtApproveSigning, mgmtUpdateClient, mgmtCanApproveSigning,
    mgmtClientUri, getFirmwareVersion,
  } from '../lib/device.svelte.js'
  import { copyText } from '../lib/clipboard.js'
  import {
    npubShort, npubToHex, getDeviceLabel, setDeviceLabel,
    listKnownDevices, type KnownDevice,
  } from '../lib/known-devices.js'
  import {
    getOperatorMnemonic, getOrCreateOperator, isOperatorBackedUp, markOperatorBackedUp,
  } from '../lib/op-mgmt.js'
  import { DEFAULT_SIGNER_RELAYS } from '../lib/wizard.js'
  import ConnectApp from './ConnectApp.svelte'
  import FirstIdentity from './FirstIdentity.svelte'
  import PhoneHandoff from './PhoneHandoff.svelte'
  import KindPermissions from './KindPermissions.svelte'
  import ConfirmButton from './ConfirmButton.svelte'

  type AdvancedTab = 'apps' | 'identity' | 'device' | 'logs'
  interface Props {
    /** Switch to the advanced console, optionally on a specific tab. */
    onadvanced?: (tab?: AdvancedTab) => void
  }
  let { onadvanced }: Props = $props()

  // A brand-new device (just flashed) has no identity until it's set up.
  // Until then, Home leads with the guided setup.
  const hasIdentity = $derived(device.masters.length > 0)
  const master = $derived(device.masters[0] ?? null)
  const pubHex = $derived(master ? npubToHex(master.npub) : null)
  const address = $derived(pubHex ? npubShort(pubHex) : (master?.npub ?? ''))
  const canApprove = $derived(mgmtCanApproveSigning())
  // The mgmt layer speaks USB and WiFi; over a bridge, editing happens in Advanced.
  const canManageInline = $derived(device.mode === 'serial' || device.mode === 'relay')

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
  let updatingSlot = $state<number | null>(null)

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
    busySlot = slotIndex
    try { await mgmtRevokeClient(slotIndex) }
    catch (e) { device.error = e instanceof Error ? e.message : 'Disconnect failed' }
    finally { busySlot = null }
  }

  async function updatePermissions(slotIndex: number, kinds: number[] | null) {
    updatingSlot = slotIndex
    try { await mgmtUpdateClient(slotIndex, { allowed_kinds: kinds ?? [] }) }
    catch (e) { device.error = e instanceof Error ? e.message : 'Update failed' }
    finally { updatingSlot = null }
  }

  // Auto-approve vs ask-each-time. This is also what lets an app read messages:
  // the signer refuses decrypt for an "ask each time" app (it can't safely
  // button-gate a stream of decryptions), so a DM-reading app needs this on.
  async function setAuto(slotIndex: number, auto: boolean) {
    updatingSlot = slotIndex
    try { await mgmtUpdateClient(slotIndex, { auto_approve: auto }) }
    catch (e) { device.error = e instanceof Error ? e.message : 'Update failed' }
    finally { updatingSlot = null }
  }

  // Re-hand an app its connection link before it has connected. Over USB the
  // firmware re-issues it; over WiFi it comes from this session's cache.
  let copiedSlot = $state<number | null>(null)
  async function copyAppLink(slotIndex: number) {
    try {
      const uri = await mgmtClientUri(slotIndex)
      if (await copyText(uri)) {
        copiedSlot = slotIndex
        setTimeout(() => { if (copiedSlot === slotIndex) copiedSlot = null }, 1800)
      }
    } catch (e) {
      device.error = e instanceof Error ? e.message : 'Could not fetch the connection link.'
    }
  }

  // --- Operator-key backup nudge ---
  // The one thing that locks people out: losing this browser's operator key.
  // Shown until the user confirms they've written the phrase down; keyed to the
  // key itself, so a new key asks again. "Later" hides it for this session.
  let backupDone = $state(isOperatorBackedUp())
  let backupSnoozed = $state(false)
  let backupOpen = $state(false)
  const opMnemonic = getOperatorMnemonic()
  const showBackup = $derived(hasIdentity && !backupDone && !backupSnoozed)
  const backupWords = $derived(opMnemonic ? opMnemonic.split(/\s+/) : null)

  function confirmBackedUp() {
    markOperatorBackedUp()
    backupDone = true
  }

  // --- Firmware nudge ---
  // Over USB we can ask the board what it runs and compare with the firmware
  // bundled into this app. One quiet line when they differ; the update itself
  // lives in Advanced › Device.
  let fwRunning = $state<string | null>(null)
  let fwLatest = $state<string | null>(null)
  $effect(() => {
    if (!(device.connected && device.mode === 'serial' && hasIdentity)) return
    void (async () => {
      try {
        const res = await fetch('/firmware/version.json', { cache: 'no-store' })
        if (res.ok) fwLatest = (await res.json()).version ?? null
      } catch { /* not bundled / offline — no nudge */ }
      try { fwRunning = (await getFirmwareVersion())?.version ?? null }
      catch { /* older firmware doesn't answer — no nudge */ }
    })()
  })
  const fwUpdateAvailable = $derived(
    device.mode === 'serial' && !!fwRunning && !!fwLatest && fwRunning !== fwLatest,
  )

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
      // Cast a wider net on a flaky link: the signer's remembered relays plus the
      // standard defaults, so a single slow or dead relay isn't the only path and
      // we still share one with a signer (re)configured with the defaults.
      const relays = [...new Set([...d.relays, ...DEFAULT_SIGNER_RELAYS])]
      await connectRelay(d.pubHex, relays, d.label)
    } catch (e) {
      wifiErr = e instanceof Error ? e.message
        : 'Could not reach it over the network yet: give it ~10s to join, then retry.'
    } finally {
      wifiBusy = false
    }
  }

  // Retry a WiFi connection that reached the relay but not the signer. A timeout
  // dead-ends in that panel with no way back on to the network, so this re-runs
  // the same connection (same npub + relays) rather than making people disconnect.
  let retrying = $state(false)
  async function retryWifi() {
    retrying = true
    try { await reconnectRelay() } finally { retrying = false }
  }

  // Transport is plumbing: when the cable goes silent and exactly one signer is
  // known on the network, hop to it automatically — once per silent episode.
  // The buttons below remain as the manual retry if the hop fails.
  let autoHopTried = $state(false)
  $effect(() => {
    if (!(device.mode === 'serial' && device.usbSilent)) {
      autoHopTried = false
      return
    }
    if (autoHopTried || wifiBusy || knownWifi.length !== 1) return
    autoHopTried = true
    void manageOverWifi(knownWifi[0])
  })
</script>

<div class="home">
  {#if device.error}
    <div class="home-error" role="status">
      <span class="home-error-msg">⚠ {device.error}</span>
      {#if device.mode === 'serial' && 'serial' in navigator}
        <button class="btn btn-warn btn-sm" onclick={reconnect} disabled={reconnecting}>
          {reconnecting ? 'Reconnecting…' : 'Reconnect'}
        </button>
      {/if}
    </div>
  {/if}

  {#if device.mode === 'serial' && device.usbProbing && !hasIdentity}
    <!-- Just connected over USB; find out if the device actually answers before
         deciding what to show (older WiFi firmware won't, and we must not offer
         it a create flow that can only time out). -->
    <section class="card card--raised checking">
      <span class="checking-spin"></span>
      <div>
        <h2 class="checking-title">Checking your signer…</h2>
        <p class="hint no-gap">Talking to the device over the cable. A WiFi signer can take up to
          a minute after power-on before it answers. This finishes on its own.</p>
      </div>
    </section>

  {:else if device.mode === 'serial' && device.usbSilent && !hasIdentity}
    <!-- Connected at the port level but no frames come back: older WiFi firmware
         ignoring the cable, a device still booting, or not a signer. One primary
         action per way out; the diagnosis lives behind a disclosure. -->
    <section class="card card--live wifi-usb">
      <h2 class="state-title">This signer isn't answering over the cable</h2>
      <p class="hint">It connected, but nothing came back after a minute of trying.</p>

      <div class="state-actions">
        <button class="btn btn-warn" onclick={reconnect} disabled={reconnecting}>
          {reconnecting ? 'Retrying…' : 'Retry over USB'}
        </button>
        {#if knownWifi.length}
          {#each knownWifi as d (d.pubHex)}
            <button class="btn btn-primary" disabled={wifiBusy} onclick={() => manageOverWifi(d)}>
              {wifiBusy ? 'Connecting…' : `Reach “${d.label}” over your network`}
            </button>
          {/each}
        {:else}
          <button class="btn btn-primary" onclick={() => disconnect()}>Disconnect and connect by signer address</button>
        {/if}
      </div>
      {#if wifiErr}<p class="warn-text">{wifiErr}</p>{/if}

      <details class="disclosure">
        <summary>Why this happens</summary>
        <p class="hint-sm">A WiFi signer on older firmware ignores the cable while serving WiFi,
          so manage it over the network instead (choose <strong>“Connect by signer address”</strong>
          after disconnecting, then enter the <code>npub1…</code> shown on its screen). Otherwise,
          check the cable carries data, not just power.</p>
        <p class="hint-sm">On older firmware and need the cable? Press <strong>RESET</strong> on
          the board and watch the screen: if it offers <strong>“Hold PRG = USB”</strong>, hold
          the <strong>PRG</strong> button for ~3 seconds until it says <strong>“USB mode”</strong>,
          reconnect here, then update the firmware so this step isn't needed again.</p>
      </details>

      <button class="btn btn-danger btn-sm state-disconnect" onclick={() => disconnect()}>Disconnect</button>
    </section>

  {:else if device.mode === 'relay' && !hasIdentity && device.relayStatus === null && !device.error}
    <!-- Relay websocket is up but the device hasn't answered get_status yet.
         Never show "needs an identity" here — a wifi signer in its relay loop
         always has an identity, so an empty list only ever means "no reply yet". -->
    <section class="card card--raised checking">
      <span class="checking-spin"></span>
      <div>
        <h2 class="checking-title">Reaching your signer over WiFi…</h2>
        <p class="hint no-gap">Asking it for its status over the relay. This usually takes a few
          seconds and finishes on its own.</p>
      </div>
    </section>

  {:else if device.mode === 'relay' && !hasIdentity && device.relayStatus === null}
    <!-- The relay answered, the DEVICE never did. -->
    <section class="card card--live wifi-usb">
      <h2 class="state-title">Connected to the relay, but your signer isn't answering</h2>
      <p class="hint">If the signer has just powered on, give it ~10 seconds to join WiFi, then
        Try again. A USB cable always works: plug it into this computer and connect over USB.</p>

      <details class="disclosure">
        <summary>Why this happens</summary>
        <ul class="state-causes">
          <li><strong>Not on WiFi.</strong> The signer must join WiFi and reach a relay. If it was
            flashed with the wrong password, or a 5 GHz network (the ESP32 is 2.4 GHz only), it
            never connects. Check the Logs over USB.</li>
          <li><strong>Different relays.</strong> Sapwood and the signer must share a relay:
            Sapwood is asking on <code>{device.portInfo}</code>; check the signer booted onto the
            same one.</li>
          <li><strong>Operator-key mismatch.</strong> The signer only accepts management from the
            operator key set when it was flashed. If it was flashed from a different browser or
            computer, this browser's key differs and the signer ignores it silently.</li>
        </ul>
      </details>

      <div class="state-actions">
        <button class="btn btn-primary btn-sm" onclick={retryWifi} disabled={retrying}>
          {retrying ? 'Retrying…' : 'Try again'}
        </button>
        <button class="btn btn-danger btn-sm" onclick={() => disconnect()}>Disconnect</button>
      </div>
    </section>

  {:else if !hasIdentity}
    <!-- No identity yet — the just-flashed first-run state. Lead with setup. A slim
         connection line stands in for the signer card (there's no identity yet). -->
    <div class="conn-line">
      <span class="conn-dot"></span>
      <span class="conn-text">Connected over {transportLabel}</span>
      <button class="btn btn-danger btn-sm" onclick={() => disconnect()}>Disconnect</button>
    </div>
    {#if device.mode === 'serial'}
      <FirstIdentity onadvanced={() => onadvanced?.()} ondone={() => refreshMasters()} />
    {:else}
      <section class="card card--warn needs-usb">
        <h2 class="state-title amber">This signer needs an identity</h2>
        <p class="hint no-gap">
          It doesn't have one yet. Creating it hands over the master key, so it only happens down a
          cable you can hold, never over the network. Plug the device into a computer with a USB
          cable, connect over USB, and the setup step appears here.
        </p>
      </section>
    {/if}
  {:else}
  <!-- Your signer -->
  <section class="card card--live signer">
    <span class="live-dot"></span>
    <div class="signer-body">
      <p class="signer-lead">Your signer is live</p>
      {#if editing}
        <div class="rename">
          <input
            class="field-input rename-input"
            bind:value={nameInput}
            placeholder="Name this signer"
            maxlength="48"
            onkeydown={(e) => { if (e.key === 'Enter') saveRename(); if (e.key === 'Escape') editing = false }}
          />
          <button class="btn-link" onclick={saveRename}>Save</button>
        </div>
      {:else}
        <h2 class="signer-name">
          {displayName}
          {#if pubHex}<button class="rename-pencil" title="Rename" aria-label="Rename signer" onclick={startRename}>✎</button>{/if}
        </h2>
      {/if}
      {#if address}
        <p class="signer-addr"><span class="addr-tag">address</span>{address}</p>
        <p class="signer-hint">This is your signer's public address, safe to share.</p>
      {/if}
      <div class="signer-foot">
        <span class="signer-conn">Connected over {transportLabel}</span>
        <button class="btn btn-danger btn-sm" onclick={() => disconnect()}>Disconnect</button>
      </div>
    </div>
  </section>

  <!-- Back up the operator key — the one thing that locks people out -->
  {#if showBackup}
    <section class="card card--warn backup">
      <div class="backup-head">
        <h3 class="backup-title">Back up your operator key</h3>
        <button class="btn-link backup-later" onclick={() => (backupSnoozed = true)}>Later</button>
      </div>
      <p class="hint">
        This browser holds the key that manages this signer. If the browser's storage is lost,
        so is your access: {opMnemonic ? 'write these words down once' : 'store this secret once'}
        and keep them somewhere safe. You can see it again any time under
        Identity › Operator key in the Advanced console.
      </p>
      {#if !backupOpen}
        <button class="btn btn-warn" onclick={() => (backupOpen = true)}>
          {opMnemonic ? 'Show my recovery phrase' : 'Show my operator secret'}
        </button>
      {:else}
        {#if backupWords}
          <ol class="backup-words">
            {#each backupWords as word, i (i)}
              <li><span class="word-n">{i + 1}</span>{word}</li>
            {/each}
          </ol>
        {:else}
          <div class="uri-box"><code>{getOrCreateOperator().skHex}</code></div>
        {/if}
        <button class="btn btn-primary" onclick={confirmBackedUp}>I've written it down</button>
      {/if}
    </section>
  {/if}

  <!-- The one thing most people come here to do -->
  <ConnectApp ondone={() => refreshSlots()} />

  <!-- Firmware nudge (USB only — the cable is the only place updates happen) -->
  {#if fwUpdateAvailable}
    <div class="fw-nudge">
      <span class="fw-nudge-text">Firmware v{fwLatest} is available. Your signer runs v{fwRunning}.</span>
      <button class="btn btn-secondary btn-sm" onclick={() => onadvanced?.('device')}>Update it →</button>
    </div>
  {/if}

  <!-- What is connected -->
  <section class="apps">
    <div class="apps-head">
      <h3 class="apps-title">Connected apps</h3>
      {#if device.slots.length > 0}
        <span class="apps-count">{device.slots.length}</span>
      {/if}
    </div>

    {#if device.slots.length === 0}
      <p class="empty">No apps connected yet. Use “Connect an app” above to add your first.</p>
    {:else}
      {#each device.slots as slot (slot.slot_index)}
        <div class="card app-card">
          <div class="app-row">
            <div class="app-info">
              <span class="app-name">
                {slot.label || `app ${slot.slot_index}`}
                {#if slot.current_pubkey}
                  <span class="app-badge" class:auto={slot.signing_approved && slot.auto_approve}
                    class:ask={slot.signing_approved && !slot.auto_approve}>
                    {#if !slot.signing_approved}connected
                    {:else if slot.auto_approve}automatic
                    {:else}asks each time{/if}
                  </span>
                {:else}
                  <span class="app-badge waiting">waiting</span>
                {/if}
              </span>
              <span class="app-state">
                {#if !slot.current_pubkey}
                  Waiting for the app to connect with the link.
                {:else if !slot.signing_approved}
                  Connected, but not allowed to sign yet.
                {:else if slot.auto_approve}
                  Signs and reads for you without asking.
                {:else}
                  Prompts on the signer for each action. Can't read messages until set to automatic.
                {/if}
              </span>
            </div>
            <div class="app-actions">
              <button class="btn btn-secondary btn-sm" onclick={() => copyAppLink(slot.slot_index)}>
                {copiedSlot === slot.slot_index ? 'Link copied ✓' : 'Copy link'}
              </button>
              {#if slot.current_pubkey && !slot.signing_approved && canApprove}
                <button class="btn btn-secondary btn-sm allow" disabled={busySlot === slot.slot_index} onclick={() => approve(slot.slot_index)}>
                  {busySlot === slot.slot_index ? 'Allowing…' : 'Allow signing'}
                </button>
              {/if}
              {#if slot.current_pubkey && slot.signing_approved && canManageInline}
                <button class="btn btn-secondary btn-sm" disabled={updatingSlot === slot.slot_index}
                  onclick={() => setAuto(slot.slot_index, !slot.auto_approve)}>
                  {updatingSlot === slot.slot_index ? 'Saving…' : slot.auto_approve ? 'Ask each time' : 'Make automatic'}
                </button>
              {/if}
              <ConfirmButton
                label="Disconnect"
                question="Disconnect this app?"
                confirmLabel="Yes, disconnect"
                busyLabel="Disconnecting…"
                busy={busySlot === slot.slot_index}
                buttonClass="btn btn-danger btn-sm borderless"
                onconfirm={() => revoke(slot.slot_index)}
              />
            </div>
          </div>
          {#if canManageInline}
            <!-- What this app may sign, right here — no trip to Advanced. -->
            <KindPermissions
              allowedKinds={slot.allowed_kinds}
              unrestricted={slot.allowed_kinds.length === 0}
              signingApproved={slot.signing_approved}
              updating={updatingSlot === slot.slot_index}
              onchange={(kinds) => updatePermissions(slot.slot_index, kinds)}
            />
          {/if}
        </div>
      {/each}
    {/if}
  </section>

  <!-- Manage from your phone -->
  <PhoneHandoff />
  {/if}

  <!-- Footer: the escape hatch -->
  <section class="footer">
    <button class="footer-link" onclick={() => onadvanced?.()}>Advanced ⚙: every setting and tool</button>
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

  /* Edge states: one title style, actions row, disclosure for the diagnosis. */
  .state-title { font-size: 1.2rem; font-weight: 700; color: #fff; margin: 0 0 0.6rem; }
  .state-title.amber { color: #cba24a; }
  .state-actions { display: flex; flex-direction: column; gap: 0.6rem; margin-bottom: 0.9rem; }
  .state-actions .btn { width: 100%; }
  .state-causes {
    margin: 0; padding: 0.8rem 1rem 0.8rem 2rem;
    background: #0a0a0a; border: 1px solid var(--border); border-radius: 6px;
    font-size: 0.85rem; color: var(--text-dim); line-height: 1.6;
  }
  .state-causes li { margin: 0 0 0.4rem; }
  .state-causes li:last-child { margin-bottom: 0; }
  .state-causes strong { color: var(--text); }
  .state-causes code { color: var(--green); word-break: break-all; }
  .state-disconnect { margin-top: 1.1rem; }
  .state-actions { display: flex; gap: 0.6rem; margin-top: 1.1rem; }
  .wifi-usb { padding: 1.4rem; }

  /* USB connect: still checking whether the device answers. */
  .checking { display: flex; align-items: center; gap: 1rem; padding: 1.3rem 1.4rem; }
  .checking-spin {
    width: 22px; height: 22px; flex-shrink: 0; border-radius: 50%;
    border: 3px solid var(--border-bright); border-top-color: var(--green);
    animation: spin 0.8s linear infinite;
  }
  @keyframes spin { to { transform: rotate(360deg); } }
  .checking-title { font-size: 1.1rem; font-weight: 700; color: #fff; margin: 0 0 0.3rem; }
  .hint.no-gap { margin-bottom: 0; }

  .needs-usb { padding: 1.4rem; }

  .signer { display: flex; align-items: flex-start; gap: 0.85rem; padding: 1.2rem 1.4rem; }
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

  /* The no-identity stand-in for the signer card. */
  .conn-line { display: flex; align-items: center; gap: 0.6rem; padding: 0.2rem 0.1rem; }
  .conn-dot {
    width: 9px; height: 9px; border-radius: 50%; flex-shrink: 0;
    background: var(--green); box-shadow: var(--green-glow);
  }
  .conn-text { font-size: 0.82rem; color: var(--text-dim); flex: 1; }

  .rename-pencil {
    background: none; border: none; color: var(--text-muted); cursor: pointer;
    font-size: 0.9rem; padding: 0.1rem 0.3rem; border-radius: 3px;
  }
  .rename-pencil:hover { color: var(--green); }
  .rename { display: flex; gap: 0.5rem; align-items: center; }
  .rename-input { font-size: 1.1rem; padding: 0.4rem 0.6rem; }

  /* Operator-key backup card. */
  .backup { padding: 1.2rem 1.4rem; }
  .backup-head { display: flex; align-items: baseline; justify-content: space-between; gap: 1rem; }
  .backup-title { font-size: 1.05rem; font-weight: 700; color: var(--amber); margin: 0 0 0.5rem; }
  .backup-later { color: var(--text-muted); flex-shrink: 0; }
  .backup-later:hover { color: var(--text-dim); }
  .backup-words {
    display: grid; grid-template-columns: repeat(auto-fill, minmax(9rem, 1fr));
    gap: 0.35rem 1rem; margin: 0 0 1rem; padding: 0.9rem 1rem;
    background: #0a0a0a; border: 1px solid var(--border); border-radius: 6px;
    list-style: none; font-size: 0.9rem; color: var(--text);
  }
  .backup-words .word-n {
    display: inline-block; width: 1.6rem; color: var(--text-muted);
    font-size: 0.72rem; user-select: none;
  }
  .backup .uri-box { margin-bottom: 1rem; }

  /* Firmware nudge: one quiet line. */
  .fw-nudge {
    display: flex; align-items: center; justify-content: space-between; gap: 1rem;
    background: #120f06; border: 1px solid #3a3320; border-radius: 6px;
    padding: 0.6rem 0.9rem;
  }
  .fw-nudge-text { font-size: 0.82rem; color: var(--amber); }

  .apps-head { display: flex; align-items: center; gap: 0.6rem; margin-bottom: 0.8rem; }
  .apps-title { font-size: 1.05rem; font-weight: 600; color: #fff; margin: 0; }
  .apps-count {
    font-size: 0.72rem; font-weight: 600; color: var(--green); background: #08130d;
    border: 1px solid var(--green-dim); border-radius: 999px; padding: 0.05rem 0.5rem;
  }

  .app-card { padding: 0.85rem 1.1rem; margin-bottom: 0.5rem; }
  .app-row { display: flex; align-items: center; justify-content: space-between; gap: 1rem; }
  .app-info { display: flex; flex-direction: column; gap: 0.2rem; min-width: 0; }
  .app-name { font-size: 0.98rem; font-weight: 600; color: #fff; }
  .app-badge {
    display: inline-block; font-size: 0.58rem; letter-spacing: 0.06em; text-transform: uppercase; font-weight: 600;
    border-radius: 3px; padding: 0.08rem 0.4rem; margin-left: 0.5rem; vertical-align: middle;
    border: 1px solid var(--border-bright); color: var(--text-muted);
  }
  .app-badge.auto { color: var(--green); border-color: var(--green-dim); background: #08130d; }
  .app-badge.ask { color: #cba24a; border-color: #5a4a20; background: #120f06; }
  .app-badge.waiting { color: var(--text-dim); }
  .app-state { font-size: 0.78rem; color: var(--text-muted); line-height: 1.45; }
  .app-actions { display: flex; gap: 0.4rem; flex-shrink: 0; align-items: center; }
  .allow { color: var(--green); border-color: var(--green-dim); }
  .allow:hover:not(:disabled) { background: #002a12; border-color: var(--green); }
  /* Home's app rows read calmer with a borderless disconnect. */
  .app-actions :global(.btn-danger.borderless) { border-color: transparent; }

  .footer { border-top: 1px solid var(--border); padding-top: 1.2rem; }
  .footer-link {
    background: none; border: none; color: var(--text-dim); cursor: pointer;
    font-family: inherit; font-size: 0.9rem; padding: 0;
  }
  .footer-link:hover { color: #fff; }

  @media (max-width: 640px) {
    .app-row { flex-wrap: wrap; }
    .app-actions { width: 100%; justify-content: flex-end; }
  }
</style>
