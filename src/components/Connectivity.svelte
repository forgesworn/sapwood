<script lang="ts">
  import { onDestroy } from 'svelte'
  import {
    abortNetworkConfig, device, configureNetwork, configureNetworkRemotely, getNetworkConfig,
    patchNetworkOverUsb, scanWifi, type NetworkConfigTrial, type RemotePasswordChange,
    type WifiNetwork,
  } from '../lib/device.svelte.js'
  import { getOrCreateOperator } from '../lib/op-mgmt.js'
  import type { NetConfig } from '../lib/frame'
  import { DEFAULT_SIGNER_RELAYS, SUGGESTED_SIGNER_RELAYS } from '../lib/wizard.js'
  import PasswordReveal from './PasswordReveal.svelte'
  import RelayEditor from './RelayEditor.svelte'

  // Older firmware has no USB read-back, so these are display-only defaults
  // until the signer proves its own exact redacted state. They are never used
  // as authority for a current-firmware patch.
  function savedRelays(): string[] {
    try {
      const raw = JSON.parse(localStorage.getItem('heartwood.lastRelays') ?? '[]')
      const list = Array.isArray(raw) ? raw.filter((r): r is string => typeof r === 'string' && !!r) : []
      if (list.length) return list
    } catch { /* fall through to defaults */ }
    return [...DEFAULT_SIGNER_RELAYS]
  }

  let mode = $state<'usb' | 'wifi'>('wifi')
  let ssid = $state('')
  let password = $state('')
  let passwordSet = $state(false)
  let activeSsid = $state('')
  let clearPassword = $state(false)
  let showPw = $state(false)
  let relays = $state<string[]>(savedRelays())
  let status = $state<'idle' | 'sending' | 'done' | 'error'>('idle')
  let message = $state('')
  let loading = $state(false)
  let discarding = $state(false)
  let pendingTrial = $state<NetworkConfigTrial | null>(null)

  // WiFi scan (setup aid): ask the signer's own radio which 2.4 GHz networks it
  // can see, so the SSID is picked from reality instead of typed blind.
  let scanning = $state(false)
  let scanResults = $state<WifiNetwork[] | null>(null)
  let scanMsg = $state('')
  let scanNote = $state('')

  // Fallback networks after the primary, in priority order. `password: null`
  // means "keep what the signer already stores for this SSID" — reordering and
  // deleting never resend a secret. A string is a new password to set ('' =
  // open network).
  let fallbacks = $state<Array<{ ssid: string; password: string | null }>>([])
  let newNetSsid = $state('')
  let newNetPassword = $state('')

  const overUsb = $derived(device.connected && device.mode === 'serial')
  const overRelay = $derived(device.connected && device.mode === 'relay')
  const usbState = $derived(device.usbNetworkState)
  const usbConfigured = $derived(overUsb && usbState?.configured === true)
  const canConfigure = $derived(overUsb || overRelay)
  // Firmware that reports a `networks` array (even empty) understands the
  // fallback list; older firmware rejects the patch field outright.
  const supportsNetworkList = $derived(usbConfigured && usbState?.networks !== undefined)
  const MAX_FALLBACKS = 7

  function addFallback() {
    const cleanSsid = newNetSsid.trim()
    if (!cleanSsid || fallbacks.length >= MAX_FALLBACKS) return
    if (cleanSsid === ssid.trim() || fallbacks.some((n) => n.ssid === cleanSsid)) {
      scanNote = ''
      status = 'error'
      message = `"${cleanSsid}" is already in the list.`
      return
    }
    fallbacks = [...fallbacks, { ssid: cleanSsid, password: newNetPassword }]
    newNetSsid = ''
    newNetPassword = ''
    if (status === 'error') { status = 'idle'; message = '' }
  }

  function moveFallback(index: number, delta: number) {
    const target = index + delta
    if (target < 0 || target >= fallbacks.length) return
    const next = [...fallbacks]
    ;[next[index], next[target]] = [next[target], next[index]]
    fallbacks = next
  }

  function removeFallback(index: number) {
    fallbacks = fallbacks.filter((_, i) => i !== index)
  }

  /** Swap a fallback with the primary. A stored fallback promotes with `keep`
   * (its password resolves by SSID on the signer); a just-added one carries
   * its entered password into the primary field. The old primary drops into
   * the list at the same position, keeping its stored password. */
  function promoteFallback(index: number) {
    const target = fallbacks[index]
    if (!target) return
    const next = [...fallbacks]
    next[index] = { ssid: ssid.trim(), password: null }
    fallbacks = next
    ssid = target.ssid
    password = target.password ?? ''
    clearPassword = target.password === ''
  }
  let loadEpoch = 0

  function connectionKey(): string {
    const generation = Number(device.connectionGeneration ?? 0)
    const relayTarget = device.mode === 'relay' ? (device.relayDevicePub ?? '').toLowerCase() : ''
    return `${generation}:${device.connected ? device.mode : 'none'}:${relayTarget}`
  }

  function remoteTargetKey(): string {
    const target = (device.relayDevicePub ?? '').toLowerCase()
    return device.connected && device.mode === 'relay' && /^[0-9a-f]{64}$/.test(target)
      ? connectionKey()
      : ''
  }

  function resetForConnectionChange(): void {
    mode = 'wifi'
    ssid = ''
    activeSsid = ''
    password = ''
    passwordSet = false
    clearPassword = false
    showPw = false
    relays = savedRelays()
    status = 'idle'
    message = ''
    loading = false
    discarding = false
    pendingTrial = null
    scanning = false
    scanResults = null
    scanMsg = ''
    scanNote = ''
    fallbacks = []
    newNetSsid = ''
    newNetPassword = ''
  }

  async function loadRemoteConfig(targetKey: string, epoch: number) {
    if (!targetKey) return
    loading = true
    message = ''
    try {
      const state = await getNetworkConfig()
      if (epoch !== loadEpoch || remoteTargetKey() !== targetKey) return
      mode = 'wifi'
      ssid = state.active.ssid
      activeSsid = state.active.ssid
      relays = [...state.active.relays]
      password = '' // a password is never returned or persisted in the browser
      passwordSet = state.active.password_set
      clearPassword = false
      pendingTrial = state.trial
      if (state.trial) {
        message = state.trial.phase === 'staged'
          ? `A pending network change was staged but never activated (transaction ${state.trial.transaction_id}). Discard it before making another change.`
          : `The signer is trying a network change (transaction ${state.trial.transaction_id}). Wait for it to reconnect or roll back automatically.`
      }
    } catch (e) {
      if (epoch !== loadEpoch || remoteTargetKey() !== targetKey) return
      status = 'error'
      message = e instanceof Error ? e.message : String(e)
    } finally {
      if (epoch === loadEpoch && remoteTargetKey() === targetKey) loading = false
    }
  }

  $effect(() => {
    // Bind both the exact device pubkey and a monotonic transport epoch. A late
    // response from signer A must never populate the form after signer B (or a
    // new session to A) has taken over this still-mounted panel.
    connectionKey()
    const targetKey = remoteTargetKey()
    const epoch = ++loadEpoch
    resetForConnectionChange()
    if (targetKey) void loadRemoteConfig(targetKey, epoch)
  })

  $effect(() => {
    const state = device.usbNetworkState
    if (!overUsb || !state?.configured || !state.mode) return
    mode = state.mode
    ssid = state.ssid ?? ''
    activeSsid = state.ssid ?? ''
    relays = [...(state.relays ?? [])]
    password = ''
    passwordSet = state.password_set === true
    clearPassword = false
    fallbacks = (state.networks ?? []).map((n) => ({ ssid: n.ssid, password: null }))
    loading = false
  })

  onDestroy(() => {
    loadEpoch += 1
    // Never leave a supplied network credential in a detached component's
    // reactive state after navigation. Password-manager ignore hints below are
    // defence in depth; the browser app itself stores no password.
    password = ''
    clearPassword = false
    newNetPassword = ''
    fallbacks = fallbacks.map((n) => ({ ...n, password: n.password === null ? null : '' }))
  })

  async function discardPending() {
    if (!pendingTrial || pendingTrial.phase !== 'staged') return
    const requestKey = connectionKey()
    const epoch = loadEpoch
    const transactionId = pendingTrial.transaction_id
    discarding = true
    status = 'idle'
    message = ''
    try {
      await abortNetworkConfig(transactionId)
      if (epoch !== loadEpoch || connectionKey() !== requestKey) return
      pendingTrial = null
      message = 'Pending network change discarded. The active network was not changed.'
    } catch (e) {
      if (epoch !== loadEpoch || connectionKey() !== requestKey) return
      status = 'error'
      message = e instanceof Error ? e.message : String(e)
    } finally {
      if (epoch === loadEpoch && connectionKey() === requestKey) discarding = false
    }
  }

  async function scan() {
    scanning = true
    scanMsg = ''
    scanNote = ''
    scanResults = null
    try {
      const nets = await scanWifi()
      if (nets === null) {
        scanMsg = 'This signer cannot scan right now. Scanning needs current firmware over USB; if the signer is serving over WiFi, it pauses scanning while a connection is live.'
      } else if (nets.length === 0) {
        scanResults = []
        scanMsg = 'The signer sees no 2.4 GHz networks here. It may be out of range, or the networks nearby are 5 GHz-only (which the ESP32 cannot use).'
      } else {
        scanResults = nets
        scanMsg = `${nets.length} network${nets.length === 1 ? '' : 's'} the signer can see. Pick one to fill the SSID.`
      }
    } catch (e) {
      scanMsg = e instanceof Error ? e.message : String(e)
    } finally {
      scanning = false
    }
  }

  function pick(net: WifiNetwork) {
    ssid = net.ssid
    // Flag the auth cases that stop an ESP32 joining even a visible network.
    if (net.auth === 'wpa2-ent') {
      scanNote = 'This is an enterprise (802.1X) network. The signer cannot join those. Use a personal WPA2/WPA3 network or a phone hotspot.'
    } else if (net.auth === 'wpa3') {
      scanNote = 'This network is WPA3-only. If the signer will not join, set the router to WPA2/WPA3 mixed mode.'
    } else {
      scanNote = ''
    }
  }

  // Signal strength as blocks: roughly -55 dBm and up is full, -80 and below is one.
  function signalBars(rssi: number): string {
    const level = rssi >= -55 ? 4 : rssi >= -65 ? 3 : rssi >= -75 ? 2 : 1
    return '█'.repeat(level) + '░'.repeat(4 - level)
  }

  async function send() {
    const requestKey = connectionKey()
    const epoch = loadEpoch
    status = 'sending'
    message = ''
    const cleanSsid = ssid.trim()
    const cleanRelays = relays.map((relay) => relay.trim()).filter(Boolean)
    if (mode === 'wifi' && (!cleanSsid || cleanRelays.length === 0)) {
      status = 'error'
      message = 'WiFi mode needs an SSID and at least one relay'
      return
    }
    // Switching the primary SSID needs an explicit password decision — except
    // to a network the signer already stores, where `keep` resolves by SSID
    // (promoting a fallback never resends its secret).
    const storedFallback = supportsNetworkList
      && (usbState?.networks ?? []).some((n) => n.ssid === cleanSsid)
    if ((overRelay || usbConfigured) && activeSsid && cleanSsid !== activeSsid
      && !password && !clearPassword && !storedFallback) {
      status = 'error'
      message = 'Changing the WiFi name needs a new password, or explicitly choose Clear for an open network. Blank only keeps the password when the SSID is unchanged.'
      return
    }
    try {
      let ok = false
      if (overRelay) {
        const passwordChange: RemotePasswordChange = clearPassword
          ? { action: 'clear' }
          : password
            ? { action: 'set', value: password }
            : { action: 'keep' }
        await configureNetworkRemotely({
          mode: 'wifi',
          ssid: cleanSsid,
          relays: cleanRelays,
          password: passwordChange,
        })
        if (epoch !== loadEpoch || connectionKey() !== requestKey) return
        ok = true
        passwordSet = passwordChange.action === 'clear' ? false
          : passwordChange.action === 'set' ? true
            : passwordSet
        password = ''
        clearPassword = false
        activeSsid = cleanSsid
      } else if (usbConfigured) {
        const passwordChange: RemotePasswordChange = clearPassword
          ? { action: 'clear' }
          : password
            ? { action: 'set', value: password }
            : { action: 'keep' }
        const next = await patchNetworkOverUsb(mode === 'usb'
          ? { mode: 'usb' }
          : {
              mode: 'wifi',
              ssid: cleanSsid,
              relays: cleanRelays,
              password: passwordChange,
              // Only firmware that reports a networks array understands the
              // list; older firmware rejects unknown patch fields.
              ...(supportsNetworkList
                ? {
                    // The primary must not also appear in the list (the
                    // firmware rejects duplicate SSIDs).
                    networks: fallbacks.filter((n) => n.ssid !== cleanSsid).map((n) => ({
                      ssid: n.ssid,
                      password: n.password === null
                        ? { action: 'keep' as const }
                        : n.password
                          ? { action: 'set' as const, value: n.password }
                          : { action: 'clear' as const },
                    })),
                  }
                : {}),
            })
        if (epoch !== loadEpoch || connectionKey() !== requestKey) return
        ok = true
        password = ''
        clearPassword = false
        passwordSet = next.password_set === true
        activeSsid = next.ssid ?? cleanSsid
      } else {
        if (device.usbNetworkSupport === 'unsupported') {
          throw new Error('This signer firmware cannot safely preserve its stored password and operator during a network edit. Update the firmware over USB first.')
        }
        // A current, genuinely unconfigured device needs one full initial
        // configuration. This is the only path that deliberately establishes
        // the browser's operator while writing a password.
        const cfg: NetConfig = {
          ssid: cleanSsid,
          password,
          relays: mode === 'wifi' ? cleanRelays : [],
          mode,
          // USB's legacy whole-config frame must carry the existing operator
          // key. Relay staging never constructs or sends this field.
          op_mgmt: getOrCreateOperator().pubHex,
        }
        ok = await configureNetwork(cfg)
        if (epoch !== loadEpoch || connectionKey() !== requestKey) return
      }
      status = ok ? 'done' : 'error'
      message = ok
        ? (overRelay
            ? 'Saved. The signer reconnected on the staged network and committed it.'
            : usbConfigured
              ? 'Saved and verified after the signer rebooted.'
              : 'Initial network and operator saved. The signer is rebooting.')
        : 'Device rejected the config'
      // Remember the relays we just wrote so the panel reflects them next time
      // and the USB bunker-URI builder (serialGetUri reads lastRelays) hands out
      // links that name them.
      if (ok && mode === 'wifi') {
        try { localStorage.setItem('heartwood.lastRelays', JSON.stringify(cleanRelays)) } catch { /* ignore */ }
      }
    } catch (e) {
      if (epoch !== loadEpoch || connectionKey() !== requestKey) return
      status = 'error'
      message = e instanceof Error ? e.message : String(e)
    }
  }
