<script lang="ts">
  import { onMount } from 'svelte'
  import { encodeQR } from '@paulmillr/qr'
  import { device, mgmtClientUri } from '../lib/device.svelte.js'
  import { copyText } from '../lib/clipboard.js'
  import { bunkerHasRelay } from '../lib/bunker.js'
  import type { ConnectSlot } from '../lib/types.js'

  let { slot, onclose }: { slot: ConnectSlot; onclose: () => void } = $props()
  const generation = device.connectionGeneration
  const identity = device.selectedSlot
  let uri = $state('')
  let error = $state('')
  let copied = $state(false)
  const qr = $derived(uri ? encodeQR(uri, 'svg') : '')

  $effect(() => {
    if (!device.connected || device.connectionGeneration !== generation || device.selectedSlot !== identity) onclose()
  })

  onMount(() => {
    let active = true
    void mgmtClientUri(slot.slot_index, slot.secret_fingerprint).then(value => {
      if (!active || !device.connected || device.connectionGeneration !== generation || device.selectedSlot !== identity) return
      if (!bunkerHasRelay(value)) {
        error = 'This pairing link has no relay. Check Advanced → Device → Network, then reopen these instructions.'
      } else uri = value
    }).catch(e => {
      if (active) error = e instanceof Error ? e.message : 'Could not get the pairing link. Reconnect Sapwood and try again.'
    })
    return () => { active = false }
  })

  async function copy() {
    copied = await copyText(uri)
    if (!copied) error = 'Could not copy the link. Scan the QR code instead.'
  }
</script>

<section class="reconnect" aria-label={`Reconnect ${slot.label || 'app'}`}>
  <h4>Reconnect {slot.label || 'app'}</h4>
  <p>After reinstalling an app or moving to another device, its connection key can change.
    Heartwood may still show the old device as automatic while refusing the new one.</p>
  <ol>
    <li>In the app, scan this QR code or paste the pairing link to reconnect to the same identity.</li>
    <li>If Heartwood shows <strong>rebind '{slot.label || 'app'}'</strong>, hold its button to approve the new device.
      Stay beside Heartwood while pairing: automatic signing does not skip this approval.</li>
    <li>Return to the app and retry the action that failed. Signing in alone does not prove it can decrypt.</li>
  </ol>
  <p>This reuses the existing connection and its permissions. You do not need to disconnect it first.</p>
  {#if error}<p role="alert">{error}</p>{/if}
  {#if uri}
    <div class="qr" role="img" aria-label="Pairing QR code">{@html qr}</div>
    <button class="btn btn-secondary btn-sm" onclick={copy}>{copied ? 'Pairing link copied' : 'Copy pairing link'}</button>
    <p class="hint">Keep this link private: it contains the connection's pairing secret.</p>
  {:else if !error}
    <p role="status">Getting the existing pairing link…</p>
  {/if}
  <button class="btn btn-secondary btn-sm" onclick={onclose}>Close reconnect instructions</button>
</section>

<style>
  .reconnect { margin-top: 1rem; padding-top: 1rem; border-top: 1px solid var(--border); }
  h4 { margin: 0 0 0.75rem; }
  p, li { line-height: 1.55; }
  ol { padding-left: 1.4rem; }
  li + li { margin-top: 0.5rem; }
  .qr { width: 196px; max-width: 100%; box-sizing: border-box; padding: 12px; background: white; border-radius: 6px; margin: 1rem 0; }
  .qr :global(svg) { display: block; width: 100%; height: auto; }
  .hint { font-size: 0.85rem; }
</style>
