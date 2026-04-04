<script lang="ts">
  import { device } from '../lib/device.svelte.js'
</script>

{#if device.connected && device.masters.length > 0}
  <div class="status-bar">
    <span>{device.masters.length} master{device.masters.length !== 1 ? 's' : ''}</span>
    <span class="sep">&middot;</span>
    <span>{device.clients.length} client{device.clients.length !== 1 ? 's' : ''}</span>
  </div>
{/if}

<style>
  .status-bar {
    display: flex;
    gap: 0.5rem;
    padding: 0.35rem 0.75rem;
    font-size: 0.75rem;
    color: #666;
  }

  .sep { color: #333; }
</style>
