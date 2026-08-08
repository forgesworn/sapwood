<script lang="ts">
  import { router } from './lib/route.svelte.js'
  import type { Route } from './lib/route.svelte.js'
  import type { Component } from 'svelte'

  const routes = {
    admin: () => import('./App.svelte'),
    flash: () => import('./Flasher.svelte'),
  } satisfies Record<Route, () => Promise<{ default: Component }>>

  let RouteComponent = $state<Component | null>(null)
  let routeError = $state('')
  let loadSeq = 0

  $effect(() => {
    const seq = ++loadSeq
    routeError = ''
    RouteComponent = null
    void routes[router.route]().then((mod) => {
      if (seq === loadSeq) RouteComponent = mod.default
    }).catch((e) => {
      if (seq === loadSeq) routeError = e instanceof Error ? e.message : 'Route failed to load'
    })
  })
</script>

{#if routeError}
  <main class="route-loading" role="alert">
    <p>Could not load Sapwood.</p>
    <button class="btn btn-secondary btn-sm" onclick={() => location.reload()}>Reload</button>
  </main>
{:else if RouteComponent}
  <RouteComponent />
{:else}
  <main class="route-loading" aria-busy="true">
    <p>Loading Sapwood…</p>
  </main>
{/if}

<style>
  .route-loading {
    min-height: 100vh;
    min-height: 100dvh;
    display: grid;
    place-content: center;
    gap: 1rem;
    color: var(--text-muted);
    font-size: 0.9rem;
    text-align: center;
  }
  .route-loading p { margin: 0; }
</style>
