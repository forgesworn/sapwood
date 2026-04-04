<script lang="ts">
  import { device, connectSerial, connectHttp, disconnect, HttpTransport } from '../lib/device.svelte.js'

  let showHttpForm = $state(false)
  let httpAddress = $state(HttpTransport.savedAddress() ?? '')
  let connecting = $state(false)

  async function handleConnectSerial() {
    connecting = true
    try {
      await connectSerial()
    } finally {
      connecting = false
    }
  }

  async function handleConnectHttp() {
    if (!httpAddress.trim()) return
    connecting = true
    try {
      await connectHttp(httpAddress.trim())
      showHttpForm = false
    } catch {
      // Error emitted via transport listener.
    } finally {
      connecting = false
    }
  }
</script>

<div class="connection">
  {#if device.connected}
    <span class="dot connected"></span>
    <span class="info">
      {device.mode === 'serial' ? 'USB' : 'Pi'}: {device.portInfo}
    </span>
    {#if device.mode === 'http' && device.bridgeInfo}
      <span class="bridge-mode">{device.bridgeInfo.mode}</span>
    {/if}
    <button class="btn disconnect" onclick={() => disconnect()}>Disconnect</button>
  {:else}
    <span class="dot disconnected"></span>
    <div class="connect-options">
      {#if !showHttpForm}
        <button
          class="btn connect"
          onclick={handleConnectSerial}
          disabled={connecting || !('serial' in navigator)}
          title={!('serial' in navigator) ? 'Web Serial not supported. Use Chrome or Edge.' : ''}
        >
          {connecting ? 'Connecting...' : 'Connect USB'}
        </button>
        <button class="btn connect-http" onclick={() => showHttpForm = true} disabled={connecting}>
          Connect to Pi
        </button>
      {:else}
        <form class="http-form" onsubmit={(e) => { e.preventDefault(); handleConnectHttp() }}>
          <input
            type="text"
            bind:value={httpAddress}
            placeholder="192.168.1.50:3100"
            disabled={connecting}
          />
          <button type="submit" class="btn connect-http" disabled={connecting || !httpAddress.trim()}>
            {connecting ? 'Connecting...' : 'Connect'}
          </button>
          <button type="button" class="btn cancel" onclick={() => showHttpForm = false}>
            Cancel
          </button>
        </form>
      {/if}
    </div>
  {/if}
  {#if device.error}
    <span class="error">{device.error}</span>
  {/if}
</div>

<style>
  .connection {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.5rem 0.75rem;
    background: #111;
    border-radius: 4px;
    font-size: 0.8rem;
    flex-wrap: wrap;
  }

  .dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }
  .dot.connected { background: #4a9; }
  .dot.disconnected { background: #555; }

  .info { color: #888; }
  .bridge-mode { color: #666; font-size: 0.7rem; }

  .connect-options { display: flex; gap: 0.25rem; flex-wrap: wrap; }

  .btn {
    background: #1a1a1a;
    border: 1px solid #333;
    color: #ccc;
    padding: 0.25rem 0.75rem;
    border-radius: 3px;
    font-family: inherit;
    font-size: 0.8rem;
    cursor: pointer;
    transition: background 0.15s;
  }

  .btn:hover:not(:disabled) { background: #222; }
  .btn:disabled { opacity: 0.4; cursor: not-allowed; }
  .btn.connect { border-color: #4a9; color: #4a9; }
  .btn.connect-http { border-color: #49a; color: #49a; }
  .btn.disconnect { border-color: #633; color: #a44; }
  .btn.cancel { color: #666; }

  .http-form {
    display: flex;
    gap: 0.25rem;
    align-items: center;
  }

  .http-form input {
    background: #0a0a0a;
    border: 1px solid #333;
    color: #ccc;
    padding: 0.25rem 0.5rem;
    border-radius: 3px;
    font-family: inherit;
    font-size: 0.8rem;
    width: 180px;
  }

  .http-form input::placeholder { color: #555; }

  .error { color: #a44; font-size: 0.75rem; width: 100%; margin-top: 0.25rem; }
</style>
