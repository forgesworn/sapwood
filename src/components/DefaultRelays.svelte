<script lang="ts">
  // The owner's default relay set for new Heartwoods, kept per Sapwood install.
  // Every place that proposes a relay list to a signer starts from it; each
  // signer keeps its own list on the board and can be reset to this set.
  import {
    DEFAULT_SIGNER_RELAYS, SUGGESTED_SIGNER_RELAYS, clearDefaultSignerRelays,
    defaultSignerRelays, hasOwnDefaultRelays, onDefaultRelaysChange, sameRelayOrder,
    setDefaultSignerRelays,
  } from '../lib/wizard.js'
  import RelayEditor from './RelayEditor.svelte'

  let saved = $state(defaultSignerRelays())
  let draft = $state(defaultSignerRelays())
  let own = $state(hasOwnDefaultRelays())
  let message = $state('')
  let saveError = $state('')

  const dirty = $derived(!sameRelayOrder(draft, saved))
  const isBuiltIn = $derived(sameRelayOrder(saved, DEFAULT_SIGNER_RELAYS))

  function edit(next: string[]) {
    draft = next
    message = ''
    saveError = ''
  }

  function save() {
    if (!draft.length) return
    let stored: string[]
    try {
      stored = setDefaultSignerRelays(draft)
    } catch (e) {
      message = ''
      saveError = e instanceof Error ? e.message : String(e)
      return
    }
    saved = stored
    draft = [...saved]
    own = true
    saveError = ''
    message = 'Saved. New Heartwoods start with these relays.'
  }

  // The defaults can change from another tab. Re-read them, and replace the
  // draft only when the owner has no unsaved edits here.
  $effect(() => onDefaultRelaysChange(() => {
    const wasClean = sameRelayOrder(draft, saved)
    saved = defaultSignerRelays()
    own = hasOwnDefaultRelays()
    if (wasClean) draft = [...saved]
  }))

  function useBuiltIn() {
    clearDefaultSignerRelays()
    saved = defaultSignerRelays()
    draft = [...saved]
    own = false
    saveError = ''
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
  {#if saveError}<p class="error-text" role="alert">{saveError}</p>{/if}
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
