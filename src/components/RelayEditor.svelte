<script lang="ts">
  // Add/remove editor for a relay list, with one-tap suggestions from the
  // ecosystem set. Pure control: the caller owns the list and validation of
  // the whole (e.g. "at least one"); this validates only what's being added.
  interface Props {
    relays: string[]
    /** Offered as one-tap additions when not already listed. */
    suggestions?: readonly string[]
    disabled?: boolean
    onchange: (relays: string[]) => void
  }
  let { relays, suggestions = [], disabled = false, onchange }: Props = $props()

  let input = $state('')
  let error = $state<string | null>(null)

  const available = $derived(suggestions.filter((s) => !relays.includes(s)))

  function shortName(url: string): string {
    return url.replace(/^wss?:\/\//i, '').replace(/\/$/, '')
  }

  function add(url: string) {
    const clean = url.trim()
    if (!/^wss?:\/\/.+/i.test(clean)) {
      error = 'A relay address starts with wss:// (or ws:// on your own network).'
      return
    }
    if (relays.includes(clean)) {
      error = 'That relay is already listed.'
      return
    }
    error = null
    input = ''
    onchange([...relays, clean])
  }

  function remove(index: number) {
    error = null
    onchange(relays.filter((_, i) => i !== index))
  }
</script>

<div class="relay-editor">
  {#each relays as relay, i (relay)}
    <div class="relay-row">
      <span class="mono relay-url">{relay}</span>
      <button type="button" class="btn btn-secondary btn-sm" {disabled} onclick={() => remove(i)}>Remove</button>
    </div>
  {/each}

  {#if available.length}
    <div class="suggestions">
      {#each available as s (s)}
        <button type="button" class="suggestion" {disabled} onclick={() => add(s)}>+ {shortName(s)}</button>
      {/each}
    </div>
  {/if}

  <div class="add-row">
    <input
      type="text"
      class="field-input"
      bind:value={input}
      placeholder="wss://relay.example.com"
      spellcheck="false"
      autocomplete="off"
      {disabled}
      onkeydown={(e) => { if (e.key === 'Enter') { e.preventDefault(); add(input) } }}
    />
    <button type="button" class="btn btn-secondary btn-sm" disabled={disabled || !input.trim()} onclick={() => add(input)}>Add</button>
  </div>
  {#if error}<p class="error-text">{error}</p>{/if}
</div>

<style>
  .relay-editor { display: flex; flex-direction: column; gap: 0.4rem; }
  .relay-row { display: flex; align-items: center; justify-content: space-between; gap: 0.5rem; }
  .relay-url { flex: 1; }
  .suggestions { display: flex; flex-wrap: wrap; gap: 0.4rem; margin-top: 0.2rem; }
  .suggestion {
    background: var(--surface); border: 1px solid var(--border); border-radius: 4px;
    padding: 0.3rem 0.65rem; font-family: inherit; font-size: 0.78rem; color: var(--text-dim);
    cursor: pointer; transition: all 0.12s;
  }
  .suggestion:hover:not(:disabled) { border-color: var(--green-dim); color: var(--green); }
  .suggestion:disabled { opacity: 0.4; cursor: not-allowed; }
  .add-row { display: flex; gap: 0.4rem; align-items: center; margin-top: 0.2rem; }
  .add-row input { flex: 1; padding: 0.4rem 0.6rem; font-size: 0.82rem; }
</style>
