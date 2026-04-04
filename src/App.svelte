<script lang="ts">
  import ConnectionPicker from './components/ConnectionPicker.svelte'
  import StatusBar from './components/StatusBar.svelte'
  import MasterList from './components/MasterList.svelte'
  import ClientList from './components/ClientList.svelte'
  import Provision from './components/Provision.svelte'
  import DangerZone from './components/DangerZone.svelte'
  import OtaUpdate from './components/OtaUpdate.svelte'
  import LogMonitor from './components/LogMonitor.svelte'
  import Settings from './components/Settings.svelte'

  let currentTab = $state<'masters' | 'clients' | 'provision' | 'firmware' | 'logs' | 'settings' | 'danger'>('masters')
</script>

<svelte:head>
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin="anonymous" />
  <link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;600;700&display=swap" rel="stylesheet" />
</svelte:head>

<main>
  <header>
    <div class="brand">
      <h1>SAPWOOD</h1>
      <span class="divider"></span>
      <p class="tagline">SHAPE YOUR SIGNER</p>
    </div>
  </header>

  <ConnectionPicker />
  <StatusBar />

  <nav>
    <button class:active={currentTab === 'masters'} onclick={() => currentTab = 'masters'}>
      Masters
    </button>
    <button class:active={currentTab === 'clients'} onclick={() => currentTab = 'clients'}>
      Clients
    </button>
    <button class:active={currentTab === 'provision'} onclick={() => currentTab = 'provision'}>
      Provision
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
    {#if currentTab === 'masters'}
      <MasterList />
    {:else if currentTab === 'clients'}
      <ClientList />
    {:else if currentTab === 'provision'}
      <Provision />
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
  }

  .brand {
    display: flex;
    align-items: baseline;
    gap: 1rem;
  }

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

  nav {
    display: flex;
    gap: 0;
    margin: 1.5rem 0;
    border-bottom: 2px solid var(--border);
    overflow-x: auto;
  }

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
</style>
