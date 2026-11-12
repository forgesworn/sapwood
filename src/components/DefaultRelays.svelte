<script lang="ts">
  // The owner's default relay set for new Heartwoods, kept per Sapwood install.
  // Every place that proposes a relay list to a signer starts from it; each
  // signer keeps its own list on the board and can be reset to this set.
  import {
    DEFAULT_SIGNER_RELAYS, SUGGESTED_SIGNER_RELAYS, clearDefaultSignerRelays,
    defaultSignerRelays, hasOwnDefaultRelays, sameRelayOrder, setDefaultSignerRelays,
  } from '../lib/wizard.js'
  import RelayEditor from './RelayEditor.svelte'

  let saved = $state(defaultSignerRelays())
  let draft = $state(defaultSignerRelays())
  let own = $state(hasOwnDefaultRelays())
  let message = $state('')

  const dirty = $derived(!sameRelayOrder(draft, saved))
  const isBuiltIn = $derived(sameRelayOrder(saved, DEFAULT_SIGNER_RELAYS))

  function edit(next: string[]) {
    draft = next
    message = ''
  }

  function save() {
    if (!draft.length) return
    saved = setDefaultSignerRelays(draft)
    draft = [...saved]
    own = true
    message = 'Saved. New Heartwoods start with these relays.'
  }

  function useBuiltIn() {
    clearDefaultSignerRelays()
    saved = defaultSignerRelays()
    draft = [...saved]
    own = false
    message = 'Sapwood\'s built-in relays are your default again.'
  }
</script>

<details class="disclosure default-relays">
  <summary>Default relays for new Heartwoods</summary>
  <p class="hint-sm">
    New Heartwoods start with these relays, in this order. Each Heartwood keeps its own list:
    Reset to default in its relay editor brings it back to this set. Saved in this browser.
  </p>
  <RelayEditor relays={draft} suggestions={SUGGESTED_SIGNER_RELAYS} onchange={edit} />
  {#if !draft.length}<p class="error-text">Keep at least one relay.</p>{/if}
  <div class="actions">
    <button type="button" class="btn btn-secondary btn-sm" disabled={!dirty || !draft.length} onclick={save}>
      Save defaults
    </button>
    {#if dirty}
      <button type="button" class="btn-link" onclick={() => edit([...saved])}>Discard changes</button>
    {/if}
    {#if own}
      <button type="button" class="btn-link" onclick={useBuiltIn}>
        {isBuiltIn ? 'Follow Sapwood\'s built-in set' : 'Use Sapwood\'s built-in set'}
      </button>
    {/if}
  </div>
  {#if message}<p class="hint-sm">{message}</p>{/if}
</details>

<style>
  .default-relays { display: flex; flex-direction: column; gap: 0.6rem; }
  .default-relays > p { margin: 0.4rem 0; }
  .actions { display: flex; flex-wrap: wrap; align-items: center; gap: 0.75rem; margin-top: 0.4rem; }
</style>
