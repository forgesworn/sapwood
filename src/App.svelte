<script lang="ts">
  import ConnectionPicker from './components/ConnectionPicker.svelte'
  import StatusBar from './components/StatusBar.svelte'
  import Home from './components/Home.svelte'
  import Cockpit from './components/Cockpit.svelte'
  import { device } from './lib/device.svelte.js'
  import { importNotice, pendingImport, confirmPendingImport, dismissPendingImport } from './lib/import-link.svelte.js'
  import { nip19 } from 'nostr-tools'

  // Short, recognisable npub for the overwrite confirmation (first/last chars).
  function shortNpub(pubHex: string): string {
    try {
      const npub = nip19.npubEncode(pubHex)
      return `${npub.slice(0, 12)}…${npub.slice(-6)}`
    } catch {
      return pubHex.slice(0, 10) + '…'
    }
  }

  // Two connected surfaces: the guided Home (default) and the advanced console.
  let view = $state<'home' | 'advanced'>('home')
  // Which console section to land on — Home's nudges deep-link (e.g. firmware → device).
  let advancedTab = $state<'apps' | 'identity' | 'device' | 'logs'>('apps')

  function openAdvanced(tab?: 'apps' | 'identity' | 'device' | 'logs') {
    advancedTab = tab ?? 'apps'
    view = 'advanced'
  }

  // A fresh connection always lands on Home, never deep inside the console.
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
        <button class="header-link" onclick={() => openAdvanced()}>Advanced ⚙</button>
      {:else}
        <button class="header-link" onclick={() => (view = 'home')}>← Home</button>
      {/if}
    {/if}
  </header>

  {#if pendingImport.link}
    <div class="import-confirm" role="alertdialog" aria-labelledby="import-confirm-title">
      <h2 id="import-confirm-title">Replace your operator key?</h2>
      <p>
        This link wants to switch you to a different operator key. If you continue, the key
        you currently manage signers with is <strong>replaced and lost</strong> — any signer
        set up with it would need re-flashing.
      </p>
      <dl class="key-compare">
        <div><dt>Current</dt><dd>{shortNpub(pendingImport.currentPubHex)}</dd></div>
        <div><dt>From this link</dt><dd>{shortNpub(pendingImport.incomingPubHex)}</dd></div>
      </dl>
      <div class="import-confirm-actions">
        <button class="btn btn-secondary" onclick={dismissPendingImport}>Keep my key</button>
        <button class="btn btn-danger-solid" onclick={confirmPendingImport}>Replace it</button>
      </div>
    </div>
  {/if}

  {#if importNotice.shown}
    <div class="import-banner" role="status">
      <span>Operator key loaded — you can manage this signer from here.</span>
      <button class="import-dismiss" onclick={() => (importNotice.shown = false)} aria-label="Dismiss">×</button>
    </div>
  {/if}

  <!-- On the connected Home the signer card owns the connection state + Disconnect,
       so the picker only shows when disconnected or in the Advanced cockpit. -->
  {#if !device.connected || view === 'advanced'}
    <ConnectionPicker />
  {/if}

  {#if device.connected}
    {#if view === 'advanced'}
      <StatusBar />
      <Cockpit initialTab={advancedTab} />
    {:else}
      <Home onadvanced={openAdvanced} />
    {/if}
  {/if}

  <p class="version">Sapwood v{__APP_VERSION__}</p>
</main>

<style>
  main {
    max-width: 1100px;
    margin: 0 auto;
    padding: 2.25rem 2.5rem;
  }

  .version {
    text-align: center;
    font-size: 0.7rem;
    color: var(--text-muted);
    margin: 2rem 0 0;
    letter-spacing: 0.05em;
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

  .import-confirm {
    background: #140b06; border: 1px solid var(--red, #ef4444); border-radius: 6px;
    padding: 1rem 1.1rem; margin-bottom: 1rem; color: var(--text);
  }
  .import-confirm h2 { margin: 0 0 0.5rem; font-size: 1rem; color: #fff; }
  .import-confirm p { margin: 0 0 0.8rem; font-size: 0.85rem; color: var(--text-dim); line-height: 1.55; }
  .import-confirm p strong { color: var(--red, #ef4444); }
  .key-compare { margin: 0 0 1rem; display: grid; gap: 0.35rem; }
  .key-compare div { display: flex; justify-content: space-between; gap: 1rem; font-size: 0.82rem; }
  .key-compare dt { color: var(--text-muted); margin: 0; }
  .key-compare dd { margin: 0; color: var(--text); font-variant-numeric: tabular-nums; word-break: break-all; }
  .import-confirm-actions { display: flex; gap: 0.6rem; justify-content: flex-end; }
  .btn-danger-solid { background: var(--red, #ef4444); color: #150505; border-color: var(--red, #ef4444); }
  .btn-danger-solid:hover:not(:disabled) { filter: brightness(1.1); }

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
