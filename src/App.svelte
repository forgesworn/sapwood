<script lang="ts">
  import ConnectionPicker from './components/ConnectionPicker.svelte'
  import StatusBar from './components/StatusBar.svelte'
  import MasterList from './components/MasterList.svelte'
  import ClientList from './components/ClientList.svelte'
  import FactoryReset from './components/FactoryReset.svelte'
  import OtaUpdate from './components/OtaUpdate.svelte'
  import LogMonitor from './components/LogMonitor.svelte'

  let currentTab = $state<'masters' | 'clients' | 'firmware' | 'logs' | 'danger'>('masters')
</script>

<main>
  <header>
    <h1>Sapwood</h1>
    <p class="tagline">Shape your signer</p>
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
    <button class:active={currentTab === 'firmware'} onclick={() => currentTab = 'firmware'}>
      Firmware
    </button>
    <button class:active={currentTab === 'logs'} onclick={() => currentTab = 'logs'}>
      Logs
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
    {:else if currentTab === 'firmware'}
      <OtaUpdate />
    {:else if currentTab === 'logs'}
      <LogMonitor />
    {:else if currentTab === 'danger'}
      <FactoryReset />
    {/if}
  </section>

  <footer>
    <a href="https://github.com/nicorache/esptool-js" target="_blank" rel="noopener">
      First-time flash? Use WebSerial ESPTool.
    </a>
  </footer>
</main>

<style>
  :global(body) {
    margin: 0;
    font-family: 'SF Mono', 'Fira Code', 'JetBrains Mono', monospace;
    background: #0a0a0a;
    color: #e0e0e0;
    line-height: 1.5;
  }

  main {
    max-width: 720px;
    margin: 0 auto;
    padding: 1.5rem;
  }

  header {
    margin-bottom: 1rem;
    border-bottom: 1px solid #222;
    padding-bottom: 0.75rem;
  }

  h1 { margin: 0; font-size: 1.5rem; font-weight: 600; color: #fff; }
  .tagline { margin: 0.25rem 0 0; font-size: 0.8rem; color: #666; }

  nav {
    display: flex;
    gap: 0;
    margin: 0.75rem 0;
    border-bottom: 1px solid #222;
  }

  nav button {
    background: none;
    border: none;
    border-bottom: 2px solid transparent;
    color: #666;
    padding: 0.5rem 1rem;
    font-family: inherit;
    font-size: 0.85rem;
    cursor: pointer;
    transition: color 0.15s, border-color 0.15s;
  }

  nav button:hover { color: #aaa; }
  nav button.active { color: #e0e0e0; border-bottom-color: #4a9; }
  nav button.danger-tab.active { border-bottom-color: #a44; }

  .panel { min-height: 300px; padding-top: 0.5rem; }

  footer {
    margin-top: 2rem;
    padding-top: 1rem;
    border-top: 1px solid #1a1a1a;
    text-align: center;
    font-size: 0.7rem;
  }

  footer a { color: #555; text-decoration: none; }
  footer a:hover { color: #888; }
</style>
