<script lang="ts">
  // Short address (NIP-05): generate the nostr.json a user hosts on their own
  // domain so clients with bunker discovery accept name@domain in place of a
  // pasted bunker:// URI. Sapwood only builds the file. Hosting stays with the
  // user: sovereignty means their domain, not ours.
  import { device } from '../lib/device.svelte.js'
  import { listKnownDevices } from '../lib/known-devices.js'
  import { buildNostrJson, isValidNip05Name, nip05Identifier } from '../lib/nip05.js'
  import { copyText } from '../lib/clipboard.js'
  import { nip19 } from 'nostr-tools'

  let name = $state('')
  let domain = $state('')
  let masterIdx = $state(0)
  let copied = $state(false)

  /** Selected identity pubkey as x-only hex, from its npub. */
  function masterHex(idx: number): string {
    const npub = device.masters[idx]?.npub ?? ''
    if (/^[0-9a-f]{64}$/i.test(npub)) return npub.toLowerCase()
    try {
      const d = nip19.decode(npub)
      if (d.type === 'npub') return d.data as string
    } catch { /* not an npub */ }
    return ''
  }

  /** Relays the signer listens on: remembered device first, last flash second. */
  function relaysFor(hex: string): string[] {
    const known = listKnownDevices().find((d) => d.pubHex === hex)
    if (known?.relays.length) return known.relays
    try {
      const saved = JSON.parse(localStorage.getItem('heartwood.lastRelays') ?? '[]')
      if (Array.isArray(saved) && saved.length) return saved
    } catch { /* none */ }
    return []
  }

  const hex = $derived(masterHex(masterIdx))
  const relays = $derived(hex ? relaysFor(hex) : [])
  const nameOk = $derived(name === '' || isValidNip05Name(name))

  const snippet = $derived.by(() => {
    if (!name || !nameOk || !hex || relays.length === 0) return ''
    try {
      return buildNostrJson(name, hex, relays)
    } catch {
      return ''
    }
  })

  const identifier = $derived(name && domain && nameOk ? nip05Identifier(name, domain) : '')

  async function copySnippet() {
    if (!snippet) return
    const ok = await copyText(snippet)
    if (ok) {
      copied = true
      setTimeout(() => { copied = false }, 1500)
    }
  }
</script>

<section>
  <details class="disclosure">
    <summary>Short address (NIP-05)</summary>
    <div class="nip05-body">
      <p class="hint">
        Some apps accept a short address like <code>you@yourdomain.com</code> in their bunker
        login field and look the signer up from a file on that domain. Generate the file here
        and host it yourself at <code>/.well-known/nostr.json</code>.
      </p>

      {#if !device.connected || device.masters.length === 0}
        <p class="empty">Connect to your signer first: the file names its identity and relays.</p>
      {:else if relays.length === 0}
        <p class="empty">This signer has no known relays. Discovery needs the WiFi relay list,
          set in Device &gt; Network.</p>
      {:else}
        {#if device.masters.length > 1}
          <label class="field">
            <span class="field-label">Identity</span>
            <select class="field-input" bind:value={masterIdx}>
              {#each device.masters as master, i (master.slot)}
                <option value={i}>{master.label || `Slot ${master.slot}`}</option>
              {/each}
            </select>
          </label>
        {/if}

        <div class="pair">
          <label class="field">
            <span class="field-label">Name</span>
            <input class="field-input" type="text" bind:value={name} placeholder="you" spellcheck="false" />
          </label>
          <label class="field">
            <span class="field-label">Your domain</span>
            <input class="field-input" type="text" bind:value={domain} placeholder="yourdomain.com" spellcheck="false" />
          </label>
        </div>
        {#if !nameOk}
          <p class="error-text">Names may only use letters, digits, dash, underscore and dot.</p>
        {/if}

        {#if snippet}
          {#if identifier}
            <p class="hint">Apps with discovery will accept <code class="ident">{identifier}</code> at login.</p>
          {/if}
          <pre class="snippet"><code>{snippet}</code></pre>
          <button class="btn btn-secondary btn-sm" onclick={copySnippet}>
            {copied ? 'Copied' : 'Copy nostr.json'}
          </button>
          <div class="hosting">
            <p class="hint-sm">Host it at <code>https://{domain || 'yourdomain.com'}/.well-known/nostr.json</code>.
              The response must send <code>Access-Control-Allow-Origin: *</code>, browsers fetch it
              cross-origin. If a nostr.json already exists there for profile verification, merge the
              <code>names</code> and <code>nip46</code> entries into it instead of replacing it.</p>
            <p class="hint-sm">Apps that connect this way carry no connection secret. The signer treats
              them as strangers: each signature asks for the button on the device until you approve
              them as a connected app.</p>
          </div>
        {/if}
      {/if}
    </div>
  </details>
</section>

<style>
  .nip05-body { display: flex; flex-direction: column; gap: 0.75rem; padding-top: 0.5rem; }
  .pair { display: flex; gap: 0.75rem; flex-wrap: wrap; }
  .pair .field { flex: 1 1 180px; }
  .snippet {
    background: #0a0a0a; border: 1px solid var(--border); border-radius: 4px;
    padding: 0.6rem 0.8rem; margin: 0; overflow-x: auto;
    font-size: 0.78rem; line-height: 1.5; color: var(--text-dim);
  }
  .ident { color: var(--green); }
  .hosting { display: flex; flex-direction: column; gap: 0.4rem; }
</style>
