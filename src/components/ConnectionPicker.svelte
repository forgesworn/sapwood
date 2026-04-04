<script lang="ts">
  import { device, connect, disconnect } from '../lib/device.svelte.js'
</script>

<div class="connection">
  {#if device.connected}
    <span class="dot connected"></span>
    <span class="info">{device.portInfo}</span>
    <button class="btn disconnect" onclick={() => disconnect()}>Disconnect</button>
  {:else}
    <span class="dot disconnected"></span>
    <button class="btn connect" onclick={() => connect()}>Connect USB</button>
    {#if !('serial' in navigator)}
      <span class="warning">Web Serial not supported. Use Chrome or Edge.</span>
    {/if}
  {/if}
  {#if device.error}
    <span class="error">{device.error}</span>
  {/if}
</div>

<style>
  .connection {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.5rem 0.75rem;
    background: #111;
    border-radius: 4px;
    font-size: 0.8rem;
    flex-wrap: wrap;
  }

  .dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    flex-shrink: 0;
  }

  .dot.connected { background: #4a9; }
  .dot.disconnected { background: #555; }

  .info { color: #888; }

  .btn {
    background: #1a1a1a;
    border: 1px solid #333;
    color: #ccc;
    padding: 0.25rem 0.75rem;
    border-radius: 3px;
    font-family: inherit;
    font-size: 0.8rem;
    cursor: pointer;
    transition: background 0.15s;
  }

  .btn:hover { background: #222; }
  .btn.connect { border-color: #4a9; color: #4a9; }
  .btn.disconnect { border-color: #633; color: #a44; }

  .warning { color: #a93; font-size: 0.75rem; }
  .error { color: #a44; font-size: 0.75rem; width: 100%; margin-top: 0.25rem; }
</style>
