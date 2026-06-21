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
  {:else if device.mode === 'relay' && device.relayStatus === null && device.error}
    <!-- Connected over the relay but get_status never came back. A wifi device
         always has a master, so this is a round-trip failure, not an empty list.
         Surface it instead of the misleading "No masters provisioned". -->
    <div class="relay-error">
      <p class="err-lead">⚠ Connected, but the device isn't answering over the relay.</p>
      <p class="err-detail">{device.error}</p>
      <p class="err-talking">Sapwood is talking to: <code>{device.portInfo}</code></p>
      <p class="err-hint">This almost always means one of two things:</p>
      <ul>
        <li><strong>Different relays.</strong> Sapwood and the device must share at least one relay. Check the device booted onto the relay shown above (its boot log prints “WiFi-standalone mode — entering relay loop”).</li>
        <li><strong>Operator-key mismatch.</strong> The device only accepts management signed by the operator key baked in when you flashed it. If this browser’s key differs (re-flashed from a different browser/machine, or storage was cleared), the device silently ignores the request.</li>
      </ul>
    </div>
  {:else if device.masters.length === 0}
    <p class="empty">No masters provisioned.</p>
  {:else}
    {#each device.masters as master}
      <div class="card">
        <div class="card-header">
          <span class="slot">SLOT {master.slot}</span>
          <span class="mode">{master.modeLabel ?? MODE_LABELS[master.mode] ?? `MODE ${master.mode}`}</span>
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

  .relay-error {
    border: 1px solid #3a2320;
    border-radius: 6px;
    padding: 1rem 1.25rem;
    background: #160c0a;
  }
  .err-lead { color: var(--amber); font-weight: 600; margin: 0 0 0.6rem; }
  .err-detail {
    font-size: 0.8rem;
    color: #c77;
    font-family: inherit;
    background: #0a0a0a;
    border-radius: 3px;
    padding: 0.4rem 0.6rem;
    margin: 0 0 0.8rem;
    word-break: break-word;
  }
  .err-talking { font-size: 0.78rem; color: var(--text-dim); margin: 0 0 0.8rem; }
  .err-talking code { color: var(--green-dim); word-break: break-all; }
  .err-hint { font-size: 0.82rem; color: var(--text-dim); margin: 0 0 0.4rem; }
  .relay-error ul { margin: 0; padding-left: 1.2rem; }
  .relay-error li { font-size: 0.8rem; color: #999; line-height: 1.5; margin-bottom: 0.5rem; }
  .relay-error strong { color: #ccc; }
</style>
