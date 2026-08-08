<script lang="ts">
  // The advanced console — four plain-English sections, one tap from Home:
  //   Apps      — manage what's connected and what it may sign
  //   Identity  — identities on the signer, operator key, profile
  //   Device    — connection, network, firmware, security, danger zone
  //   Logs      — live output from the board
  import AppsPanel from './AppsPanel.svelte'
  import IdentityPanel from './IdentityPanel.svelte'
  import DevicePanel from './DevicePanel.svelte'
  import LogMonitor from './LogMonitor.svelte'

  type Tab = 'apps' | 'identity' | 'device' | 'logs'
  interface Props {
    /** Which section to open on — Home's nudges deep-link here (e.g. firmware → device). */
    initialTab?: Tab
  }
  let { initialTab = 'apps' }: Props = $props()

  // svelte-ignore state_referenced_locally — the initial tab is read once by design;
  // the console remounts whenever Home hands over, so it always lands correctly.
  let currentTab = $state<Tab>(initialTab)
</script>

<nav>
  <button class:active={currentTab === 'apps'} onclick={() => currentTab = 'apps'}>
    Apps
  </button>
  <button class:active={currentTab === 'identity'} onclick={() => currentTab = 'identity'}>
    Identity
  </button>
  <button class:active={currentTab === 'device'} onclick={() => currentTab = 'device'}>
    Device
  </button>
  <button class:active={currentTab === 'logs'} onclick={() => currentTab = 'logs'}>
    Logs
  </button>
</nav>

<section class="panel">
  {#if currentTab === 'apps'}
    <AppsPanel />
  {:else if currentTab === 'identity'}
    <IdentityPanel />
  {:else if currentTab === 'device'}
    <DevicePanel />
  {:else if currentTab === 'logs'}
    <LogMonitor />
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

  .panel {
    min-height: 400px;
    padding-top: 1.5rem;
  }

  /* Mobile-first: dock the tab bar to the bottom — the thumb zone — with
     comfortable (44px+) touch targets. Four tabs fit without scrolling. */
  @media (max-width: 640px) {
    .panel { min-height: 0; padding-top: 1.25rem; }

    nav {
      position: fixed;
      left: 0; right: 0; bottom: 0;
      margin: 0;
      padding: 0 0.5rem;
      padding-left: max(0.5rem, env(safe-area-inset-left));
      padding-right: max(0.5rem, env(safe-area-inset-right));
      padding-bottom: env(safe-area-inset-bottom, 0);
      background: var(--surface);
      border-top: 2px solid var(--border);
      border-bottom: none;
      z-index: 20;
      justify-content: space-around;
    }
    nav button { padding: 0.9rem 0.85rem; border-bottom: none; border-top: 3px solid transparent; }
    nav button.active { border-bottom-color: transparent; border-top-color: var(--green); }
  }
</style>
