<script lang="ts">
  import { device, refreshMasters } from '../lib/device.svelte.js'

  const MODE_LABELS: Record<number, string> = {
    0: 'BUNKER',
    1: 'TREE-MNEMONIC',
    2: 'TREE-NSEC',
  }
</script>

<div class="master-list">
  <div class="header-row">
    <h2>Provisioned Masters</h2>
    {#if device.connected}
      <button class="btn-refresh" onclick={() => refreshMasters()}>Refresh</button>
    {/if}
  </div>

  {#if !device.connected}
    <p class="empty">Connect to view masters.</p>
  {:else if device.masters.length === 0}
    <p class="empty">No masters provisioned.</p>
  {:else}
    {#each device.masters as master}
      <div class="card">
        <div class="card-header">
          <span class="slot">SLOT {master.slot}</span>
          <span class="mode">{MODE_LABELS[master.mode] ?? `MODE ${master.mode}`}</span>
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
    margin-bottom: 1.5rem;
  }

  h2 {
    font-size: 1.3rem;
    font-weight: 600;
    margin: 0;
    color: #fff;
  }

  .btn-refresh {
    background: transparent;
    border: 1px solid var(--border-bright);
    color: var(--text-dim);
    padding: 0.4rem 1rem;
    border-radius: 4px;
    font-family: inherit;
    font-size: 0.85rem;
    cursor: pointer;
  }
  .btn-refresh:hover { color: var(--text); border-color: #444; }

  .card {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 1.25rem 1.5rem;
    margin-bottom: 0.75rem;
  }

  .card-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 0.5rem;
  }

  .slot {
    font-weight: 700;
    color: var(--green);
    font-size: 1rem;
    letter-spacing: 0.08em;
  }

  .mode {
    font-size: 0.8rem;
    color: var(--text-muted);
    letter-spacing: 0.1em;
  }

  .label {
    font-size: 1.2rem;
    font-weight: 500;
    color: #fff;
    margin-bottom: 0.5rem;
  }

  .npub {
    font-size: 0.85rem;
    color: var(--text-dim);
    word-break: break-all;
    line-height: 1.4;
  }

  .empty { color: var(--text-muted); font-size: 1rem; }
</style>
