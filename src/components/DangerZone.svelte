<script lang="ts">
  import { device, serialTransport, httpTransport, bridgeRestart } from '../lib/device.svelte.js'
  import { FrameType, buildFactoryReset } from '../lib/frame.js'

  let resetPending = $state(false)
  let resetResult = $state<string | null>(null)
  let stopPending = $state(false)

  async function handleReset() {
    if (!confirm('This will erase all keys and policies. The device will require button confirmation. Continue?')) return
    resetPending = true
    resetResult = null
    try {
      let frame
      if (device.mode === 'http') {
        frame = await httpTransport.factoryReset()
      } else {
        frame = await serialTransport.sendAndReceive(
          buildFactoryReset(),
          [FrameType.ACK, FrameType.NACK],
          60_000,
        )
      }
      resetResult = frame.type === FrameType.ACK
        ? 'Factory reset complete. Device will reboot.'
        : 'Factory reset rejected by device.'
    } catch (e) {
      resetResult = e instanceof Error ? e.message : 'Factory reset failed'
    } finally {
      resetPending = false
    }
  }

  async function handleBridgeStop() {
    if (!confirm('Stop the bridge? This will free the USB port so you can connect directly. You will need to restart the bridge manually.')) return
    stopPending = true
    try {
      await bridgeRestart() // exits the process
    } catch {
      // Expected -- the bridge is gone.
    } finally {
      stopPending = false
    }
  }

  async function handleBridgeRestart() {
    if (!confirm('Restart the bridge? Relay connections will drop temporarily.')) return
    stopPending = true
    try {
      await bridgeRestart()
    } catch {
      // Expected during restart.
    } finally {
      stopPending = false
    }
  }
</script>

<div class="danger-zone">
  {#if device.mode === 'http'}
    <h2>Bridge Control</h2>
    <p class="info">
      The bridge holds the USB serial port. Stop it to switch to direct USB mode.
    </p>
    <div class="button-row">
      <button class="btn-stop" disabled={stopPending} onclick={handleBridgeStop}>
        {stopPending ? 'Stopping...' : 'Stop Bridge'}
      </button>
      <button class="btn-restart" disabled={stopPending} onclick={handleBridgeRestart}>
        {stopPending ? 'Restarting...' : 'Restart Bridge'}
      </button>
    </div>
    <p class="hint">
      After stopping, open <a href="https://forgesworn.github.io/sapwood/" target="_blank" rel="noopener">sapwood.dev</a> and connect via USB.
    </p>
  {:else if device.mode === 'serial'}
    <p class="info">Connected via USB. To use bridge mode, start the bridge and reconnect.</p>
  {/if}

  <h2>Factory Reset</h2>
  <p class="warning">Erases all master secrets, policies, bridge secret, and PIN. Irreversible. Requires physical button confirmation.</p>
  <button
    class="btn-danger"
    disabled={!device.connected || resetPending}
    onclick={handleReset}
  >
    {resetPending ? 'Waiting for button...' : 'Factory Reset'}
  </button>
  {#if resetResult}
    <p class="result">{resetResult}</p>
  {/if}
</div>

<style>
  h2 { font-size: 1.3rem; font-weight: 600; margin: 1.5rem 0 0.75rem; color: #fff; }
  h2:first-child { margin-top: 0; }

  .info { font-size: 1rem; color: var(--text-dim); margin: 0 0 1.25rem; line-height: 1.5; }
  .warning { font-size: 1rem; color: var(--amber); margin: 0 0 1.25rem; line-height: 1.5; }
  .hint { font-size: 0.9rem; color: var(--text-muted); margin-top: 1rem; }
  .hint a { color: var(--green-dim); text-decoration: none; }
  .hint a:hover { color: var(--green); }
  .result { font-size: 1rem; color: var(--text-dim); margin-top: 1rem; }

  .button-row { display: flex; gap: 0.75rem; }

  .btn-stop, .btn-restart, .btn-danger {
    font-family: inherit;
    font-size: 1rem;
    font-weight: 500;
    padding: 0.65rem 1.5rem;
    border-radius: 4px;
    cursor: pointer;
    transition: all 0.15s;
  }

  .btn-stop {
    background: #1a0e00;
    border: 1px solid #664400;
    color: var(--amber);
  }
  .btn-stop:hover:not(:disabled) { background: #2a1800; }

  .btn-restart {
    background: transparent;
    border: 1px solid var(--border-bright);
    color: var(--text-dim);
  }
  .btn-restart:hover:not(:disabled) { background: var(--surface-hover); }

  .btn-danger {
    background: #1a0808;
    border: 1px solid #662222;
    color: var(--red);
  }
  .btn-danger:hover:not(:disabled) { background: #2a1010; }

  .btn-stop:disabled, .btn-restart:disabled, .btn-danger:disabled {
    opacity: 0.35;
    cursor: not-allowed;
  }
</style>
