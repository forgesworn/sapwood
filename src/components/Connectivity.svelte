<script lang="ts">
  import { device, configureNetwork } from '../lib/device.svelte.js'
  import type { NetConfig } from '../lib/frame'
  import PasswordReveal from './PasswordReveal.svelte'

  let mode = $state<'usb' | 'wifi'>('usb')
  let ssid = $state('')
  let password = $state('')
  let showPw = $state(false)
  let relaysText = $state('wss://relay.trotters.cc')
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
      relays: relaysText.split(/[\n,]/).map(s => s.trim()).filter(Boolean),
      mode,
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
    } catch (e) {
      status = 'error'
      message = e instanceof Error ? e.message : String(e)
    }
  }
</script>

<div class="connectivity">
  <h2 class="section-title">Network</h2>
  <p class="hint">USB-bridged keeps the radio off (high assurance); WiFi-standalone manages over a relay.</p>

  {#if device.connected && !canConfigure}
    <p class="hint">Network settings are changed over USB. Plug the signer into this computer, connect, and come back here.</p>
  {/if}

  <div class="form">
    <label class="field">
      <span class="field-label">Mode</span>
      <select class="field-input" bind:value={mode} disabled={!canConfigure}>
        <option value="usb">USB-bridged (radio off)</option>
        <option value="wifi">WiFi-standalone</option>
      </select>
    </label>

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
      <label class="field">
        <span class="field-label">Relays (one per line)</span>
        <textarea class="field-input" bind:value={relaysText} rows={3} disabled={!canConfigure}></textarea>
      </label>
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
