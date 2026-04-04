<script lang="ts">
  import { device } from '../lib/device.svelte.js'
</script>

{#if device.connected && device.masters.length > 0}
  <div class="status-bar">
    <span class="stat">{device.masters.length} master{device.masters.length !== 1 ? 's' : ''}</span>
    <span class="dot"></span>
    <span class="stat">{device.clients.length} client{device.clients.length !== 1 ? 's' : ''}</span>
    {#if device.mode === 'http' && device.bridgeInfo}
      <span class="dot"></span>
      <span class="stat">{device.bridgeInfo.mode}</span>
    {/if}
  </div>
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
  .dot {
    width: 4px;
    height: 4px;
    border-radius: 50%;
    background: #333;
  }
</style>
