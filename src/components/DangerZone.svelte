<script lang="ts">
  import { device, serialTransport, httpTransport, bridgeRestart } from '../lib/device.svelte.js'
  import { FrameType, buildFactoryReset } from '../lib/frame.js'

  let resetPending = $state(false)
  let resetResult = $state<string | null>(null)
  let restartPending = $state(false)

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

  async function handleBridgeRestart() {
    if (!confirm('Restart the bridge? Relay connections will drop temporarily.')) return
    restartPending = true
    try {
      await bridgeRestart()
    } catch (e) {
      device.error = e instanceof Error ? e.message : 'Restart failed'
    } finally {
      restartPending = false
    }
  }
</script>

<div class="danger-zone">
  <h2>Factory Reset</h2>
  <p class="warning">Erases all master secrets, policies, bridge secret, and PIN. Irreversible.</p>
  <button
    class="danger-btn"
    disabled={!device.connected || resetPending}
    onclick={handleReset}
  >
    {resetPending ? 'Waiting for button...' : 'Factory Reset'}
  </button>
  {#if resetResult}
    <p class="result">{resetResult}</p>
  {/if}

  {#if device.mode === 'http'}
    <h2>Bridge</h2>
    <p class="info">Restart the bridge process. systemd will bring it back up. Relay connections will reconnect automatically.</p>
    <button
      class="restart-btn"
      disabled={restartPending}
      onclick={handleBridgeRestart}
    >
      {restartPending ? 'Restarting...' : 'Restart Bridge'}
    </button>
  {/if}
</div>

<style>
  h2 { font-size: 1rem; font-weight: 600; margin: 1.5rem 0 0.5rem; color: #ccc; }
  h2:first-child { margin-top: 0; }
  .warning { font-size: 0.8rem; color: #a93; margin: 0 0 1rem; }
  .info { font-size: 0.8rem; color: #666; margin: 0 0 1rem; }

  .danger-btn, .restart-btn {
    border: 1px solid #633;
    color: #a44;
    padding: 0.5rem 1.5rem;
    border-radius: 4px;
    font-family: inherit;
    font-size: 0.85rem;
    cursor: pointer;
    transition: background 0.15s;
  }

  .danger-btn { background: #1a1111; }
  .danger-btn:hover:not(:disabled) { background: #2a1515; }

  .restart-btn { background: #1a1511; border-color: #653; color: #a84; }
  .restart-btn:hover:not(:disabled) { background: #2a2015; }

  .danger-btn:disabled, .restart-btn:disabled { opacity: 0.4; cursor: not-allowed; }
  .result { font-size: 0.85rem; color: #888; margin-top: 1rem; }
</style>
