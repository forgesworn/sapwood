<script lang="ts">
  import { device, configureNetwork } from '../lib/device.svelte.js'
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

  // Network config travels as a USB frame and needs the device's button —
  // it cannot be changed over the bridge or a relay.
  const canConfigure = $derived(device.connected && device.mode === 'serial')

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
      <label class="field">
        <span class="field-label">WiFi SSID</span>
        <input class="field-input" bind:value={ssid} disabled={!canConfigure} />
      </label>
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
</style>
