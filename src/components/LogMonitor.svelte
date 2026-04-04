<script lang="ts">
  import { device } from '../lib/device.svelte.js'

  let autoScroll = $state(true)
  let logEl: HTMLPreElement

  $effect(() => {
    // Auto-scroll when new logs arrive.
    if (autoScroll && logEl && device.logs.length > 0) {
      logEl.scrollTop = logEl.scrollHeight
    }
  })

  function handleScroll() {
    if (!logEl) return
    const atBottom = logEl.scrollHeight - logEl.scrollTop - logEl.clientHeight < 20
    autoScroll = atBottom
  }

  function clearLogs() {
    device.logs = []
  }
</script>

<div class="log-monitor">
  <div class="header-row">
    <h2>Device Log</h2>
    <div class="controls">
      <span class="count">{device.logs.length} lines</span>
      <button class="btn" onclick={clearLogs}>Clear</button>
    </div>
  </div>

  <pre class="log" bind:this={logEl} onscroll={handleScroll}>
    {#if device.logs.length === 0}
      <span class="muted">{device.connected ? 'No log output yet.' : 'Connect to view logs.'}</span>
    {:else}
      {#each device.logs as line}
{line}
{/each}
    {/if}
  </pre>

  {#if !autoScroll && device.logs.length > 0}
    <button class="scroll-btn" onclick={() => { autoScroll = true }}>
      Scroll to bottom
    </button>
  {/if}
</div>

<style>
  .header-row { display: flex; justify-content: space-between; align-items: center; margin-bottom: 0.5rem; }
  h2 { font-size: 1rem; font-weight: 600; margin: 0; color: #ccc; }
  .controls { display: flex; gap: 0.5rem; align-items: center; }
  .count { font-size: 0.7rem; color: #555; }

  .btn {
    background: none; border: 1px solid #333; color: #666;
    padding: 0.15rem 0.5rem; border-radius: 3px;
    font-family: inherit; font-size: 0.7rem; cursor: pointer;
  }
  .btn:hover { color: #aaa; border-color: #555; }

  .log {
    background: #0a0a0a;
    border: 1px solid #1a1a1a;
    border-radius: 4px;
    padding: 0.5rem;
    height: 300px;
    overflow-y: auto;
    font-size: 0.7rem;
    line-height: 1.4;
    color: #888;
    margin: 0;
    white-space: pre-wrap;
    word-break: break-all;
  }

  .muted { color: #444; }

  .scroll-btn {
    display: block;
    margin: 0.25rem auto 0;
    background: #111;
    border: 1px solid #333;
    color: #666;
    padding: 0.2rem 0.75rem;
    border-radius: 3px;
    font-family: inherit;
    font-size: 0.7rem;
    cursor: pointer;
  }
</style>
