<script lang="ts">
  import { device } from '../lib/device.svelte.js'
</script>

{#if device.connected && device.masters.length > 0}
  <div class="status-bar">
    <span class="stat">{device.masters.length} identit{device.masters.length !== 1 ? 'ies' : 'y'}</span>
    <span class="dot"></span>
    <span class="stat">{device.slots.length} app{device.slots.length !== 1 ? 's' : ''}</span>
    {#if device.mode === 'http' && device.bridgeInfo}
      <span class="dot"></span>
      <span class="stat">{device.bridgeInfo.mode}</span>
    {/if}
  </div>
{:else if device.connected && device.error}
  <div class="status-error">⚠ {device.error}</div>
{/if}

<style>
  .status-bar {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    padding: 0.5rem 0;
    font-size: 0.9rem;
  }

  .stat { color: var(--text-dim); }

  .status-error {
    padding: 0.5rem 0.75rem;
    font-size: 0.85rem;
    color: var(--amber);
    background: #160c0a;
    border: 1px solid #3a2320;
    border-radius: 4px;
    word-break: break-word;
  }
  .dot {
    width: 4px;
    height: 4px;
    border-radius: 50%;
    background: #333;
  }
</style>
