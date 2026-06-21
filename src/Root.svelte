<script lang="ts">
  import { router } from './lib/route.svelte.js'
  import App from './App.svelte'
  import Flasher from './Flasher.svelte'
</script>

{#if router.route === 'flash'}
  <Flasher />
{:else}
  <App />
{/if}
