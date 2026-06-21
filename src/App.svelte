<script lang="ts">
  import ConnectionPicker from './components/ConnectionPicker.svelte'
  import StatusBar from './components/StatusBar.svelte'
  import Home from './components/Home.svelte'
  import Cockpit from './components/Cockpit.svelte'
  import { device } from './lib/device.svelte.js'
  import { navigate } from './lib/route.svelte.js'
  import { importNotice } from './lib/import-link.svelte.js'

  // Two connected surfaces: the guided Home (default) and the advanced cockpit.
  let view = $state<'home' | 'advanced'>('home')

  // A fresh connection always lands on Home, never deep inside the cockpit.
  $effect(() => { if (!device.connected) view = 'home' })

  const showBottomNav = $derived(device.connected && view === 'advanced')
</script>

<main class:has-bottom-nav={showBottomNav}>
  <header>
    <div class="brand">
      <h1>SAPWOOD</h1>
      <span class="divider"></span>
      <p class="tagline">SHAPE YOUR SIGNER</p>
    </div>
    {#if device.connected}
      {#if view === 'home'}
        <button class="header-link" onclick={() => (view = 'advanced')}>Advanced ⚙</button>
      {:else}
        <button class="header-link" onclick={() => (view = 'home')}>← Home</button>
      {/if}
    {:else}
      <button class="header-link" onclick={() => navigate('flash')}>Set up a new device →</button>
    {/if}
  </header>

  {#if importNotice.shown}
    <div class="import-banner" role="status">
      <span>Operator key loaded — you can manage this signer from here.</span>
      <button class="import-dismiss" onclick={() => (importNotice.shown = false)} aria-label="Dismiss">×</button>
    </div>
  {/if}

  <ConnectionPicker />

  {#if device.connected}
    {#if view === 'advanced'}
      <!-- The cockpit speaks the technical language (masters, clients, slots). -->
      <StatusBar />
      <Cockpit />
    {:else}
      <Home onadvanced={() => (view = 'advanced')} />
    {/if}
  {/if}
</main>

<style>
  :global(*) {
    box-sizing: border-box;
  }

  :global(body) {
    margin: 0;
    font-family: 'JetBrains Mono', 'SF Mono', 'Fira Code', monospace;
    background: #050505;
    color: #e8e8e8;
    line-height: 1.6;
    font-size: 16px;
    -webkit-font-smoothing: antialiased;
  }

  :global(:root) {
    --green: #00e87b;
    --green-dim: #00a858;
    --green-glow: 0 0 12px rgba(0, 232, 123, 0.3);
    --red: #ff4444;
    --red-dim: #cc2222;
    --amber: #ffaa00;
    --surface: #0c0c0c;
    --surface-raised: #131313;
    --surface-hover: #1a1a1a;
    --border: #1e1e1e;
    --border-bright: #2a2a2a;
    --text: #e8e8e8;
    --text-dim: #888;
    --text-muted: #555;
  }

  main {
    max-width: 860px;
    margin: 0 auto;
    padding: 2rem 2.5rem;
  }

  header {
    margin-bottom: 2rem;
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 1rem;
    flex-wrap: wrap;
  }

  .brand {
    display: flex;
    align-items: baseline;
    gap: 1rem;
  }

  .header-link {
    background: none;
    border: none;
    padding: 0;
    font-family: inherit;
    font-size: 0.8rem;
    color: var(--green-dim);
    cursor: pointer;
    white-space: nowrap;
  }
  .header-link:hover { color: var(--green); }

  .import-banner {
    display: flex; align-items: center; justify-content: space-between; gap: 1rem;
    background: #06120e; border: 1px solid var(--green-dim); border-radius: 6px;
    padding: 0.7rem 1rem; margin-bottom: 1rem; color: var(--green); font-size: 0.85rem;
  }
  .import-dismiss {
    background: none; border: none; color: var(--text-dim); font-size: 1.2rem;
    line-height: 1; cursor: pointer; padding: 0 0.25rem; flex-shrink: 0;
  }
  .import-dismiss:hover { color: var(--text); }

  h1 {
    margin: 0;
    font-size: 2.2rem;
    font-weight: 700;
    color: #fff;
    letter-spacing: 0.15em;
  }

  .divider {
    width: 2px;
    height: 1.4rem;
    background: var(--green);
    box-shadow: var(--green-glow);
    align-self: center;
  }

  .tagline {
    margin: 0;
    font-size: 0.85rem;
    font-weight: 500;
    color: var(--green-dim);
    letter-spacing: 0.2em;
  }

  /* Mobile-first: tighten the shell. The advanced cockpit docks a fixed tab bar
     to the bottom, so reserve room for it only in that view. */
  @media (max-width: 640px) {
    main { padding: 1.25rem 1rem; }
    main.has-bottom-nav { padding-bottom: 5.5rem; }
    h1 { font-size: 1.5rem; letter-spacing: 0.08em; }
    .divider { height: 1rem; }
    .tagline { font-size: 0.68rem; }
    .header-link { font-size: 0.72rem; }
  }
</style>
