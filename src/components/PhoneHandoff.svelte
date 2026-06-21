<script lang="ts">
  // "Manage from your phone": once a device is set up and connected, this shows a
  // QR encoding everything the phone needs — operator key + device address +
  // relays. Scanning it opens the console there, already connected. No npub, no
  // typing. See lib/import-link (the phone side consumes the same link).
  import { encodeQR } from '@paulmillr/qr'
  import { device } from '../lib/device.svelte.js'
  import { getOrCreateOperator } from '../lib/op-mgmt.js'
  import { buildHandoffLink } from '../lib/import-link.svelte.js'
  import { listKnownDevices } from '../lib/known-devices.js'
  import { nip19 } from 'nostr-tools'

  let copied = $state(false)

  /** Device master pubkey as x-only hex, from the connected device's npub. */
  function deviceHex(): string {
    const npub = device.masters[0]?.npub ?? ''
    if (/^[0-9a-f]{64}$/i.test(npub)) return npub.toLowerCase()
    try {
      const d = nip19.decode(npub)
      if (d.type === 'npub') return d.data as string
    } catch { /* not an npub */ }
    return ''
  }

  /** Relays this device listens on: from the remembered device, else last flash. */
  function relaysFor(hex: string): string[] {
    const known = listKnownDevices().find((d) => d.pubHex === hex)
    if (known?.relays.length) return known.relays
    try {
      const saved = JSON.parse(localStorage.getItem('heartwood.lastRelays') ?? '[]')
      if (Array.isArray(saved) && saved.length) return saved
    } catch { /* none */ }
    return []
  }

  const hex = $derived(deviceHex())
  const relays = $derived(hex ? relaysFor(hex) : [])
  const ready = $derived(!!hex && relays.length > 0)
  const link = $derived(ready ? buildHandoffLink(location.origin, getOrCreateOperator().skHex, hex, relays) : '')
  const qr = $derived(link ? encodeQR(link, 'svg') : '')

  async function copyLink() {
    if (!link) return
    await navigator.clipboard.writeText(link)
    copied = true
    setTimeout(() => (copied = false), 1500)
  }
</script>

{#if ready}
  <section class="handoff">
    <p class="title">⚲ Manage from your phone</p>
    <p class="desc">
      Scan this with your phone's camera. It opens the console there, already connected to this
      signer — nothing to type.
    </p>
    <div class="qr">{@html qr}</div>
    <button class="btn" onclick={copyLink}>{copied ? 'Link copied ✓' : 'Copy link instead'}</button>
    <p class="warn">
      This link carries your operator key. Treat it like a password — anyone who scans it can manage
      this device. It is not the device's secret seed.
    </p>
  </section>
{/if}

<style>
  .handoff {
    margin-top: 1.5rem;
    border: 1px solid var(--green-dim);
    border-radius: 6px;
    padding: 1.25rem;
    background: #06120e;
  }
  .title { font-size: 0.95rem; color: var(--green); font-weight: 600; margin: 0 0 0.4rem; }
  .desc { font-size: 0.85rem; color: #9a9; margin: 0 0 1rem; line-height: 1.5; }
  .qr { width: 184px; padding: 12px; background: #fff; border-radius: 6px; margin-bottom: 0.9rem; }
  .qr :global(svg) { display: block; width: 100%; height: auto; }
  .btn {
    background: var(--surface-raised); border: 1px solid var(--border-bright); color: var(--text);
    padding: 0.45rem 1rem; border-radius: 4px; font-family: inherit; font-size: 0.82rem; cursor: pointer;
  }
  .btn:hover { background: var(--surface-hover); }
  .warn { font-size: 0.72rem; color: var(--amber); margin: 0.9rem 0 0; line-height: 1.5; }
</style>
