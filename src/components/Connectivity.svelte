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
  <h2>Connectivity</h2>
  <p class="hint">USB-bridged is the high-assurance default. WiFi mode is the convenience tier — see the device docs.</p>

  {#if device.connected && !canConfigure}
    <p class="hint">Network settings are changed over USB. Plug the signer into this computer, connect, and come back here.</p>
  {/if}

  <div class="form">
    <label class="field">
      <span>Mode</span>
      <select bind:value={mode} disabled={!canConfigure}>
        <option value="usb">USB-bridged (radio off)</option>
        <option value="wifi">WiFi-standalone</option>
      </select>
    </label>

    {#if mode === 'wifi'}
      <label class="field">
        <span>WiFi SSID</span>
        <input bind:value={ssid} disabled={!canConfigure} />
      </label>
      <label class="field">
        <span>WiFi password</span>
        <div class="pw">
          <input type={showPw ? 'text' : 'password'} bind:value={password} disabled={!canConfigure} />
          <PasswordReveal bind:shown={showPw} disabled={!canConfigure} />
        </div>
      </label>
      <label class="field">
        <span>Relays (one per line)</span>
        <textarea bind:value={relaysText} rows={3} disabled={!canConfigure}></textarea>
      </label>
    {/if}

    <button
      class="btn"
      onclick={send}
      disabled={!canConfigure || status === 'sending'}
    >
      {status === 'sending' ? 'Sending…' : 'Save to device'}
    </button>
  </div>

  {#if message}
    <p class:error={status === 'error'} class:success={status === 'done'}>{message}</p>
  {/if}
</div>

<style>
  h2 { font-size: 1rem; font-weight: 600; margin: 0 0 1rem; color: #ccc; }

  .hint { font-size: 0.8rem; color: #666; margin: 0 0 1.25rem; }

  .form { display: flex; flex-direction: column; gap: 0.75rem; }

  .field {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }

  .field span {
    font-size: 0.75rem;
    color: #666;
  }

  .field select, .field input, .field textarea {
    background: #0a0a0a;
    border: 1px solid #333;
    color: #ccc;
    padding: 0.35rem 0.5rem;
    border-radius: 3px;
    font-family: inherit;
    font-size: 0.8rem;
    resize: vertical;
  }

  .field select { cursor: pointer; }
  .pw { position: relative; display: flex; }
  .pw input { flex: 1; padding-right: 2.2rem; }
  .field input:disabled, .field textarea:disabled, .field select:disabled { opacity: 0.4; }
  .field input::placeholder, .field textarea::placeholder { color: #444; }

  .btn {
    background: #1a1a1a;
    border: 1px solid #333;
    color: #ccc;
    padding: 0.4rem 1rem;
    border-radius: 3px;
    font-family: inherit;
    font-size: 0.85rem;
    cursor: pointer;
    align-self: flex-start;
    margin-top: 0.25rem;
  }

  .btn:hover:not(:disabled) { background: #222; }
  .btn:disabled { opacity: 0.4; cursor: not-allowed; }

  .error { font-size: 0.8rem; color: #a44; margin-top: 0.5rem; }
  .success { font-size: 0.85rem; color: #4a9; margin-top: 0.5rem; }
</style>
