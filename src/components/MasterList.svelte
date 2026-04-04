<script lang="ts">
  import { device, refreshMasters } from '../lib/device.svelte.js'

  const MODE_LABELS: Record<number, string> = {
    0: 'bunker',
    1: 'tree-mnemonic',
    2: 'tree-nsec',
  }
</script>

<div class="master-list">
  <div class="header-row">
    <h2>Provisioned Masters</h2>
    {#if device.connected}
      <button class="refresh" onclick={() => refreshMasters()}>Refresh</button>
    {/if}
  </div>

  {#if !device.connected}
    <p class="muted">Connect to view masters.</p>
  {:else if device.masters.length === 0}
    <p class="muted">No masters provisioned.</p>
  {:else}
    {#each device.masters as master}
      <div class="master-card">
        <div class="master-header">
          <span class="slot">Slot {master.slot}</span>
          <span class="mode">{MODE_LABELS[master.mode] ?? `mode ${master.mode}`}</span>
        </div>
        {#if master.label}
          <div class="label">{master.label}</div>
        {/if}
        <div class="npub">{master.npub}</div>
      </div>
    {/each}
  {/if}
</div>

<style>
  .header-row {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 1rem;
  }

  h2 { font-size: 1rem; font-weight: 600; margin: 0; color: #ccc; }

  .refresh {
    background: none;
    border: 1px solid #333;
    color: #666;
    padding: 0.15rem 0.5rem;
    border-radius: 3px;
    font-family: inherit;
    font-size: 0.7rem;
    cursor: pointer;
  }

  .refresh:hover { color: #aaa; border-color: #555; }

  .master-card {
    background: #111;
    border: 1px solid #222;
    border-radius: 4px;
    padding: 0.75rem;
    margin-bottom: 0.5rem;
  }

  .master-header { display: flex; justify-content: space-between; margin-bottom: 0.25rem; }
  .slot { font-weight: 600; color: #4a9; font-size: 0.85rem; }
  .mode { color: #666; font-size: 0.75rem; }
  .label { color: #aaa; font-size: 0.85rem; margin-bottom: 0.25rem; }
  .npub { font-size: 0.7rem; color: #555; word-break: break-all; }
  .muted { color: #555; font-size: 0.85rem; }
</style>
