<script lang="ts">
  // The advanced cockpit — the full 9-tab power surface, one tap from Home.
  // Extracted verbatim from App.svelte so the guided Home can sit in front of it.
  import MasterList from './MasterList.svelte'
  import ClientList from './ClientList.svelte'
  import RelayClients from './RelayClients.svelte'
  import { device } from '../lib/device.svelte.js'
  import Provision from './Provision.svelte'
  import DangerZone from './DangerZone.svelte'
  import OtaUpdate from './OtaUpdate.svelte'
  import LogMonitor from './LogMonitor.svelte'
  import Settings from './Settings.svelte'
  import Connectivity from './Connectivity.svelte'
  import Flash from './Flash.svelte'

  let currentTab = $state<'flash' | 'masters' | 'clients' | 'provision' | 'connectivity' | 'firmware' | 'logs' | 'settings' | 'danger'>('masters')
</script>

<nav>
  <button class:active={currentTab === 'flash'} onclick={() => currentTab = 'flash'}>
    Flash
  </button>
  <button class:active={currentTab === 'masters'} onclick={() => currentTab = 'masters'}>
    Masters
  </button>
  <button class:active={currentTab === 'clients'} onclick={() => currentTab = 'clients'}>
    Clients
  </button>
  <button class:active={currentTab === 'provision'} onclick={() => currentTab = 'provision'}>
    Provision
  </button>
  <button class:active={currentTab === 'connectivity'} onclick={() => currentTab = 'connectivity'}>
    Connectivity
  </button>
  <button class:active={currentTab === 'firmware'} onclick={() => currentTab = 'firmware'}>
    Firmware
  </button>
  <button class:active={currentTab === 'logs'} onclick={() => currentTab = 'logs'}>
    Logs
  </button>
  <button class:active={currentTab === 'settings'} onclick={() => currentTab = 'settings'}>
    Settings
  </button>
  <button class:active={currentTab === 'danger'} class="danger-tab" onclick={() => currentTab = 'danger'}>
    Danger
  </button>
</nav>

<section class="panel">
  {#if currentTab === 'flash'}
    <Flash />
  {:else if currentTab === 'masters'}
    <MasterList />
  {:else if currentTab === 'clients'}
    {#if device.mode === 'relay' || device.mode === 'serial'}
      <RelayClients />
    {:else}
      <ClientList />
    {/if}
  {:else if currentTab === 'provision'}
    <Provision />
  {:else if currentTab === 'connectivity'}
    <Connectivity />
  {:else if currentTab === 'firmware'}
    <OtaUpdate />
  {:else if currentTab === 'logs'}
    <LogMonitor />
  {:else if currentTab === 'settings'}
    <Settings />
  {:else if currentTab === 'danger'}
    <DangerZone />
  {/if}
</section>

<style>
  nav {
    display: flex;
    gap: 0;
    margin: 1.5rem 0;
    border-bottom: 2px solid var(--border);
    overflow-x: auto;
    scrollbar-width: none;
  }
  nav::-webkit-scrollbar { display: none; }

  nav button {
    background: none;
    border: none;
    border-bottom: 3px solid transparent;
    color: var(--text-muted);
    padding: 0.75rem 1.25rem;
    font-family: inherit;
    font-size: 1rem;
    font-weight: 500;
    cursor: pointer;
    transition: color 0.2s, border-color 0.2s;
    white-space: nowrap;
    letter-spacing: 0.02em;
  }

  nav button:hover {
    color: var(--text-dim);
  }

  nav button.active {
    color: #fff;
    border-bottom-color: var(--green);
  }

  nav button.danger-tab.active {
    border-bottom-color: var(--red);
  }

  .panel {
    min-height: 400px;
    padding-top: 1.5rem;
  }

  /* Mobile-first: dock the tab bar to the bottom — the thumb zone — with
     comfortable (44px+) touch targets. */
  @media (max-width: 640px) {
    .panel { min-height: 0; padding-top: 1.25rem; }

    /* Fixed bottom bar, still horizontally scrollable for all nine tabs. The
       active marker moves to the top edge so it shows above the bar. */
    nav {
      position: fixed;
      left: 0; right: 0; bottom: 0;
      margin: 0;
      padding: 0 0.5rem;
      padding-bottom: env(safe-area-inset-bottom, 0);
      background: var(--surface);
      border-top: 2px solid var(--border);
      border-bottom: none;
      z-index: 20;
    }
    nav button { padding: 0.9rem 0.85rem; border-bottom: none; border-top: 3px solid transparent; }
    nav button.active { border-bottom-color: transparent; border-top-color: var(--green); }
    nav button.danger-tab.active { border-bottom-color: transparent; border-top-color: var(--red); }
  }
</style>
