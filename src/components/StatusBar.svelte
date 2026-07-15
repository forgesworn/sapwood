<script lang="ts">
  import { device } from '../lib/device.svelte.js'

  const identityCount = $derived(device.masters.filter((m) => !m.persona).length)
  // App connections live per identity, so the true total is the sum across
  // masters (reported by current firmware). Older firmware omits the counts;
  // fall back to the selected identity's table rather than claiming a total.
  const counted = $derived(device.masters.filter((m) => !m.persona && typeof m.apps === 'number'))
  const appCount = $derived(counted.length > 0
    ? counted.reduce((sum, m) => sum + (m.apps ?? 0), 0)
    : device.slots.length)
</script>

{#if device.connected && device.masters.length > 0}
  <div class="status-bar">
    <span class="stat">{identityCount} identit{identityCount !== 1 ? 'ies' : 'y'}</span>
    <span class="dot"></span>
    <span class="stat">{appCount} app{appCount !== 1 ? 's' : ''}</span>
    {#if device.mode === 'http' && device.bridgeInfo}
      <span class="dot"></span>
      <span class="stat">{device.bridgeInfo.mode}</span>
    {/if}
  </div>
{:else if device.connected && device.error}
  <div class="card card--warn status-error">⚠ {device.error}</div>
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
    word-break: break-word;
  }
  .dot {
    width: 4px;
    height: 4px;
    border-radius: 50%;
    background: #333;
  }
</style>
