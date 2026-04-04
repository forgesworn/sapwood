<script lang="ts">
  import { device, serialTransport, httpTransport } from '../lib/device.svelte.js'
  import { FrameType, buildFactoryReset } from '../lib/frame.js'

  let pending = $state(false)
  let result = $state<string | null>(null)

  async function handleReset() {
    if (!confirm('This will erase all keys and policies. The device will require button confirmation. Continue?')) return

    pending = true
    result = null
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
      result = frame.type === FrameType.ACK
        ? 'Factory reset complete. Device will reboot.'
        : 'Factory reset rejected by device.'
    } catch (e) {
      result = e instanceof Error ? e.message : 'Factory reset failed'
    } finally {
      pending = false
    }
  }
</script>

<div class="factory-reset">
  <h2>Factory Reset</h2>
  <p class="warning">Erases all master secrets, policies, bridge secret, and PIN. Irreversible.</p>

  <button
    class="reset-btn"
    disabled={!device.connected || pending}
    onclick={handleReset}
  >
    {pending ? 'Waiting for button...' : 'Factory Reset'}
  </button>

  {#if result}
    <p class="result">{result}</p>
  {/if}
</div>

<style>
  h2 { font-size: 1rem; font-weight: 600; margin: 0 0 0.5rem; color: #ccc; }
  .warning { font-size: 0.8rem; color: #a93; margin: 0 0 1rem; }

  .reset-btn {
    background: #1a1111;
    border: 1px solid #633;
    color: #a44;
    padding: 0.5rem 1.5rem;
    border-radius: 4px;
    font-family: inherit;
    font-size: 0.85rem;
    cursor: pointer;
    transition: background 0.15s;
  }

  .reset-btn:hover:not(:disabled) { background: #2a1515; }
  .reset-btn:disabled { opacity: 0.4; cursor: not-allowed; }

  .result { font-size: 0.85rem; color: #888; margin-top: 1rem; }
</style>
