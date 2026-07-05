<script lang="ts">
  import { device, configureNetwork, scanWifi, type WifiNetwork } from '../lib/device.svelte.js'
  import { getOrCreateOperator } from '../lib/op-mgmt.js'
  import type { NetConfig } from '../lib/frame'
  import { DEFAULT_SIGNER_RELAYS, SUGGESTED_SIGNER_RELAYS } from '../lib/wizard.js'
  import PasswordReveal from './PasswordReveal.svelte'
  import RelayEditor from './RelayEditor.svelte'

  // The firmware exposes no read-back for the network config, so the signer's
  // relays as flashed (persisted by the flasher) are the best local truth. Start
  // from those, not the hardcoded defaults — otherwise the panel always shows
  // defaults and a saved edit reads as reverted ("it didn't stick").
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
  let showPw = $state(false)
  let relays = $state<string[]>(savedRelays())
  let status = $state<'idle' | 'sending' | 'done' | 'error'>('idle')
  let message = $state('')

  // WiFi scan (setup aid): ask the signer's own radio which 2.4 GHz networks it
  // can see, so the SSID is picked from reality instead of typed blind.
  let scanning = $state(false)
  let scanResults = $state<WifiNetwork[] | null>(null)
  let scanMsg = $state('')
  let scanNote = $state('')

  // Network config travels as a USB frame and needs the device's button —
  // it cannot be changed over the bridge or a relay.
  const canConfigure = $derived(device.connected && device.mode === 'serial')

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
    status = 'sending'
    message = ''
    const cfg: NetConfig = {
      ssid: ssid.trim(),
      password,
      relays: mode === 'wifi' ? relays : [],
      mode,
      // The firmware stores the whole config verbatim, so an omitted op_mgmt
      // wipes the operator key and disables WiFi management. Always carry this
      // browser's operator (as the flasher does) so a network edit keeps — or
      // restores — the ability to manage over the relay.
      op_mgmt: getOrCreateOperator().pubHex,
    }
    if (mode === 'wifi' && (!cfg.ssid || cfg.relays.length === 0)) {
      status = 'error'
      message = 'WiFi mode needs an SSID and at least one relay'
      return
    }
    try {
      const ok = await configureNetwork(cfg)
      status = ok ? 'done' : 'error'
      message = ok ? 'Saved. Re-plug power to apply.' : 'Device rejected the config'
      // Remember the relays we just wrote so the panel reflects them next time
      // and the USB bunker-URI builder (serialGetUri reads lastRelays) hands out
      // links that name them.
      if (ok && mode === 'wifi') {
        try { localStorage.setItem('heartwood.lastRelays', JSON.stringify(relays)) } catch { /* ignore */ }
      }
    } catch (e) {
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
    <p class="hint">Network settings are changed over USB. Plug the signer into this computer, connect, and come back here.</p>
  {/if}

  <div class="form">
    <label class="field">
      <span class="field-label">Mode</span>
      <select class="field-input" bind:value={mode} disabled={!canConfigure}>
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
          <input class="field-input" bind:value={ssid} disabled={!canConfigure} aria-label="WiFi SSID" />
          <button
            type="button"
            class="btn btn-secondary scan-btn"
            onclick={scan}
            disabled={!canConfigure || scanning}
          >
            {scanning ? 'Scanning…' : 'Scan'}
          </button>
        </div>
        {#if scanMsg}<p class="hint-sm scan-msg">{scanMsg}</p>{/if}
        {#if scanResults && scanResults.length}
          <ul class="scan-list">
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
      <label class="field">
        <span class="field-label">WiFi password</span>
        <div class="pw-wrap">
          <input type={showPw ? 'text' : 'password'} class="field-input" bind:value={password} disabled={!canConfigure} />
          <PasswordReveal bind:shown={showPw} disabled={!canConfigure} />
        </div>
      </label>
      <div class="field">
        <span class="field-label">Relays</span>
        <RelayEditor
          {relays}
          suggestions={SUGGESTED_SIGNER_RELAYS}
          disabled={!canConfigure}
          onchange={(next) => (relays = next)}
        />
      </div>
      <p class="hint-sm">Saving rewrites the whole network config, so enter the WiFi name and password
        as well, even to change only the relays. The signer applies it after you re-plug its power.</p>
    {/if}

    <button
      class="btn btn-secondary form-submit"
      onclick={send}
      disabled={!canConfigure || status === 'sending'}
    >
      {status === 'sending' ? 'Sending…' : 'Save to device'}
    </button>
  </div>

  {#if message}
    <p class:error-text={status === 'error'} class:success-text={status === 'done'}>{message}</p>
  {/if}
</div>

<style>
  .form { display: flex; flex-direction: column; gap: 0.75rem; }
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
</style>
