<script lang="ts">
  // Add/remove editor for a relay list, with one-tap suggestions from the
  // ecosystem set. Pure control: the caller owns the list and validation of
  // the whole (e.g. "at least one"); this validates only what's being added.
  import { probeRelays, type RelayProbe } from '../lib/relay-health.js'

  interface Props {
    relays: string[]
    /** Offered as one-tap additions when not already listed. */
    suggestions?: readonly string[]
    disabled?: boolean
    /** Show live reachability dots and a Check button (signer relays). */
    showHealth?: boolean
    onchange: (relays: string[]) => void
  }
  let { relays, suggestions = [], disabled = false, showHealth = false, onchange }: Props = $props()

  let input = $state('')
  let error = $state<string | null>(null)

  const available = $derived(suggestions.filter((s) => !relays.includes(s)))

  // A ws:// relay is cleartext Nostr: payloads stay NIP-44-encrypted, but the
  // network path sees the metadata. Legitimate on your own LAN — flag anything
  // else loudly before it gets flashed onto the signer.
  const insecure = $derived(relays.filter((r) => /^ws:\/\//i.test(r)))

  // Live reachability, keyed by URL — advisory, from this browser (a signer on
  // another network may fare differently, but a dead relay here is a red flag).
  let health = $state<Record<string, RelayProbe>>({})
  let checking = $state(false)
  async function checkHealth() {
    checking = true
    try {
      const probes = await probeRelays(relays)
      const next: Record<string, RelayProbe> = {}
      for (const p of probes) next[p.url] = p
      health = next
    } finally {
      checking = false
    }
  }
  $effect(() => {
    if (showHealth && relays.join(',')) void checkHealth()
  })
  function dotTitle(p: RelayProbe | undefined): string {
    if (!p) return 'Checking…'
    const ms = p.ms !== null ? ` (${p.ms} ms)` : ''
    if (p.health === 'green') return `Reachable and fast${ms}`
    if (p.health === 'amber') return `Reachable but slow${ms}`
    return `Not reachable from this browser${p.note ? `: ${p.note}` : ''}`
  }

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
  {#if showHealth && relays.length}
    <div class="health-head">
      <span class="health-legend">
        <span class="health-dot health-green"></span> fast
        <span class="health-dot health-amber"></span> slow
        <span class="health-dot health-red"></span> unreachable
      </span>
      <button type="button" class="btn btn-secondary btn-sm" disabled={checking} onclick={checkHealth}>
        {checking ? 'Checking…' : 'Check health'}
      </button>
    </div>
  {/if}
  {#each relays as relay, i (relay)}
    <div class="relay-row">
      {#if showHealth}
        <span class="health-dot health-{health[relay]?.health ?? 'unknown'}" title={dotTitle(health[relay])}></span>
      {/if}
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
  {#if insecure.length}
    <p class="warn-text">
      <strong>{insecure.join(', ')}</strong> uses <code>ws://</code>, which is not encrypted.
      Message contents stay end-to-end encrypted, but anyone on the network path can see the
      signer's traffic and when it talks. Use <code>ws://</code> only for a relay on your own network.
    </p>
  {/if}
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
  @media (pointer: coarse) {
    .suggestion { padding: 0.5rem 0.75rem; }
  }
  .suggestion:disabled { opacity: 0.4; cursor: not-allowed; }
  .add-row { display: flex; gap: 0.4rem; align-items: center; margin-top: 0.2rem; }
  .add-row input { flex: 1; padding: 0.4rem 0.6rem; font-size: 0.82rem; }

  .health-head { display: flex; align-items: center; justify-content: space-between; gap: 0.75rem; margin-bottom: 0.15rem; }
  .health-legend { display: flex; align-items: center; gap: 0.3rem; font-size: 0.72rem; color: var(--text-muted); }
  .health-legend .health-dot { margin-left: 0.5rem; }
  .health-dot { width: 9px; height: 9px; border-radius: 50%; flex-shrink: 0; background: #444; display: inline-block; }
  .health-green { background: var(--green); box-shadow: var(--green-glow); }
  .health-amber { background: var(--amber); }
  .health-red { background: var(--red); }
  .health-unknown { background: #444; }
</style>