</script>

<div class="connectivity">
  <h2 class="section-title">Network</h2>
  <p class="hint"><strong>WiFi-standalone</strong> is the standard setup: the signer sits on your
    network and works from anywhere. <strong>USB-only (radio off)</strong> is the hardened tier:
    no network stack runs on the key-holding chip, and Nostr apps reach it through the bridge
    daemon on the computer it's plugged into.</p>

  {#if device.connected && !canConfigure}
    <p class="hint">Connect directly by USB or through the signer's authenticated WiFi management channel to change its network.</p>
  {:else if overRelay}
    <p class="hint">Remote saves are staged first. Sapwood reconnects through the old and candidate relays, commits only the matching transaction, and otherwise leaves the signer to roll back automatically.</p>
    {#if pendingTrial?.phase === 'staged'}
      <button class="btn btn-secondary" onclick={discardPending} disabled={discarding}>
        {discarding ? 'Discarding…' : 'Discard pending change'}
      </button>
    {/if}
  {/if}

  <div class="form">
    <label class="field">
      <span class="field-label">Mode</span>
      <select class="field-input" bind:value={mode} disabled={!overUsb || loading || status === 'sending'}>
        <option value="wifi">WiFi-standalone (standard)</option>
        <option value="usb">USB-only, radio off (hardened)</option>
      </select>
    </label>

    {#if mode === 'usb'}
      <p class="hint-sm">Remote signing in this mode needs the heartwood bridge daemon running on
        an always-on computer with the signer plugged in. Local management here over the cable
        needs nothing extra.</p>
    {/if}

    {#if mode === 'wifi'}
      <div class="field">
        <span class="field-label">WiFi SSID</span>
        <div class="ssid-row">
          <input class="field-input" bind:value={ssid} disabled={!canConfigure || loading || status === 'sending'} aria-label="WiFi SSID" />
          {#if overUsb}
            <button
              type="button"
              class="btn btn-secondary scan-btn"
              onclick={scan}
              disabled={!canConfigure || scanning}
            >
              {scanning ? 'Scanning…' : 'Scan'}
            </button>
          {/if}
        </div>
        {#if scanMsg}<p class="hint-sm scan-msg">{scanMsg}</p>{/if}
        {#if scanResults && scanResults.length}
          <ul class="scan-list">
            <!-- scanWifi() returns one entry per SSID, so the name is a safe key. -->
            {#each scanResults as net (net.ssid)}
              <li>
                <button type="button" class="scan-item" class:selected={net.ssid === ssid} onclick={() => pick(net)}>
                  <span class="scan-ssid">{net.ssid}</span>
                  <span class="scan-auth">{net.auth}</span>
                  <span class="scan-sig" title="{net.rssi} dBm">{signalBars(net.rssi)}</span>
                </button>
              </li>
            {/each}
          </ul>
        {/if}
        {#if scanNote}<p class="hint-sm scan-note">{scanNote}</p>{/if}
      </div>
      <div class="field">
        <span class="field-label">WiFi password</span>
        <div class="pw-wrap">
          <input
            type={showPw ? 'text' : 'password'}
            class="field-input"
            bind:value={password}
            disabled={!canConfigure || loading || status === 'sending' || clearPassword}
            placeholder={(overRelay || usbConfigured) ? (passwordSet ? 'Leave blank to keep current password' : 'Leave blank for an open network') : ''}
            autocomplete="off"
            data-1p-ignore
            data-lpignore="true"
            aria-label="WiFi password"
          />
          <PasswordReveal bind:shown={showPw} disabled={!canConfigure || loading || status === 'sending' || clearPassword} />
        </div>
        {#if overRelay || usbConfigured}
          <p class="hint-sm">The signer only reports whether a password exists; it never sends the password back. Blank keeps the current value, typing sets a new one.</p>
          <label class="clear-password">
            <input type="checkbox" bind:checked={clearPassword} disabled={loading || status === 'sending'} />
            Clear the saved password (open network)
          </label>
        {/if}
      </div>
      {#if supportsNetworkList}
        <div class="field">
          <span class="field-label">Fallback networks</span>
          <p class="hint-sm">Tried in order when the network above is out of reach — home first,
            then a phone hotspot, say. Reordering and removing never resend a password.</p>
          {#if fallbacks.length}
            <ul class="fallback-list">
              {#each fallbacks as net, i (net.ssid)}
                <li class="fallback-row">
                  <span class="fallback-ssid">{net.ssid}</span>
                  <span class="fallback-pw">{net.password === null ? 'saved password' : net.password ? 'new password' : 'open'}</span>
                  <button type="button" class="fallback-btn" title="Make primary" aria-label={`Make ${net.ssid} the primary network`}
                    onclick={() => promoteFallback(i)} disabled={loading || status === 'sending'}>★</button>
                  <button type="button" class="fallback-btn" title="Move up" aria-label={`Move ${net.ssid} up`}
                    onclick={() => moveFallback(i, -1)} disabled={i === 0 || loading || status === 'sending'}>↑</button>
                  <button type="button" class="fallback-btn" title="Move down" aria-label={`Move ${net.ssid} down`}
                    onclick={() => moveFallback(i, 1)} disabled={i === fallbacks.length - 1 || loading || status === 'sending'}>↓</button>
                  <button type="button" class="fallback-btn fallback-remove" title="Remove" aria-label={`Remove ${net.ssid}`}
                    onclick={() => removeFallback(i)} disabled={loading || status === 'sending'}>✕</button>
                </li>
              {/each}
            </ul>
          {/if}
          {#if fallbacks.length < MAX_FALLBACKS}
            <div class="fallback-add">
              <input class="field-input" placeholder="Network name (SSID)" bind:value={newNetSsid}
                autocomplete="off" data-1p-ignore data-lpignore="true"
                disabled={loading || status === 'sending'} />
              <input class="field-input" type="password" placeholder="Password (blank = open)" bind:value={newNetPassword}
                autocomplete="off" data-1p-ignore data-lpignore="true"
                disabled={loading || status === 'sending'} />
              <button type="button" class="btn btn-secondary" onclick={addFallback}
                disabled={!newNetSsid.trim() || loading || status === 'sending'}>Add</button>
            </div>
          {:else}
            <p class="hint-sm">List full — the signer stores up to {MAX_FALLBACKS} fallbacks beside the primary network.</p>
          {/if}
        </div>
      {:else if overRelay}
        <p class="hint-sm">Editing the fallback-network list needs the USB cable.</p>
      {/if}
      <div class="field">
        <span class="field-label">Relays</span>
        <RelayEditor
          {relays}
          suggestions={SUGGESTED_SIGNER_RELAYS}
          disabled={!canConfigure || loading || status === 'sending'}
          showHealth
          onchange={(next) => (relays = next)}
        />
      </div>
      {#if overUsb}
        {#if usbConfigured}
          <p class="hint-sm">This signer supports safe USB patches: blank keeps the stored password and network saves cannot change the management operator.</p>
        {:else if device.usbNetworkSupport === 'unsupported'}
          <p class="hint-sm error-text">Update the signer firmware before editing its network. Older firmware can only rewrite the whole configuration and may clear a password or replace the operator.</p>
        {:else}
          <p class="hint-sm">Reading the signer's current network state…</p>
        {/if}
      {/if}
    {/if}

    <button
      class="btn btn-secondary form-submit"
      onclick={send}
      disabled={!canConfigure || loading || status === 'sending' || pendingTrial !== null || (overUsb && device.usbNetworkSupport === 'unsupported')}
    >
      {loading ? 'Loading…' : status === 'sending' ? (overRelay ? 'Testing network…' : 'Sending…') : overRelay ? 'Test & save network' : 'Save to device'}
    </button>
  </div>

  {#if message}
    <p class:error-text={status === 'error'} class:success-text={status === 'done'}>{message}</p>
  {/if}
</div>

<style>
  /* Outlined so the fields and the Save button that commits them read as one
     unit — mid-page, an unboxed Save looked detached from the section. */
  .form {
    display: flex; flex-direction: column; gap: 0.75rem;
    border: 1px solid var(--green-dim); border-radius: 8px;
    padding: 1rem;
  }
  .form-submit { align-self: flex-start; margin-top: 0.25rem; }

  .ssid-row { display: flex; gap: 0.5rem; align-items: stretch; }
  .ssid-row .field-input { flex: 1 1 auto; min-width: 0; }
  .scan-btn { flex: 0 0 auto; white-space: nowrap; }
  .scan-msg { margin: 0.4rem 0 0; }

  /* Networks the signer's own radio can see — a selectable list. */
  .scan-list {
    list-style: none; margin: 0.5rem 0 0; padding: 0;
    display: flex; flex-direction: column; gap: 2px;
    max-height: 12rem; overflow-y: auto;
    border: 1px solid var(--green-dim); border-radius: 6px;
  }
  .scan-item {
    display: flex; align-items: center; gap: 0.6rem; width: 100%;
    background: none; border: none; cursor: pointer;
    padding: 0.5rem 0.7rem; font-family: inherit; font-size: 0.85rem;
    color: var(--text); text-align: left;
  }
  .scan-item:hover { background: #0c1a13; }
  .scan-item.selected { background: #06120e; color: var(--green); }
  .scan-ssid { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .scan-auth { flex: 0 0 auto; font-size: 0.72rem; color: var(--text-muted); letter-spacing: 0.03em; }
  .scan-sig { flex: 0 0 auto; color: var(--green); letter-spacing: 1px; font-size: 0.8rem; }
  .scan-note { margin: 0.4rem 0 0; color: var(--amber, #d9a441); }

  /* Fallback-network list: same bordered idiom as .scan-list. */
  .fallback-list {
    list-style: none; margin: 0.5rem 0 0; padding: 0;
    display: flex; flex-direction: column; gap: 2px;
    border: 1px solid var(--green-dim); border-radius: 6px;
  }
  .fallback-row {
    display: flex; align-items: center; gap: 0.5rem;
    padding: 0.45rem 0.7rem; font-size: 0.85rem;
  }
  .fallback-ssid { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .fallback-pw { flex: 0 0 auto; font-size: 0.72rem; color: var(--text-muted); letter-spacing: 0.03em; }
  .fallback-btn {
    flex: 0 0 auto; background: none; border: 1px solid var(--green-dim); border-radius: 4px;
    color: var(--text); cursor: pointer; padding: 0.1rem 0.4rem; font-family: inherit;
  }
  .fallback-btn:hover:not(:disabled) { background: #0c1a13; }
  .fallback-btn:disabled { opacity: 0.4; cursor: default; }
  .fallback-remove { color: var(--danger, #d05f5f); border-color: var(--danger, #d05f5f); }
  .fallback-add { display: flex; gap: 0.5rem; margin-top: 0.5rem; align-items: stretch; }
  .fallback-add .field-input { flex: 1 1 auto; min-width: 0; }
  .clear-password { display: flex; align-items: center; gap: 0.45rem; margin-top: 0.45rem; font-size: 0.78rem; color: var(--text-muted); }
</style>
